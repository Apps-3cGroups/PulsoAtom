import { readFile, readdir, lstat, realpath, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = '/var/www/nodeapps/PulsoAtom';
const API = `${ROOT}/api`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
const BACKUP_ID = '0426e95a-da13-4825-87ef-e8fc2025017c';
const BACKUP_INDEX = 'ff72c7f916564bc1c3ba122bd3413bdecedaa309f956398410f8873dbf95c299';
const INSTALLED_INDEX = '7f30cda99c486651bfdc3d56b627e1f0a0823e2e37f8b7ae7e13b00f3ccd8280';
const VALID_ID = /^deployment:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function validateRequest({ id, revision, owner }) {
  if (!VALID_ID.test(id || '') || !/^[a-f0-9]{40}$/.test(revision || '') || !/^github:[1-9][0-9]*:[1-9][0-9]*$/.test(owner || '')) fail('INVALID_DEPLOYMENT_LEASE');
}
async function ordinary(filename, directory = false) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(filename) !== filename) fail('UNSAFE_DEPLOYMENT_PATH');
}
export async function assertSafeWorkingTree(root = ROOT, runGit = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })) {
  // The only historical exception is the exact backup made by the authorized
  // static publication. Preserve it; do not broadly exclude unknown files.
  const entries = runGit(['status', '--porcelain=v1', '--untracked-files=all', '-z']).split('\0').filter(Boolean);
  if (!entries.length) return { clean: true, preservedStaticBackup: false };
  const prefix = `web/.static-backups/${BACKUP_ID}`;
  const allowed = new Set([`?? ${prefix}/index.html`, `?? ${prefix}/artifact.json`]);
  if (entries.some(entry => !allowed.has(entry))) fail('DEPLOYMENT_WORKTREE_CHANGED');
  for (const dir of [root, `${root}/web`, `${root}/web/.static-backups`, `${root}/${prefix}`]) await ordinary(dir, true);
  const files = (await readdir(`${root}/${prefix}`)).sort();
  if (JSON.stringify(files) !== JSON.stringify(['artifact.json', 'index.html'])) fail('UNEXPECTED_STATIC_BACKUP');
  for (const file of files) await ordinary(`${root}/${prefix}/${file}`);
  const index = await readFile(`${root}/${prefix}/index.html`);
  const manifest = JSON.parse(await readFile(`${root}/${prefix}/artifact.json`, 'utf8'));
  if (hash(index) !== BACKUP_INDEX || manifest.format !== 'pulso-web-static-v1' || manifest.basePath !== '/pulsoAtom'
      || manifest.expectedIndexSha256 !== BACKUP_INDEX || !Array.isArray(manifest.files)
      || manifest.files.filter(file => file.path === 'index.html' && file.sha256 === INSTALLED_INDEX).length !== 1) fail('UNEXPECTED_STATIC_BACKUP');
  return { clean: true, preservedStaticBackup: true };
}
export function isEvaluationWorker(argv, cwd = '') {
  const belongs = cwd === API || cwd.startsWith(`${API}/`) || argv.some(arg => arg.startsWith(`${API}/`));
  if (!belongs) return false;
  const script = argv.find(arg => /(?:^|\/)(?:complete-tuesday-wednesday|recover-tuesday-evaluations|start-next-local-batch|evaluate-all|start-gemma-renewal|extend-gemma-renewal)\.js$/.test(arg));
  return !!script && argv.some(arg => ['--worker', '--start', '--continue', '--execute', '--resume-tuesday', '--extend'].includes(arg));
}
export async function inspectWorkers({ proc = '/proc', uid = process.getuid?.(), ownPid = process.pid } = {}) {
  if (!Number.isInteger(uid)) fail('DEPLOYMENT_PROCESS_CHECK_UNAVAILABLE');
  let count = 0;
  for (const pid of await readdir(proc)) {
    if (!/^[1-9][0-9]*$/.test(pid) || Number(pid) === ownPid) continue;
    try {
      const info = await lstat(`${proc}/${pid}`);
      if (info.uid !== uid) continue;
      const stat = await readFile(`${proc}/${pid}/stat`, 'utf8');
      if (/\) Z /.test(stat)) continue;
      const argv = (await readFile(`${proc}/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const cwd = await readlink(`${proc}/${pid}/cwd`);
      if (isEvaluationWorker(argv, cwd)) count++;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) fail('DEPLOYMENT_PROCESS_CHECK_UNAVAILABLE');
    }
  }
  return count;
}
export async function verifyLocalHealth(fetcher = fetch) {
  for (const url of ['http://127.0.0.1:4001/pulsoAtom/api/health', 'http://127.0.0.1:3000/pulsoAtom/']) {
    let response;
    try { response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { fail('DEPLOYMENT_HEALTH_FAILED'); }
    if (!response.ok) fail('DEPLOYMENT_HEALTH_FAILED');
    await response.arrayBuffer();
  }
}
export async function changeDeploymentLease(pool, request, { workers = inspectWorkers, health = verifyLocalHealth, now = () => new Date().toISOString() } = {}) {
  validateRequest(request);
  if (!['claim', 'release'].includes(request.operation)) fail('INVALID_DEPLOYMENT_OPERATION');
  if (request.operation === 'release') await health();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // This is the exact lock used by MysqlStore, the scheduler and detached workers.
    const [lock] = await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    if (lock.length !== 1) fail('DEPLOYMENT_LOCK_MISSING');
    const [rows] = await connection.execute("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (rows.length !== 1) fail('DEPLOYMENT_SETTINGS_MISSING');
    const settings = decode(rows[0].payload);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('DEPLOYMENT_SETTINGS_INVALID');
    const active = settings.deploymentLease;
    if (request.operation === 'claim') {
      if (settings.evaluationMaintenance != null || active?.status === 'active') fail('DEPLOYMENT_OTHER_MAINTENANCE');
    } else if (settings.evaluationMaintenance !== request.id || active?.id !== request.id || active.status !== 'active'
        || active.owner !== request.owner || active.revision !== request.revision || active.priorMaintenance !== null) fail('DEPLOYMENT_LEASE_CHANGED');
    const running = {};
    for (const table of ['evaluation_jobs', 'evaluation_tasks', 'evaluation_attempts']) {
      // Read only status, never transcripts or model output; no evaluation rows are written.
      const statuses = table === 'evaluation_jobs' ? "('running', 'pending', 'queued')" : "('running')";
      const [counts] = await connection.query(`SELECT COUNT(*) AS running FROM ${table} WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) IN ${statuses}`);
      running[table] = Number(counts[0]?.running);
      if (!Number.isSafeInteger(running[table]) || running[table] < 0) fail('DEPLOYMENT_STATUS_INVALID');
    }
    if (await workers()) fail('DEPLOYMENT_WORKER_RUNNING');
    if (Object.values(running).some(Boolean)) fail('DEPLOYMENT_EVALUATION_RUNNING');
    if (request.operation === 'claim') {
      settings.evaluationMaintenance = request.id;
      settings.deploymentLease = { id: request.id, owner: request.owner, revision: request.revision,
        status: 'active', priorMaintenance: null, acquiredAt: now() };
    } else {
      settings.evaluationMaintenance = null;
      settings.deploymentLease = { ...active, status: 'released', releasedAt: now() };
    }
    await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(settings)]);
    await connection.commit();
    return { operation: request.operation, leaseId: request.id, revision: request.revision, status: settings.deploymentLease.status, evaluationsChanged: false };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
export async function waitForDeploymentLease(pool, request, { waitSeconds = 0, intervalMs = 30000,
  clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report = () => {}, ...dependencies } = {}) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 2700
      || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 30000) fail('INVALID_DEPLOYMENT_WAIT');
  const deadline = clock() + waitSeconds * 1000;
  for (;;) {
    try { return await changeDeploymentLease(pool, request, dependencies); }
    catch (error) {
      if (request.operation !== 'claim' || error.code !== 'DEPLOYMENT_EVALUATION_RUNNING' || clock() >= deadline) throw error;
      report({ waiting: 'evaluation_idle', leaseAcquired: false });
      // The transaction has rolled back and released app_lock before this wait.
      await sleep(Math.min(intervalMs, deadline - clock()));
    }
  }
}
async function main(args) {
  if (args.length === 1 && args[0] === '--check-working-tree') return assertSafeWorkingTree();
  if (![7, 9].includes(args.length) || !['--claim', '--release'].includes(args[0]) || args[1] !== '--id' || args[3] !== '--revision' || args[5] !== '--owner'
      || args.length === 9 && (args[0] !== '--claim' || args[7] !== '--wait-idle-seconds' || !/^(?:0|[1-9][0-9]{0,3})$/.test(args[8]) || Number(args[8]) > 2700)) fail('INVALID_DEPLOYMENT_ARGUMENTS');
  const request = { operation: args[0].slice(2), id: args[2], revision: args[4], owner: args[6] };
  validateRequest(request);
  if (request.operation === 'release' && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() !== request.revision) fail('DEPLOYMENT_REVISION_CHANGED');
  if (!process.env.APP_DB_HOST || !process.env.APP_DB_USER || !process.env.APP_DB_NAME || process.env.DEMO_MODE === 'true') fail('DEPLOYMENT_DATABASE_REQUIRED');
  // Resolve only the existing deployment's mysql dependency; no npm/install or runtime imports.
  const mysql = createRequire(`${API}/package.json`)('mysql2/promise');
  const pool = mysql.createPool({ host: process.env.APP_DB_HOST, port: Number(process.env.APP_DB_PORT || 3306),
    user: process.env.APP_DB_USER, password: process.env.APP_DB_PASSWORD || '', database: process.env.APP_DB_NAME,
    charset: 'utf8mb4', timezone: 'Z', connectionLimit: 1, connectTimeout: 5000, compress: true,
    ...(process.env.APP_DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) });
  try { return await waitForDeploymentLease(pool, request, { waitSeconds: args.length === 9 ? Number(args[8]) : 0, report: value => console.log(JSON.stringify(value)) }); } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'DEPLOYMENT_LEASE_FAILED' })); process.exitCode = 1; });

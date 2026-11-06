import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { apiRoot, config, databaseConfig, atomDatabaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { preflightLocalModels, createLocalPilotPlan, executeLocalPilot } from '../src/local-model-pilot.js';
import { AppError } from '../src/errors.js';

const args = process.argv.slice(2);
const modes = args.filter(a => ['--plan', '--apply', '--resume'].includes(a));
const mode = modes[0] || '--plan';
const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
if (modes.length > 1 || args.some((a, i) => !['--plan', '--apply', '--resume', '--manifest', '--maintenance-id'].includes(a)
  && !['--manifest', '--maintenance-id'].includes(args[i - 1]))) throw new Error('Argumentos inválidos para el piloto local.');
const directory = path.join(apiRoot, '.data', 'local-pilots');
const explicitFile = option('--manifest');
let filename = explicitFile ? path.resolve(explicitFile) : null;
let store;
const save = async manifest => {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
};
try {
  if (config.demo || !databaseConfig() || !atomDatabaseConfig()) throw new Error('REAL_MODE_REQUIRED');
  if (mode !== '--plan' && (!filename || !option('--maintenance-id'))) throw new Error('MANIFEST_AND_MAINTENANCE_ID_REQUIRED');
  const registry = registryFromEnv();
  store = new AtomHistoryStore(new MysqlStore(databaseConfig()), new AtomReader(atomDatabaseConfig(), config.timezone));
  // Read the saved model settings first. Credentials stay in the backend, and
  // preflight sends only its synthetic probe before loading Atom transcripts.
  const settingsState = await store.read();
  const preflight = await preflightLocalModels(registry, settingsState);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (mode === '--plan') {
    if (filename) throw new Error('PLAN_CREATES_NEW_MANIFEST');
    const manifest = createLocalPilotPlan(await store.readWithConversations({ fresh: true }), registry, preflight, { maintenanceId: option('--maintenance-id') });
    filename = path.join(directory, `${manifest.id}.json`);
    await writeFile(filename, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ planned: true, manifest: filename, conversationIds: manifest.conversations.map(c => c.id),
      profiles: manifest.profiles.map(p => ({ id: p.id, label: p.label, model: p.model })), reviews: 10,
      databaseChanged: false, next: manifest.maintenanceId
        ? 'El reinicio ya existe. Ejecutar --apply con este nuevo manifiesto y el mismo maintenanceId, sin limpiar otra vez.'
        : 'Crear y verificar respaldo, reiniciar evaluaciones y ejecutar --apply con este manifiesto y el maintenanceId generado.' }, null, 2));
  } else {
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    manifest.lastPreflight = preflight;
    const summary = await executeLocalPilot(store, registry, manifest, { maintenanceId: option('--maintenance-id'), resume: mode === '--resume',
      onJob: async job => { manifest.jobId = job.id; manifest.maintenanceId = option('--maintenance-id'); manifest.status = 'running'; await save(manifest); console.log(JSON.stringify({ started: true, jobId: job.id, cases: 5, reviews: 10 })); } });
    manifest.status = summary.status; manifest.summary = summary; manifest.updatedAt = new Date().toISOString(); await save(manifest);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.maintenanceReleased) process.exitCode = 2;
  }
} catch (error) {
  // Never log raw connection/provider errors or environment values.
  console.error(JSON.stringify({ error: error.code || 'LOCAL_PILOT_FAILED', message: error instanceof AppError ? error.message : 'No se pudo completar el piloto local. Se conserva el estado para revisión.' }));
  process.exitCode = 1;
} finally { await store?.close(); }

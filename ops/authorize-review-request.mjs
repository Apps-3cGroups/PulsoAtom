import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { config, databaseConfig } from '../api/src/config.js';
import { AppError } from '../api/src/errors.js';
import { validateFreshReviewManifest } from '../api/src/fresh-review-run.js';

export const AUTHORIZED_REVIEW = Object.freeze({
  id: 'fresh-review214-20261125', caseCount: 214, expectedNewEvaluations: 428,
  selectionHash: '2eb5607a187692b34348666ff5d0b875c72c9e7286c9b3e8e667e11092b25e4c',
  scope: { from: '2026-11-17', to: '2026-11-19', timezone: 'America/Tegucigalpa' },
  counts: { HN: 50, PA: 50, CR: 5, SV: 50, MX: 50, NI: 9 },
});
const fail = code => { throw new AppError(409, 'La autorización no coincide con la revisión exacta solicitada.', code); };
const decode = payload => typeof payload === 'string' ? JSON.parse(payload) : payload;

export function assertKnownReviewRequest(manifest) {
  validateFreshReviewManifest(manifest);
  const expected = AUTHORIZED_REVIEW;
  if (manifest.id !== expected.id || manifest.caseCount !== expected.caseCount || manifest.expectedNewEvaluations !== expected.expectedNewEvaluations
    || manifest.selectionHash !== expected.selectionHash
    || Object.keys(expected.scope).some(key => manifest.scope[key] !== expected.scope[key])
    || Object.keys(expected.counts).some(key => manifest.counts[key] !== expected.counts[key])
    || Object.keys(manifest.counts).some(key => !(key in expected.counts))
    || !((manifest.authorizedForExecution === false && manifest.preparatoryOnly === true)
      || (manifest.authorizedForExecution === true && manifest.preparatoryOnly === false))) fail('REVIEW_AUTHORIZATION_MISMATCH');
  return manifest;
}

// The only persisted change is the two authorization booleans in one known row.
// A repeated authorization is harmless while no execution has been created.
export async function authorizeReviewRequest(connection, { validate = assertKnownReviewRequest } = {}) {
  const rowId = `reviewRequest:${AUTHORIZED_REVIEW.id}`;
  await connection.beginTransaction();
  try {
    const [rows] = await connection.execute('SELECT payload FROM portal_settings WHERE id = ? FOR UPDATE', [rowId]);
    if (rows.length !== 1) fail('REVIEW_REQUEST_NOT_FOUND');
    const manifest = validate(decode(rows[0].payload));
    const [jobs] = await connection.execute("SELECT id FROM evaluation_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.idempotencyKey')) LIKE ? LIMIT 1",
      [`fresh-review:${AUTHORIZED_REVIEW.id}:%`]);
    if (jobs.length) fail('REVIEW_EXECUTION_ALREADY_EXISTS');
    const changed = manifest.authorizedForExecution !== true;
    if (changed) {
      const [result] = await connection.execute("UPDATE portal_settings SET payload = JSON_SET(payload, '$.authorizedForExecution', CAST('true' AS JSON), '$.preparatoryOnly', CAST('false' AS JSON)) WHERE id = ?", [rowId]);
      if (result.affectedRows !== 1) fail('REVIEW_REQUEST_NOT_FOUND');
    }
    await connection.commit();
    return { requestId: AUTHORIZED_REVIEW.id, cases: AUTHORIZED_REVIEW.caseCount, expectedReviews: AUTHORIZED_REVIEW.expectedNewEvaluations,
      selectionHash: AUTHORIZED_REVIEW.selectionHash, authorizedForExecution: true, preparatoryOnly: false, changed };
  } catch (error) { await connection.rollback(); throw error; }
}

export function parseAuthorizationArguments(args) {
  if (args.length !== 2 || args[0] !== '--request-id' || args[1] !== AUTHORIZED_REVIEW.id) fail('INVALID_ARGUMENTS');
  return { requestId: args[1] };
}
export async function main(args = process.argv.slice(2)) {
  parseAuthorizationArguments(args);
  if (config.demo || !databaseConfig()) fail('REAL_MODE_REQUIRED');
  const require = createRequire(new URL('../api/package.json', import.meta.url)), mysql = require('mysql2/promise');
  let connection;
  const timer = setTimeout(() => connection?.destroy(), 30000);
  try {
    connection = await mysql.createConnection(databaseConfig());
    const result = await authorizeReviewRequest(connection);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'request_authorized', ...result }));
  } finally { clearTimeout(timer); await connection?.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ event: 'authorization_failed', code: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'REVIEW_AUTHORIZATION_FAILED' }));
  process.exitCode = 1;
});

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const diagnosticId = 'clefTwoFlags6135';
export const expectedRequestHash = '8d7c7cf035d4e4847f73d5a07e685fe2156d8c00ac1e928602398aeb030cc4a1';
const filename = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics/clef-flash-6135-two-flags-response-20261107.json';
const variableIds = ['cliente_molesto', 'asistente_falto_al_respeto'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('PRIVATE_CAPTURE_IMPORT_FAILED'); };
const keysMatch = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Only the two structured diagnostic results are imported. The envelope,
// transport headers, source conversation and credentials are never persisted.
export function projectClefTwoFlags(capture) {
  const envelope = capture?.envelope;
  if (capture?.format !== 1 || capture.httpStatus !== 200 || capture.requestHash !== expectedRequestHash
    || envelope?.ok !== true || envelope.upstream_status_code !== 200 || envelope.response?.model !== 'clef-flash'
    || !Array.isArray(envelope.response.choices) || envelope.response.choices.length !== 1
    || typeof capture.capturedAt !== 'string' || !Number.isFinite(Date.parse(capture.capturedAt))) fail();
  const choice = envelope.response.choices[0], message = choice?.message;
  if (choice?.finish_reason !== 'stop' || !object(message) || message.refusal
    || message.function_call || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length))) fail();
  const sourceField = typeof message.content === 'string' && message.content.trim() ? 'content' : 'reasoning_content';
  if (typeof message[sourceField] !== 'string') fail();
  let parsed;
  try { parsed = JSON.parse(message[sourceField]); } catch { fail(); }
  if (!keysMatch(parsed, ['results']) || !keysMatch(parsed.results, variableIds)) fail();
  const results = Object.fromEntries(variableIds.map(variableId => {
    const item = parsed.results[variableId];
    if (!keysMatch(item, ['status', 'value', 'reason', 'evidence_message_ids']) || item.status !== 'no_evaluado'
      || item.value !== null || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 160
      || !Array.isArray(item.evidence_message_ids) || item.evidence_message_ids.length !== 0) fail();
    return [variableId, { status: item.status, value: null, reason: item.reason, evidence_message_ids: [] }];
  }));
  return { model: 'clef-flash', conversationId: '6135', sourceField, capturedAt: capture.capturedAt,
    requestHash: capture.requestHash, results };
}

export async function importClefTwoFlags(connection, capture) {
  const projected = projectClefTwoFlags(capture);
  await connection.beginTransaction();
  try {
    const [locks] = await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    if (locks.length !== 1 || Number(locks[0].id) !== 1) fail();
    const [rows] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
    if (rows.length !== 1) fail();
    const settings = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    if (!object(settings) || (settings.modelDiagnostics !== undefined && !object(settings.modelDiagnostics))) fail();
    const diagnostics = settings.modelDiagnostics || {};
    const existing = diagnostics[diagnosticId];
    if (Object.hasOwn(diagnostics, diagnosticId)) {
      if (!isDeepStrictEqual(existing, projected)) fail();
      await connection.commit();
      return { success: true, id: diagnosticId, imported: false, count: 2 };
    }
    const next = { ...settings, modelDiagnostics: { ...diagnostics, [diagnosticId]: projected } };
    const [written] = await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(next)]);
    if (written.affectedRows !== 1) fail();
    await connection.commit();
    return { success: true, id: diagnosticId, imported: true, count: 2 };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection;
  try {
    if (process.argv.length !== 2) fail();
    const capture = JSON.parse(await readFile(filename, 'utf8'));
    projectClefTwoFlags(capture);
    const { config, databaseConfig } = await import('../src/config.js');
    const database = databaseConfig();
    if (config.demo || database?.database !== 'dbPulsosAtom') fail();
    const { default: mysql } = await import('mysql2/promise');
    const { connectionLimit, ...options } = database;
    connection = await mysql.createConnection(options);
    console.log(JSON.stringify(await importClefTwoFlags(connection, capture)));
  } catch {
    console.error(JSON.stringify({ success: false, error: 'PRIVATE_CAPTURE_IMPORT_FAILED' }));
    process.exitCode = 1;
  } finally { await connection?.end().catch(() => {}); }
}

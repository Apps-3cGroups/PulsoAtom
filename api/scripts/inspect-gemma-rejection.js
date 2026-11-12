import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { databaseConfig, atomDatabaseConfig, config } from '../src/config.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { readGemmaContractState } from './check-gemma-contract.js';
import { supportsAiVariable } from '../src/evaluator.js';
const allowed = new Set('the a an is are was were to of for with in on from and or than when but this that not does can cannot failed failure error invalid input output prompt context length window tokens token max_tokens n_keep n_ctx model schema json grammar format request response maximum minimum exceeded exceeds limit too large small long short load loaded memory available prediction predicting generate generation decoding keep truncation truncate'.split(' '));
function classify(value, depth = 0) {
  if (depth > 4) return null;
  if (typeof value === 'string') return { bytes: Buffer.byteLength(value), hash: createHash('sha256').update(value).digest('hex'),
    pattern: value.slice(0, 2000).toLowerCase().split(/\s+/).map(w => /^\d{1,5}$/.test(w) ? w : allowed.has(w.replace(/[^a-z_]/g, '')) ? w.replace(/[^a-z_]/g, '') : '[redacted]').join(' ') };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(['message', 'error', 'detail', 'code'].filter(k => Object.hasOwn(value, k)).map(k => [k, classify(value[k], depth + 1)]));
}
let connection, reader;
try {
  if (config.demo) throw new Error('REAL_MODE_REQUIRED');
  connection = await mysql.createConnection(databaseConfig());
  const state = await readGemmaContractState(connection);
  await connection.query('START TRANSACTION READ ONLY');
  const [rows] = await connection.query("SELECT payload FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.conversationId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.profile.id'))='gemma-local'", ['340c1fcb-dc19-42a2-91af-e494eb52d753', '9184']);
  await connection.commit();
  if (rows.length !== 1) throw new Error('TASK_NOT_FOUND');
  const task = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  reader = new AtomReader(atomDatabaseConfig(), config.timezone);
  const { conversations } = await reader.read({ fresh: true, conversationIds: ['9184'] });
  const diagnostics = [];
  const fetchImpl = async (...args) => {
    const response = await fetch(...args);
    let body; try { body = await response.clone().json(); } catch { body = null; }
    if (!response.ok || body?.upstream_status_code >= 400) diagnostics.push({ httpStatus: response.status,
      upstreamStatus: body?.upstream_status_code || null, outer: classify(body), upstream: classify(body?.response) });
    return response;
  };
  const profile = registryFromEnv({ fetchImpl }).forState(state).resolve('gemma-local');
  const retained = new Set((task.profileStates?.['gemma-local']?.results || []).map(r => r.variableId));
  const variables = state.catalog.filter(v => v.active && !v.retired && supportsAiVariable(v) && !retained.has(v.id));
  let result, failure;
  try { result = await profile.evaluator.evaluate(conversations[0], variables, { validationErrors: task.profileStates?.['gemma-local']?.validationErrors || [] }); }
  catch (e) { failure = /^[A-Z_]+$/.test(e.code || '') ? e.code : 'DIAGNOSTIC_FAILED'; }
  console.log(JSON.stringify({ conversationId: '9184', requested: variables.length, valid: result?.results?.length || 0, failure, diagnostics }));
} catch { console.error(JSON.stringify({ failure: 'DIAGNOSTIC_FAILED' })); process.exitCode = 1; }
finally { await connection?.end(); await reader?.close(); }

import { readFile, writeFile } from 'node:fs/promises';
import { config, databaseConfig, atomDatabaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { sourceFingerprint, evaluationContext } from '../src/evaluation-context.js';
import { supportsAiVariable } from '../src/evaluator.js';
import { restoreClefCohortCatalog, ORIGINAL_GEMMA_MANIFEST, ORIGINAL_GEMMA_MAINTENANCE_ID } from './inspect-clef-cohort.js';
const directory = `/var/www/nodeapps/PulsoAtom/api/.data/clef-cohort-${ORIGINAL_GEMMA_MAINTENANCE_ID}`;
const cohortId = `clef-complement-${ORIGINAL_GEMMA_MAINTENANCE_ID}`;
const httpStatus = message => Number(/^El Gateway rechazó la solicitud al modelo local \(HTTP (\d{3})\)\.$/.exec(message || '')?.[1]) || null;
const safeCode = value => ['AI_CONFIGURATION','AI_UNAVAILABLE','AI_TRANSIENT','INVALID_AI_RESULT','AI_INCOMPLETE','AI_SAFETY_REFUSAL','MODEL_CHANGED','MODEL_IDENTITY_UNVERIFIED','AI_CONTEXT_LIMIT'].includes(value) ? value : 'OTHER_ERROR';
const patterns = {
  context_limit: /context.{0,40}(?:length|window|limit|exceed)|(?:token|prompt).{0,40}(?:exceed|too long)|maximum context/i,
  invalid_schema: /(?:schema|grammar).{0,70}(?:invalid|error|fail|unsupported)|(?:invalid|fail|unsupported).{0,50}(?:schema|grammar)/i,
  invalid_max_tokens: /max[_ ](?:tokens|completion_tokens).{0,70}(?:invalid|exceed|too|unsupported)|(?:invalid|exceed).{0,40}max[_ ]tokens/i,
  unavailable_model: /model.{0,60}(?:not found|not loaded|unavailable|does not exist)/i,
  unauthorized: /unauthoriz|forbidden|invalid.{0,20}(?:token|api key)|authentication/i,
  unsupported_format: /(?:response_format|json_schema).{0,60}(?:unsupported|not supported)/i,
  resource_exhausted: /out of memory|insufficient memory|resource exhausted/i,
  invalid_request: /bad request|invalid request|validation error/i,
};
let store;
try {
  const mode = process.argv[2];
  if (!['--inspect','--probe'].includes(mode) || process.argv.length !== 3) throw new Error('INVALID_MODE');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) throw new Error('REAL_CONFIGURATION_REQUIRED');
  store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
  const state = await store.read();
  const original = JSON.parse(await readFile(ORIGINAL_GEMMA_MANIFEST, 'utf8'));
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  if (manifest.status !== 'blocked' || state.settings.dailyEnabled !== false) throw new Error('COHORT_NOT_BLOCKED');
  const jobIds = new Set(state.jobs.filter(job => job.cohortId === cohortId).map(job => job.id));
  const tasks = state.tasks.filter(task => jobIds.has(task.jobId) && task.profile.id === 'clef-local' && task.error);
  const diagnostic = { readOnlyDatabase: true, probe: mode === '--probe', cases: tasks.map(task => ({
    taskId: task.id, conversationId: task.conversationId, status: task.status, round: task.round,
    code: safeCode(task.error.code), httpStatus: httpStatus(task.error.message),
    retainedResults: task.profileStates?.['clef-local']?.results?.length || 0,
    attempts: state.attempts.filter(a => a.taskId === task.id).map(a => ({ status: a.status,
      code: a.error ? safeCode(a.error.code) : null, httpStatus: httpStatus(a.error?.message),
      requestedVariables: a.variableIds.length, validResults: a.validVariableIds?.length || 0, durationMs: a.durationMs }))
  })) };
  if (mode === '--probe') {
    if (tasks.length !== 1 || tasks[0].error.code !== 'AI_CONFIGURATION') throw new Error('PROBE_SCOPE_CHANGED');
    const task = tasks[0];
    const fresh = await store.readWithConversations({ fresh: true, conversationIds: [task.conversationId] });
    const conversation = fresh.conversations.find(c => c.id === task.conversationId);
    const catalog = restoreClefCohortCatalog(fresh, original);
    const context = evaluationContext(conversation, catalog);
    if (!conversation || sourceFingerprint(conversation) !== task.context.sourceHash
      || ['sourceHash','catalogHash','promptHash','rulesVersion'].some(key => context[key] !== task.context[key])) throw new Error('SOURCE_OR_CONTRACT_CHANGED');
    const retained = new Set((task.profileStates?.['clef-local']?.results || []).map(r => r.variableId));
    const pending = catalog.filter(v => v.active && supportsAiVariable(v) && !retained.has(v.id));
    const transport = [];
    const fetchImpl = async (...args) => {
      const response = await fetch(...args);
      const body = await response.clone().json().catch(() => null);
      const serialized = JSON.stringify(body);
      const upstream = body?.upstream_status_code;
      if (!response.ok || (Number.isInteger(upstream) && upstream >= 400)) {
        const filename = `${directory}/private-error-diagnostic-${Date.now()}.json`;
        await writeFile(filename, JSON.stringify({ at: new Date().toISOString(), responseStatus: response.status, body }), { mode: 0o600, flag: 'wx' });
        transport.push({ httpStatus: response.status, upstreamStatus: Number.isInteger(upstream) ? upstream : null,
          categories: Object.entries(patterns).filter(([,regex]) => regex.test(serialized)).map(([key]) => key), privateCaptureSaved: true });
      } else transport.push({ httpStatus: response.status, upstreamStatus: upstream || null });
      return response;
    };
    const registry = registryFromEnv({ fetchImpl }).forState(fresh);
    const profile = registry.resolve('clef-local', task.profile);
    diagnostic.probeDetails = { messages: conversation.messages.length, variables: pending.length, transport };
    try {
      const result = await profile.evaluator.evaluate(conversation, pending, {
        validationErrors: (task.profileStates?.['clef-local']?.validationErrors || []).map(({ variableId, rules }) => ({ variableId, rules })) });
      diagnostic.probeDetails.result = { success: true, validResults: result.results.length, invalidResults: result.validationErrors?.length || 0 };
    } catch (error) {
      diagnostic.probeDetails.result = { success: false, code: safeCode(error.code), httpStatus: httpStatus(error.message) };
    }
  }
  console.log(JSON.stringify(diagnostic, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, code: /^[A-Z_]{3,80}$/.test(error.message || '') ? error.message : 'DIAGNOSTIC_FAILED' }));
  process.exitCode = 1;
} finally { await store?.close(); }

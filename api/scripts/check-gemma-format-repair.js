import { readGemmaContractState } from './check-gemma-contract.js';
import { gemmaContractConversation } from '../src/gemma-contract-check.js';
import { databaseConfig, config } from '../src/config.js';
import { registryFromEnv } from '../src/model-registry.js';
import mysql from 'mysql2/promise';

let connection;
try {
  if (config.demo) throw new Error('REAL_MODE_REQUIRED');
  connection = await mysql.createConnection(databaseConfig());
  const state = await readGemmaContractState(connection);
  const profile = registryFromEnv().forState(state).resolve('gemma-local');
  const variables = state.catalog.filter(v => ['productos_solicitados', 'cliente_felicito_al_asistente'].includes(v.id));
  const answer = await profile.evaluator.evaluate(gemmaContractConversation, variables,
    { validationErrors: variables.map(v => ({ variableId: v.id, rules: ['inconsistent_status_value'] })) });
  const success = answer.formatRepair === 'status-value-evidence-1' && answer.results.length === 2 && !answer.validationErrors.length;
  console.log(JSON.stringify({ success, synthetic: true, requested: variables.length, valid: answer.results.length,
    repair: answer.formatRepair, responseId: answer.responseId, validationErrors: answer.validationErrors.map(e => ({ variableId: e.variableId, rules: e.rules })) }));
  process.exitCode = success ? 0 : 1;
} catch (e) { console.error(JSON.stringify({ success: false, errorCode: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PREFLIGHT_FAILED' })); process.exitCode = 1; }
finally { await connection?.end(); }

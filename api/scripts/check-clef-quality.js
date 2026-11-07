import { pathToFileURL } from 'node:url';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { supportsAiVariable } from '../src/evaluator.js';
import { readProbeState } from './check-clef-conversation.js';
import { qualityCases, fullChecklistCase, selectedVariableIds } from './fixtures/clef-quality-cases.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outputPath = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics/clef-flash-quality-20261107-v1.json';
const safeCodes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT',
  'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL', 'AI_INCOMPLETE']);

// Compare raw AI decisions, including their cited actor. No absent-event
// conversion, retry, alternate model or expected answer enters the request.
export function scoreQualityCase(fixture, output) {
  return selectedVariableIds.map(variableId => {
    const expected = fixture.expected[variableId];
    const stored = output.results.find(result => result.variableId === variableId);
    const actual = stored?.aiResult || stored;
    const ids = (actual?.evidence || []).map(item => item.messageId);
    const evidenceMatches = expected.value === 1
      ? expected.evidenceIds.some(id => ids.includes(id)) && ids.every(id => expected.evidenceIds.includes(id))
      : ids.length === 0;
    const contractValid = !!actual && !output.validationErrors.some(error => error.variableId === variableId);
    return { variableId, expectedStatus: expected.status, expectedValue: expected.value,
      actualStatus: contractValid ? actual.status : 'invalid', actualValue: contractValid ? actual.value : null,
      evidenceIds: ids.filter(id => fixture.messages.some(message => message.id === id)),
      pass: contractValid && actual.status === expected.status && actual.value === expected.value && evidenceMatches };
  });
}

export async function runQualityCases({ evaluator, variables, onCase = () => {} }) {
  const selected = selectedVariableIds.map(id => variables.find(variable => variable.id === id));
  if (selected.some(variable => !variable || variable.type !== 'Flag' || variable.method !== 'IA')) throw new Error('Invalid checklist');
  const results = [];
  const started = Date.now();
  for (const fixture of [...qualityCases, fullChecklistCase]) {
    if (Date.now() - started > 420000) break;
    const checklist = fixture === fullChecklistCase ? variables : selected;
    const conversation = { id: fixture.id, completed: true, messages: fixture.messages.map(message => ({ ...message })) };
    const began = Date.now();
    let output;
    try { output = await evaluator.evaluate(conversation, checklist); }
    catch (error) {
      const result = { caseId: fixture.id, requestedVariables: checklist.length,
        errorCode: safeCodes.has(error?.code) ? error.code : 'QUALITY_CASE_FAILED', durationMs: Date.now() - began };
      results.push(result); onCase(result); break;
    }
    const assessments = scoreQualityCase(fixture, output);
    const summary = { caseId: fixture.id, requestedVariables: checklist.length, validVariables: output.results.length,
      validationErrorCount: output.validationErrors.length, responseField: output.responseField,
      decisionInstructionsVersion: output.decisionInstructionsVersion,
      durationMs: Date.now() - began, assessments,
      pass: output.validationErrors.length === 0 && output.results.length === checklist.length && assessments.every(item => item.pass) };
    results.push({ ...summary, output });
    onCase(summary);
  }
  return { synthetic: true, model: 'clef-flash', expectedCases: 7, completedCases: results.filter(r => r.assessments).length,
    passedDecisions: results.flatMap(r => r.assessments || []).filter(r => r.pass).length,
    expectedDecisions: 14, success: results.length === 7 && results.every(r => r.pass), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection, lock, finished = false;
  try {
    if (process.argv.length !== 2) throw new Error('Unsupported arguments');
    const { config, databaseConfig } = await import('../src/config.js');
    const db = databaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom') throw new Error('Invalid database');
    const { default: mysql } = await import('mysql2/promise');
    const { connectionLimit, ...options } = db;
    connection = await mysql.createConnection(options);
    const before = await readProbeState(connection);
    const idle = state => state.settings.dailyEnabled === false && ['jobs','tasks','attempts'].every(key => Number(state.activity[key]) === 0);
    if (!idle(before)) throw new Error('Not idle');
    const variables = before.catalog.filter(variable => variable.active && !variable.retired && supportsAiVariable(variable));
    const contextHash = hash({ variables, cases: [...qualityCases, fullChecklistCase], version: 'clef-flash-decisions-1' });
    let existing;
    try { existing = JSON.parse(await readFile(outputPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.contextHash !== contextHash || !existing.finishedAt) throw new Error('Existing diagnostic differs');
      console.log(JSON.stringify({ operation: 'clef-quality', reused: true, ...existing.summary }));
      process.exitCode = existing.summary.success ? 0 : 1;
    } else {
      await mkdir(outputPath.substring(0, outputPath.lastIndexOf('/')), { recursive: true, mode: 0o700 });
      lock = await open(`${outputPath}.lock`, 'wx', 0o600);
      let requests = 0;
      const evaluator = new GatewayEvaluator({ baseUrl: process.env.GATEWAY_BASE_URL, token: process.env.AGENT_SHARED_TOKEN,
        portalKey: 'portal-pulso', toolKey: 'gemma', model: 'clef-flash', temperature: 0,
        maxTokens: 16000, timeoutMs: 180000, responseFormat: 'json_schema', fetchImpl: async (url, options) => {
          const body = JSON.parse(options.body);
          if (body.method !== 'POST' || body.path !== '/v1/chat/completions' || body.body?.model !== 'clef-flash'
            || ++requests > 7) throw new Error('Invalid synthetic invocation');
          return fetch(url, options);
        } });
      if (!evaluator.configured || evaluator.decisionInstructionsVersion !== 'clef-flash-decisions-1') throw new Error('Invalid evaluator');
      const result = await runQualityCases({ evaluator, variables, onCase: summary => console.log(JSON.stringify({ operation: 'clef-quality-case', synthetic: true, ...summary })) });
      const after = await readProbeState(connection);
      const unchanged = hash({ catalog: before.catalog, settings: before.settings }) === hash({ catalog: after.catalog, settings: after.settings });
      const { results, ...totals } = result;
      const summary = { ...totals, networkRequests: requests, configurationUnchanged: unchanged, dailyPaused: after.settings.dailyEnabled === false,
        success: totals.success && unchanged && idle(after),
        cases: results.map(({ output, ...item }) => item) };
      const artifact = { format: 1, purpose: 'synthetic-quality-diagnostic-only', contextHash, finishedAt: new Date().toISOString(), summary, results };
      const file = await open(`${outputPath}.tmp`, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(artifact)); await file.sync(); } finally { await file.close(); }
      await rename(`${outputPath}.tmp`, outputPath); finished = true;
      console.log(JSON.stringify({ operation: 'clef-quality', reused: false, ...summary }));
      process.exitCode = summary.success ? 0 : 1;
    }
  } catch {
    console.error(JSON.stringify({ operation: 'clef-quality', errorCode: 'QUALITY_CHECK_NOT_COMPLETED', settingsChanged: false }));
    process.exitCode = 2;
  } finally {
    await connection?.end(); await lock?.close();
    if (finished) await unlink(`${outputPath}.lock`);
  }
}

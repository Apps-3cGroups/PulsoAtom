import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createState } from '../src/data/seed.js';
import { digest, sourceFingerprint } from '../src/evaluation-context.js';
import { freshReviewSelectionHash } from '../src/fresh-review-run.js';
import { ModelRegistry } from '../src/model-registry.js';
import { parseProbeArguments, readProbeRequest, selectProbeCases, readProbeSources, prepareProbe, runProbe, privateProbeOutput,
  probeErrorDiagnostic, sanitizedProbeReport, readPrivateProbeReport, sanitizedUpstreamError, probeGemmaRejection } from '../scripts/probe-review-models.js';

const countries = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'];
const ids = ['clef-local', 'gemma-local'];
const privateText = 'PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG';

function fixture() {
  const state = createState(false);
  for (const variable of state.catalog) variable.active = ['cliente_molesto', 'num_mensajes_cliente'].includes(variable.id);
  state.settings = { ...state.settings, dailyEnabled: true, version: 12,
    automation: { retries: 2, prompts: { mode: 'shared', shared: 'Instrucción configurada', byModel: {}, byItem: {} },
      timeoutMs: { 'clef-local': 90000, 'gemma-local': 120000 },
      concurrency: { 'clef-local': 1, 'gemma-local': 1 } },
    aiPolicy: { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 9 } };
  const all = countries.flatMap((country, countryIndex) => Array.from({ length: 3 }, (_, index) => {
    const id = String(countryIndex * 3 + index + 1);
    return { id, country, date: '2026-11-18', activityDate: '2026-11-18', completed: true,
      activityAt: '2026-11-18T18:00:00.000Z', startedAt: '2026-11-18T12:00:00.000Z',
      sourceDocumentId: `doc-${id}`, sourceDocumentHash: digest(id), sourceUpdatedAt: '2026-11-24T19:00:00.000Z',
      client: { name: 'PRIVATE_CLIENT_NAME' },
      messages: Array.from({ length: index + 1 }, (_, message) => ({ id: `${id}-${message}`, actor: 'cliente',
        text: `${privateText} ${message}`, timestamp: '2026-11-18T12:00:00.000Z' })) };
  }));
  const cases = all.map(conversation => ({ conversationId: conversation.id, country: conversation.country,
    activityDate: conversation.activityDate, activityAt: conversation.activityAt, currentSourceHash: sourceFingerprint(conversation),
    sourceDocumentId: conversation.sourceDocumentId, sourceDocumentHash: conversation.sourceDocumentHash,
    sourceUpdatedAt: conversation.sourceUpdatedAt, sourceCompleted: true, messageCount: conversation.messages.length,
    selectionOrigin: 'original94', hadCompletePair: true }));
  const scope = { from: '2026-11-17', to: '2026-11-19', timezone: 'America/Tegucigalpa' };
  const manifest = { schemaVersion: 1, id: 'test-fresh-review', scope, cases, caseCount: cases.length,
    profiles: ids, expectedNewEvaluations: cases.length * 2, counts: Object.fromEntries(countries.map(country => [country, 3])),
    reviewDeadline: '2026-11-25T10:00:00-06:00', selectionHash: freshReviewSelectionHash({ scope, cases }),
    preparatoryOnly: true, authorizedForExecution: false };
  const selected = new Set(selectProbeCases(manifest).map(item => item.conversationId));
  const source = { conversations: all.filter(conversation => selected.has(conversation.id)), countries: countries.map(code => ({ code })) };
  const control = { calls: [], active: 0, maxActive: 0, partialCountry: null, wrongIdentity: false };
  const registry = new ModelRegistry(ids.map((id, index) => {
    const model = index ? 'gemma-4-26b-a4b-it-mlx' : 'clef-flash';
    return { id, label: index ? 'Gemma' : 'Clef', model, provider: 'gateway', enabled: true, demo: false,
      evaluator: { configured: true, baseUrl: 'http://gateway.private.invalid', toolKey: 'gemma', portalKey: 'portal-pulso',
        timeoutMs: 120000, maxTokens: 16000, temperature: 0, responseFormat: 'json_object', model,
        async evaluate(conversation, variables, options) {
          control.calls.push({ profileId: id, country: conversation.country, conversationId: conversation.id, options });
          control.maxActive = Math.max(control.maxActive, ++control.active);
          await new Promise(resolve => setImmediate(resolve));
          control.active--;
          if (index && conversation.country === control.partialCountry) return { model, results: [],
            validationErrors: variables.map(variable => ({ variableId: variable.id, rules: ['invalid_reason', privateText], message: privateText })) };
          return { model: control.wrongIdentity && index ? 'another-model' : model,
            responseId: `probe-${control.calls.length}`, validationErrors: [],
            results: variables.map(variable => ({ variableId: variable.id, type: variable.type, method: variable.method,
              status: 'evaluado', value: 1, reason: privateText,
              evidence: [{ messageId: conversation.messages[0].id, quote: conversation.messages[0].text }] })) };
        } } };
  }), { gatewayConfigured: true, localOnly: true });
  return { state, manifest, source, registry, control };
}

test('arguments default to read-only check and reject ambiguous modes and traversal', () => {
  assert.deepEqual(parseProbeArguments(['--request-id', 'fresh-review214-20261125']), { requestId: 'fresh-review214-20261125', mode: 'check' });
  assert.equal(parseProbeArguments(['--run', '--request-id', 'example']).mode, 'run');
  assert.equal(parseProbeArguments(['--request-id', 'example', '--report-only']).mode, 'report-only');
  assert.equal(parseProbeArguments(['--request-id', 'example', '--probe-rejection']).mode, 'probe-rejection');
  for (const args of [[], ['--request-id', '../outside'], ['--request-id', 'x', '--check', '--run'], ['--request-id', 'x', '--unexpected']]) {
    assert.throws(() => parseProbeArguments(args), { code: 'INVALID_ARGUMENTS' });
  }
});

function rejectionFixture() {
  const state = fixture().state;
  state.catalog.forEach(variable => { variable.active = true; });
  state.settings.localModelConfiguration = { profiles: [
    { id: 'gemma-local', model: 'gemma-4-26b-a4b-it-mlx', toolKey: 'gemma', enabled: true, responseFormat: 'json_schema', protocol: 'chat' },
  ] };
  const env = { GATEWAY_BASE_URL: 'https://gateway.private.invalid', AGENT_SHARED_TOKEN: 'secret-canary-abc', GATEWAY_PORTAL_KEY: 'portal-pulso' };
  return { state, env };
}

test('synthetic rejection diagnostic preserves actual runtime and captures only safe error fields in one request', async () => {
  const f = rejectionFixture(), before = structuredClone(f.state), calls = [];
  const result = await probeGemmaRejection({ ...f, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.body.model, 'gemma-4-26b-a4b-it-mlx');
    assert.equal(request.timeout_ms, 120000);
    assert.match(request.body.messages[0].content, /Instrucción configurada/);
    assert.match(request.body.messages.at(-1).content, /ProductoPrueba/);
    assert.doesNotMatch(JSON.stringify(request.body.messages), /PRIVATE_CUSTOMER_TEXT/);
    assert.equal(request.body.response_format.type, 'json_schema');
    assert.match(JSON.stringify(request.body.response_format.json_schema.schema), /anyOf/);
    return Response.json({ ok: false, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', request_uuid: 'synthetic-request',
      upstream_status_code: 400, response: { error: { type: 'invalid_request', code: 'invalid_value', param: 'response_format',
        message: 'Failed to convert JSON schema: unsupported anyOf. PRIVATE_CUSTOMER_TEXT secret-canary-abc https://internal.private/path' },
      prompt: privateText, rawResponse: privateText } });
  } });
  assert.equal(calls.length, 1); assert.equal(result.networkCalls, 1); assert.equal(result.blockedAdditionalRequests, 0);
  assert.equal(result.requestedVariables.length, 8); assert.equal(result.includesDescriptor, true);
  assert.equal(result.transport.httpStatus, 200); assert.equal(result.transport.upstreamStatus, 400);
  assert.equal(result.error.code, 'AI_CONFIGURATION'); assert.equal(result.error.upstreamStatus, 400);
  assert.equal(result.transport.error.classification, 'schema-or-grammar-rejection');
  assert.ok(result.transport.error.schemaKeywords.includes('anyOf')); assert.match(result.transport.error.message, /unsupported anyOf/);
  assert.equal(result.completed, false); assert.equal(result.atomRead, false); assert.equal(result.databaseChanged, false);
  assert.deepEqual(f.state, before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|secret-canary|gateway\.private|internal\.private|ProductoPrueba|rawResponse|promptText/);
});

test('synthetic diagnostic limits recursive adapter retries to one network request and redacts arbitrary error content', async () => {
  const f = rejectionFixture(); let calls = 0;
  const result = await probeGemmaRejection({ ...f, fetchImpl: async () => {
    calls++;
    return Response.json({ ok: false, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', request_uuid: 'synthetic-request',
      upstream_status_code: 400, response: { error: { code: 'context_length_exceeded', message: 'Context length exceeded' } } });
  } });
  assert.equal(calls, 1); assert.equal(result.networkCalls, 1); assert.ok(result.blockedAdditionalRequests >= 1);
  assert.deepEqual(result.blockedAdditionalOperations, ['POST /v1/chat/completions']);
  assert.equal(result.transport.upstreamStatus, 400);
  const diagnostic = sanitizedUpstreamError({ message: 'PRIVATE_NAME https://10.0.0.1/path secret-canary-abc JSON schema anyOf',
    type: privateText, code: privateText, param: privateText }, ['secret-canary-abc']);
  assert.equal(diagnostic.type, null); assert.equal(diagnostic.code, null); assert.equal(diagnostic.param, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|secret-canary|10\.0\.0\.1|https/);
  assert.match(diagnostic.message, /JSON schema anyOf/);
  const grammar = sanitizedUpstreamError({ message: 'minLength 1 maxLength 10000 min_repeat 0 max_repeat 3 DFA complexity 10001' });
  assert.match(grammar.message, /minLength 1 maxLength 10000 min_repeat 0 max_repeat 3 DFA complexity \[redacted\]/);
  assert.ok(grammar.schemaKeywords.includes('minLength')); assert.ok(grammar.schemaKeywords.includes('DFA'));
});

test('synthetic diagnostic distinguishes numbered model verification from a schema rejection without sending discovery', async () => {
  const f = rejectionFixture(); let calls = 0;
  const result = await probeGemmaRejection({ ...f, fetchImpl: async () => {
    calls++;
    return Response.json({ ok: true, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', request_uuid: 'synthetic-request',
      upstream_status_code: 200, response: { model: 'gemma-4-26b-a4b-it-mlx:2', choices: [] } });
  } });
  assert.equal(calls, 1); assert.equal(result.transport.returnedModel, 'gemma-4-26b-a4b-it-mlx:2');
  assert.equal(result.transport.upstreamStatus, 200); assert.equal(result.transport.error, null);
  assert.deepEqual(result.blockedAdditionalOperations, ['GET /api/v1/models']);
  assert.equal(result.completed, false);
});

test('request loading uses only read-only SQL and never loads jobs or earlier results', async () => {
  const f = fixture(), calls = [];
  const connection = { async query(options) {
    calls.push(options);
    assert.match(options.sql, /^(?:SET TRANSACTION READ ONLY|START TRANSACTION WITH CONSISTENT SNAPSHOT|SELECT\b)/);
    assert.equal(options.timeout, 15000);
    if (options.sql.includes('portal_settings')) return [[
      { id: 'settings', payload: JSON.stringify(f.state.settings) },
      { id: 'metadata', payload: JSON.stringify({ demo: false }) },
      { id: `reviewRequest:${f.manifest.id}`, payload: JSON.stringify(f.manifest) },
    ]];
    if (options.sql.includes('catalog_items')) return [f.state.catalog.map(payload => ({ payload }))];
    if (options.sql.includes('catalog_versions')) return [f.state.catalogVersions.map(payload => ({ payload }))];
    return [[]];
  }, async rollback() { calls.push('rollback'); } };
  const saved = await readProbeRequest(connection, f.manifest.id);
  assert.equal(saved.manifest.selectionHash, f.manifest.selectionHash);
  assert.deepEqual(saved.state.settings, f.state.settings);
  assert.deepEqual(saved.state.jobs, []); assert.deepEqual(saved.state.tasks, []); assert.deepEqual(saved.state.evaluations, []);
  assert.deepEqual(calls.find(item => item.sql?.includes('portal_settings')).values,
    ['settings', 'metadata', `reviewRequest:${f.manifest.id}`]);
  assert.equal(calls.at(-1), 'rollback');
});

test('check captures exactly six country sources and makes no inference calls', async () => {
  const f = fixture(), selected = selectProbeCases(f.manifest), reads = [];
  assert.deepEqual(selected.map(item => item.country), countries);
  assert.ok(selected.every(item => item.messageCount === 2));
  const source = await readProbeSources({ async read(options) { reads.push(options); return f.source; } }, f.manifest);
  const prepared = prepareProbe({ ...f, source });
  assert.deepEqual(reads, [{ fresh: true, conversationIds: selected.map(item => item.conversationId) }]);
  assert.equal(prepared.plan.expectedReviews, 12);
  assert.ok(prepared.plan.profiles.every(profile => profile.responseFormat === 'json_object'));
  assert.equal(prepared.plan.configuredAutomaticRetries, 2);
  assert.deepEqual(f.control.calls, []);
  assert.doesNotMatch(JSON.stringify(prepared.plan), /PRIVATE_|conversationId|sourceDocumentId/);
});

test('missing countries, mutated sources, disabled or foreign models fail before inference', async () => {
  const f = fixture();
  const missing = structuredClone(f.manifest);
  missing.cases = missing.cases.filter(item => item.country !== 'NI'); missing.caseCount = missing.cases.length;
  missing.expectedNewEvaluations = missing.caseCount * 2; missing.counts.NI = 0;
  missing.selectionHash = freshReviewSelectionHash(missing);
  assert.throws(() => selectProbeCases(missing), { code: 'PILOT_COUNTRIES_REQUIRED' });
  const changed = structuredClone(f.source); changed.conversations[0].messages[0].text = 'Different source';
  assert.throws(() => prepareProbe({ ...f, source: changed }), { code: 'SOURCE_CHANGED' });
  f.registry.profiles[1].enabled = false;
  assert.throws(() => prepareProbe(f), { code: 'AI_CONFIGURATION' });
  f.registry.profiles[1].enabled = true; f.registry.profiles[1].provider = 'openai';
  assert.throws(() => prepareProbe(f), { code: 'REVIEW_MODELS_CHANGED' });
  f.registry.profiles[1].provider = 'gateway'; f.registry.profiles[1].model = 'clef-flash';
  assert.throws(() => prepareProbe(f), { code: 'REVIEW_MODELS_CHANGED' });
  assert.deepEqual(f.control.calls, []);
});

test('pilot creates 12 fresh reviews in isolation despite existing production work and old results', async () => {
  const f = fixture();
  f.state.jobs = [{ id: 'production-running', status: 'running' }];
  f.state.evaluations = [{ id: 'old-result', conversationId: f.source.conversations[0].id, results: [{ value: 1 }] }];
  f.state.tasks = [{ id: 'old-task', status: 'completed', evaluationId: 'old-result' }];
  const before = structuredClone(f.state), checkpoints = [], reports = [];
  const result = await runProbe({ ...f, checkpoint: async artifact => checkpoints.push(structuredClone(artifact)), report: event => reports.push(event) });
  assert.equal(result.passed, true); assert.equal(result.completed, 12); assert.equal(f.control.calls.length, 12);
  assert.equal(f.control.maxActive, 1);
  assert.deepEqual(result.bothCompleteCountries, countries);
  assert.deepEqual(result.byModel.map(model => model.completed), [6, 6]);
  assert.ok(f.control.calls.every(call => call.options.promptText === 'Instrucción configurada'));
  assert.deepEqual(f.state, before, 'production state, maintenance and daily configuration remain untouched');
  const last = checkpoints.at(-1);
  assert.equal(last.evaluations.length, 12); assert.ok(last.evaluations.every(evaluation => evaluation.purpose === 'comparison' && evaluation.id !== 'old-result'));
  assert.ok(last.tasks.every(task => task.id !== 'old-task' && task.profileStates));
  assert.equal(last.job.concurrency, 1); assert.deepEqual(last.job.modelProfiles.map(profile => profile.id), ids);
  assert.equal(last.published, false); assert.equal(last.databaseChanged, false);
  assert.match(JSON.stringify(last.evaluations), /PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG/, 'private artifact preserves genuine results');
  assert.doesNotMatch(JSON.stringify([result, reports]), /PRIVATE_|conversationId|sourceDocumentId|production-running|old-result/);
});

test('a partial Gemma answer remains failed, retries only that task and exposes only safe rule counts', async () => {
  const f = fixture(); f.control.partialCountry = 'HN';
  const result = await runProbe(f);
  assert.equal(result.passed, false); assert.equal(result.completed, 11);
  assert.equal(result.byModel.find(model => model.profileId === 'gemma-local').partial, 1);
  assert.equal(f.control.calls.filter(call => call.country === 'HN' && call.profileId === 'gemma-local').length, 2);
  assert.equal(f.control.calls.filter(call => call.profileId === 'clef-local').length, 6);
  assert.equal(result.errors.INVALID_AI_RESULT, 1); assert.equal(result.validationRules.invalid_reason, 2);
  assert.equal(result.bothCompleteCountries.includes('HN'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('completed task status cannot hide an incorrect model identity', async () => {
  const f = fixture(); f.control.wrongIdentity = true;
  const result = await runProbe(f);
  assert.equal(result.passed, false); assert.equal(result.completed, 6);
  assert.equal(result.errors.PILOT_RESULTS_INVALID, 6);
  assert.deepEqual(result.bothCompleteCountries, []);
});

test('private artifacts are owner-only, checkpointed atomically and protected from concurrent pilots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pulso-private-probe-'));
  let output;
  try {
    output = await privateProbeOutput('test-pilot', root);
    await assert.rejects(privateProbeOutput('test-pilot', root), { code: 'PILOT_ALREADY_RUNNING' });
    await output.checkpoint({ state: 'progress', privateText });
    await output.checkpoint({ state: 'finished', privateText });
    const directory = path.join(root, 'test-pilot'), files = await readdir(directory);
    const artifacts = files.filter(file => file.endsWith('.json'));
    assert.equal(artifacts.length, 1); assert.ok(!files.some(file => file.endsWith('.tmp')));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, artifacts[0]))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(directory, artifacts[0]), 'utf8')).state, 'finished');
    await output.close(); output = null;
    assert.ok(!(await readdir(directory)).includes('pilot.lock'));
  } finally { await output?.close(); await rm(root, { recursive: true, force: true }); }
});

test('diagnostic extracts saved HTTP status only from exact technical templates and redacts arbitrary messages', () => {
  const known = probeErrorDiagnostic({ code: 'AI_CONFIGURATION', message: 'El Gateway rechazó la solicitud al modelo local (HTTP 400).' });
  assert.equal(known.upstreamStatus, 400); assert.equal(known.upstreamStatusSource, 'known-saved-message');
  assert.equal(known.messageRedacted, false);
  const unknown = probeErrorDiagnostic({ code: 'AI_CONFIGURATION', message: `HTTP 400 ${privateText} token=secret`, body: privateText });
  assert.equal(unknown.upstreamStatus, null); assert.equal(unknown.messageRedacted, true);
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_|secret|token=/);
  const conflict = probeErrorDiagnostic({ code: 'AI_CONFIGURATION', details: { upstreamStatus: 422 }, message: known.message });
  assert.equal(conflict.upstreamStatus, null); assert.equal(conflict.upstreamStatusSource, 'conflicting-saved-fields');
});

test('report-only reads the private artifact without re-evaluating and emits no conversation identifiers or text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pulso-report-only-'));
  let output;
  try {
    output = await privateProbeOutput('test-report', root);
    const artifact = { schemaVersion: 1, privateDiagnostic: true,
      summary: { requestId: 'test-report', passed: false, completed: 6, checkedAt: '2026-11-24T23:00:00.000Z',
        byModel: [{ profileId: 'gemma-local', model: 'gemma-4-26b-a4b-it-mlx', total: 6, completed: 0, partial: 6, failed: 0 }] },
      sources: [{ conversationId: 'PRIVATE_CONVERSATION_ID', country: 'SV' }],
      tasks: [{ id: 'PRIVATE_TASK_ID', conversationId: 'PRIVATE_CONVERSATION_ID', status: 'partial', profile: { id: 'gemma-local' },
        error: { code: 'AI_CONFIGURATION', message: 'El Gateway rechazó la solicitud al modelo local (HTTP 400).' } }],
      attempts: [{ taskId: 'PRIVATE_TASK_ID', profileId: 'gemma-local', requestedModel: 'gemma-4-26b-a4b-it-mlx', status: 'failed', durationMs: 300,
        variableIds: ['cliente_molesto'], validVariableIds: [], validationErrors: [{ variableId: 'cliente_molesto', rules: ['invalid_reason', privateText], message: privateText }],
        error: { code: 'AI_CONFIGURATION', message: `RAW_BODY ${privateText}` }, rawResponse: privateText }],
      evaluations: [{ results: [{ reason: privateText, quote: privateText }] }],
    };
    await output.checkpoint(artifact);
    const report = await readPrivateProbeReport('test-report', root);
    assert.equal(report.phase, 'report-only'); assert.equal(report.inferenceExecuted, false); assert.equal(report.databaseChanged, false);
    assert.equal(report.tasks[0].country, 'SV'); assert.equal(report.tasks[0].error.upstreamStatus, 400);
    assert.equal(report.attempts[0].error.messageRedacted, true);
    assert.deepEqual(report.attempts[0].validationErrors, [{ variableId: 'cliente_molesto', rules: ['invalid_reason'] }]);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|RAW_BODY|rawResponse|conversationId|taskId|quote/);
    assert.throws(() => sanitizedProbeReport(artifact, 'different-request'), { code: 'PILOT_REPORT_INVALID' });
    await assert.rejects(readPrivateProbeReport('missing', root), { code: 'PILOT_REPORT_NOT_FOUND' });
  } finally { await output?.close(); await rm(root, { recursive: true, force: true }); }
});

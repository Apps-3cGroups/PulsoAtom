import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runClefConversationCheck, readProbeState } from './check-clef-conversation.js';
import { persistClefTwoFlagsDecisions } from './persist-clef-two-flags-decisions.js';

const directory = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics';
const strict = process.argv.length === 3 && process.argv[2] === '--strict-contract';
const decisions = process.argv.length === 3 && process.argv[2] === '--two-flags-decisions';
const twoFlags = decisions || (process.argv.length === 3 && process.argv[2] === '--two-flags');
const selectedIds = ['cliente_molesto', 'asistente_falto_al_respeto'];
const capturedPath = `${directory}/clef-flash-6135-${decisions ? 'two-flags-decisions-1-' : twoFlags ? 'two-flags-' : strict ? 'strict-schema-' : ''}response-20261107.json`;
const outputPath = `${directory}/clef-flash-6135-${decisions ? 'two-flags-decisions-1' : twoFlags ? 'two-flags' : strict ? 'strict-schema' : 'adapted'}-20261107-v1.json`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let connection, reader, networkRequests = 0, replayedResponses = 0;
try {
  if (process.argv.length !== 2 && !strict && !twoFlags) throw new Error('Unsupported arguments');
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) throw new Error('Invalid configuration');
  const { default: mysql } = await import('mysql2/promise');
  const { AtomReader } = await import('../src/atom.js');
  const { connectionLimit, ...options } = db;
  connection = await mysql.createConnection(options);
  reader = new AtomReader(atom, config.timezone);
  const readState = async (...args) => {
    const state = await readProbeState(...args);
    if (args[1]?.chooseReference && state.reference?.conversationId !== '6135') throw new Error('Reference changed');
    return state;
  };
  // The captured provider reply stays on the server with mode 0600. It is not
  // printed, sent to another provider or committed; no transcript is stored.
  // A replay must match the complete request body, including content/checklist.
  const captureFetch = async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method !== 'POST' || request.path !== '/v1/chat/completions' || request.body?.model !== 'clef-flash') throw new Error('Invalid request');
    const requestHash = digest(request.body);
    let cached;
    try { cached = JSON.parse(await readFile(capturedPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached) {
      if (cached.format !== 1 || cached.requestHash !== requestHash || cached.httpStatus !== 200
        || cached.envelope?.response?.model !== 'clef-flash') throw new Error('Captured request changed');
      replayedResponses++;
      return new Response(JSON.stringify(cached.envelope), { status: cached.httpStatus });
    }
    if (networkRequests !== 0) throw new Error('Only one model request is authorized');
    networkRequests++;
    const response = await fetch(url, options);
    const envelope = await response.clone().json();
    if (response.status === 200 && envelope.upstream_status_code === 200 && envelope.response?.model === 'clef-flash') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = await open(capturedPath, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ format: 1, requestHash, capturedAt: new Date().toISOString(), httpStatus: response.status, envelope }));
        await file.sync();
      } finally { await file.close(); }
    }
    return response;
  };
  const previous = twoFlags ? JSON.parse(await readFile(`${directory}/clef-flash-6135-strict-schema-20261107-v1.json`, 'utf8')) : null;
  if (twoFlags && (previous.conversationId !== '6135' || !/^[a-f0-9]{64}$/.test(previous.context?.sourceHash))) throw new Error('Missing source baseline');
  const result = await runClefConversationCheck({ connection, reader, readState, fetchImpl: captureFetch, outputPath,
    ...(twoFlags ? { variableIds: selectedIds, expectedSourceHash: previous.context.sourceHash } : {}),
    ...(decisions ? { expectedDecisionInstructionsVersion: 'clef-flash-decisions-1' } : {}) });
  // Output only normalized decisions and counts. The complete response and
  // reasons remain in the private capture rather than the workflow logs.
  console.log(JSON.stringify({ operation: 'captured-probe-status', ...result }, null, 2));
  const captured = JSON.parse(await readFile(capturedPath, 'utf8'));
  if (decisions && result.success) {
    const artifact = JSON.parse(await readFile(outputPath, 'utf8'));
    const imported = await persistClefTwoFlagsDecisions(connection, artifact, captured, previous.context.sourceHash);
    console.log(JSON.stringify({ operation: 'private-decision-capture-import', ...imported }));
  }
  const message = captured.envelope?.response?.choices?.[0]?.message;
  const parsed = JSON.parse(message?.content?.trim() ? message.content : message.reasoning_content);
  const combinations = {}, reasonLengths = [];
  for (const item of Object.values(parsed.results || {})) {
    const status = ['evaluado', 'no_evaluado'].includes(item?.status) ? item.status : 'invalid';
    const value = item?.value == null ? String(item?.value) : [0, 1].includes(item.value) ? String(item.value) : Array.isArray(item.value) ? 'list' : typeof item.value;
    const key = `${status}:${value}`;
    combinations[key] = (combinations[key] || 0) + 1;
    if (typeof item?.reason === 'string') reasonLengths.push(item.reason.length);
  }
  console.log(JSON.stringify({ operation: 'capture-and-validate-clef-flash', networkRequests, replayedResponses,
    ...(twoFlags ? { assessments: selectedIds.map(variableId => {
      const item = parsed.results?.[variableId];
      return { variableId, status: ['evaluado', 'no_evaluado'].includes(item?.status) ? item.status : 'invalid',
        value: [0, 1, null].includes(item?.value) ? item.value : 'invalid',
        evidenceCount: Array.isArray(item?.evidence_message_ids) ? item.evidence_message_ids.length : null };
    }) } : {}),
    capturedStructure: { items: Object.keys(parsed.results || {}).length, combinations,
      reasonMinLength: Math.min(...reasonLengths), reasonMaxLength: Math.max(...reasonLengths) }, ...result }, null, 2));
  process.exitCode = result.success ? 0 : 1;
} catch {
  console.error(JSON.stringify({ operation: 'capture-and-validate-clef-flash', error: 'CAPTURE_CHECK_FAILED', networkRequests, replayedResponses }));
  process.exitCode = 2;
} finally { await Promise.all([connection?.end(), reader?.close()]); }

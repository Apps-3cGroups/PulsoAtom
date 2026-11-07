import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runClefConversationCheck, readProbeState } from './check-clef-conversation.js';
import { catalogReferences, digest, sourceFingerprint } from '../src/evaluation-context.js';
import { evaluationInstructions, RULES_VERSION } from '../src/evaluator.js';
import { AppError } from '../src/errors.js';

const directory = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics';
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const stop = code => { throw new AppError(409, 'El caso de prueba cambió; no se envió otra evaluación.', code); };

export function shouldTryPromptJson(summary) {
  const shape = summary.protocol?.responseShape;
  return !summary.success && summary.errorCode === 'INVALID_AI_RESULT'
    && summary.sourceUnchanged && summary.configurationUnchanged
    && summary.protocol?.gatewayHttpStatus === 200 && summary.protocol.upstreamStatus === 200
    && summary.protocol?.actualModel === 'clef-flash' && shape?.choicesCount === 1
    && shape.finishReason === 'stop' && !shape.refusalPresent && shape.toolCallsCount === 0
    && ['string', 'null', 'missing'].includes(shape.content.type) && shape.content.characters === 0;
}

// Exactly the already-authorized conversation, with no selection of new chats.
// Each mode owns an exclusive persisted reservation in the underlying probe.
export async function checkClefResponseModes({ connection, reader, env = process.env, fetchImpl = fetch,
  baseline, outputDirectory = directory, runProbe = runClefConversationCheck, onStage = () => {} }) {
  if (baseline?.format !== 1 || baseline.model !== 'clef-flash' || baseline.conversationId !== '6135'
    || baseline.summary?.errorCode !== 'INVALID_AI_RESULT' || !baseline.context?.sourceHash
    || !baseline.gemmaReference?.evaluationId) stop('INVALID_SOURCE');
  const readState = async () => {
    const state = await readProbeState(connection);
    if (digest(catalogReferences(state.catalog)) !== baseline.context.catalogHash
      || digest(evaluationInstructions) !== baseline.context.promptHash || RULES_VERSION !== baseline.context.rulesVersion) stop('INVALID_CATALOG');
    const [rows] = await connection.execute('SELECT payload FROM evaluations WHERE id = ?', [baseline.gemmaReference.evaluationId]);
    const reference = rows.length === 1 ? decode(rows[0].payload) : null;
    if (reference?.conversationId !== '6135' || reference.profileId !== 'gemma-local'
      || reference.partial !== false || reference.sourceHash !== baseline.context.sourceHash) stop('INVALID_SOURCE');
    return { ...state, reference };
  };
  const scopedReader = { read: async options => {
    if (options.conversationIds?.length !== 1 || options.conversationIds[0] !== '6135') stop('INVALID_SOURCE');
    const source = await reader.read(options);
    if (source.conversations.length !== 1 || sourceFingerprint(source.conversations[0]) !== baseline.context.sourceHash) stop('INVALID_SOURCE');
    return source;
  } };
  const common = { connection, reader: scopedReader, env, fetchImpl, readState };
  const stages = [];
  const schema = await runProbe({ ...common, outputPath: `${outputDirectory}/clef-flash-6135-schema-shape-v1.json`, requestMode: 'schema' });
  stages.push(schema); onStage(schema);
  if (shouldTryPromptJson(schema)) {
    const prompt = await runProbe({ ...common, outputPath: `${outputDirectory}/clef-flash-6135-compact-json-v1.json`, requestMode: 'compact-json' });
    stages.push(prompt); onStage(prompt);
  }
  return { operation: 'clef-response-modes', conversationId: '6135', success: stages.some(stage => stage.success), stages,
    note: 'Diagnóstico aislado: como máximo dos solicitudes sobre el mismo contenido. Sin cambios de política ni evaluaciones oficiales.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection, reader;
  try {
    if (process.argv.length !== 2) throw new Error('Invalid arguments');
    const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
    const db = databaseConfig(), atom = atomDatabaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) stop('INVALID_SETTINGS');
    const { default: mysql } = await import('mysql2/promise');
    const { AtomReader } = await import('../src/atom.js');
    const { connectionLimit, ...options } = db;
    connection = await mysql.createConnection(options); reader = new AtomReader(atom, config.timezone);
    const baseline = JSON.parse(await readFile(`${directory}/clef-flash-real-2026-11-07.json`, 'utf8'));
    const result = await checkClefResponseModes({ connection, reader, baseline,
      onStage: stage => console.log(JSON.stringify({ completedStage: stage })) });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.success ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ success: false, error: 'CLEF_RESPONSE_DIAGNOSIS_INCOMPLETE',
      message: 'No se completó el diagnóstico. No se cambió la configuración ni se guardaron evaluaciones oficiales.' })); process.exitCode = 2;
  } finally { await Promise.all([connection?.end(), reader?.close()]); }
}

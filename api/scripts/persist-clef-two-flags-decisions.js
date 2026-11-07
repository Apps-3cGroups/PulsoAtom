import { isDeepStrictEqual } from 'node:util';

export const diagnosticId = 'clefTwoFlags6135Decisions1';
const variableIds = ['cliente_molesto', 'asistente_falto_al_respeto'];
const version = 'clef-flash-decisions-1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw new Error('PRIVATE_DECISION_CAPTURE_IMPORT_FAILED'); };

// Import only the existing validator's two successful decisions, never the raw
// provider envelope, source transcript, transport headers or credentials.
export function projectClefTwoFlagsDecisions(artifact, capture, expectedSourceHash) {
  if (artifact?.format !== 1 || artifact.model !== 'clef-flash' || artifact.conversationId !== '6135'
    || artifact.purpose !== 'isolated-real-content-probe' || artifact.requestMode !== 'schema'
    || artifact.decisionInstructionsVersion !== version || artifact.summary?.decisionInstructionsVersion !== version
    || artifact.summary?.success !== true || artifact.summary.status !== 'completed' || artifact.errorCode
    || artifact.sourceUnchanged !== true || artifact.configurationUnchanged !== true || artifact.idleAfter !== true
    || !Array.isArray(artifact.validationErrors) || artifact.validationErrors.length
    || !hash(expectedSourceHash) || artifact.context?.sourceHash !== expectedSourceHash
    || !hash(artifact.requestHash) || !Array.isArray(artifact.requestedVariableIds)
    || artifact.requestedVariableIds.length !== 2 || !variableIds.every(id => artifact.requestedVariableIds.includes(id))
    || !Array.isArray(artifact.results) || artifact.results.length !== 2
    || !['content', 'reasoning_content'].includes(artifact.responseField)) fail();
  if (capture?.format !== 1 || capture.httpStatus !== 200 || capture.requestHash !== artifact.requestHash
    || capture.envelope?.ok !== true || capture.envelope.upstream_status_code !== 200
    || capture.envelope.response?.model !== 'clef-flash' || typeof capture.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(capture.capturedAt))) fail();
  const results = Object.fromEntries(variableIds.map(variableId => {
    const matches = artifact.results.filter(result => result.variableId === variableId);
    const item = matches[0];
    if (matches.length !== 1 || item.type !== 'Flag' || item.method !== 'IA' || item.aiResult
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000
      || !Array.isArray(item.evidenceMessageIds) || item.evidenceMessageIds.some(id => typeof id !== 'string' || !id)
      || !((item.status === 'evaluado' && [0, 1].includes(item.value)) || (item.status === 'no_evaluado' && item.value === null))) fail();
    if (item.value === 1 ? item.evidenceMessageIds.length < 1 || item.evidenceMessageIds.length > 3 : item.evidenceMessageIds.length !== 0) fail();
    return [variableId, { status: item.status, value: item.value, reason: item.reason, evidence_message_ids: [...item.evidenceMessageIds] }];
  }));
  return { model: 'clef-flash', conversationId: '6135', sourceField: artifact.responseField, capturedAt: capture.capturedAt,
    requestHash: artifact.requestHash, sourceHash: expectedSourceHash, decisionInstructionsVersion: version, results };
}

export async function persistClefTwoFlagsDecisions(connection, artifact, capture, expectedSourceHash) {
  const projected = projectClefTwoFlagsDecisions(artifact, capture, expectedSourceHash);
  await connection.beginTransaction();
  try {
    const [locks] = await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    if (locks.length !== 1 || Number(locks[0].id) !== 1) fail();
    const [rows] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
    if (rows.length !== 1) fail();
    const settings = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    if (!object(settings) || (settings.modelDiagnostics !== undefined && !object(settings.modelDiagnostics))) fail();
    const diagnostics = settings.modelDiagnostics || {};
    if (Object.hasOwn(diagnostics, diagnosticId)) {
      if (!isDeepStrictEqual(diagnostics[diagnosticId], projected)) fail();
      await connection.commit();
      return { success: true, id: diagnosticId, imported: false, count: 2 };
    }
    const next = { ...settings, modelDiagnostics: { ...diagnostics, [diagnosticId]: projected } };
    const [written] = await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(next)]);
    if (written.affectedRows !== 1) fail();
    await connection.commit();
    return { success: true, id: diagnosticId, imported: true, count: 2 };
  } catch (error) { await connection.rollback(); throw error; }
}

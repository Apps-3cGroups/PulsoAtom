import { AppError } from './errors.js';
import { evaluationInput, evaluationInstructions, supportsAiVariable, validateEvaluation } from './evaluator.js';

// Keep Gemini's response grammar constant-size. Repeating one schema branch per
// checklist item can exceed the provider's structured-output complexity limit.
// The common validator still enforces each variable's actual type and evidence.
export function geminiEvaluationSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        description: 'Un resultado por cada variable solicitada, identificado por su variableId exacto y sin duplicados.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            variableId: { type: 'string' },
            status: { type: 'string', enum: ['evaluado', 'no_evaluado'] },
            value: { anyOf: [
              { type: 'integer', enum: [0, 1] },
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ] },
            reason: { type: 'string' },
            evidence_message_ids: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          },
          required: ['variableId', 'status', 'value', 'reason', 'evidence_message_ids'],
        },
      },
    },
    required: ['results'],
  };
}

export function normalizeGeminiResults(raw, variables) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) throw new AppError(502, 'Gemini no devolvió una lista de resultados válida.', 'INVALID_AI_RESULT');
  const allowed = new Set(variables.map(v => v.id));
  const seen = new Set();
  const entries = raw.results.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.variableId !== 'string' || !allowed.has(item.variableId)) throw new AppError(502, 'Gemini devolvió un identificador de variable ajeno a la solicitud.', 'INVALID_AI_RESULT');
    if (seen.has(item.variableId)) throw new AppError(502, `Gemini repitió la variable ${item.variableId}.`, 'INVALID_AI_RESULT');
    seen.add(item.variableId);
    const { variableId, ...result } = item;
    return [variableId, result];
  });
  // Missing IDs intentionally remain absent: validateEvaluation marks only those
  // items invalid and allows the batch to retain all other valid answers.
  return { results: Object.fromEntries(entries) };
}

export class GeminiEvaluator {
  constructor({ apiKey, baseUrl, model, timeoutMs = 120000, fetchImpl = fetch }) {
    Object.assign(this, { apiKey, baseUrl: baseUrl?.replace(/\/$/, ''), model, timeoutMs, fetchImpl });
  }
  get configured() { return !!(this.apiKey && this.baseUrl && this.model); }
  async evaluate(conversation, variables) {
    if (!this.configured) throw new AppError(503, 'Falta configurar Gemini.', 'AI_CONFIGURATION');
    if (!variables.length || variables.some(v => !supportsAiVariable(v))) throw new AppError(422, 'El checklist incluye una variable no admitida por este evaluador.', 'UNSUPPORTED_VARIABLE');
    if (!conversation.messages.length) throw new AppError(422, 'La conversación no tiene mensajes evaluables.', 'EMPTY_CONVERSATION');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: evaluationInstructions }] },
          contents: [{ role: 'user', parts: [{ text: evaluationInput(conversation, variables) }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: geminiEvaluationSchema() } }),
      });
    } catch { throw new AppError(502, 'No se pudo contactar Gemini dentro del tiempo permitido.', 'AI_UNAVAILABLE'); }
    if (!response.ok) throw new AppError(502, `Gemini rechazó la solicitud (HTTP ${response.status}).`, [408, 429].includes(response.status) || response.status >= 500 ? 'AI_TRANSIENT' : 'AI_CONFIGURATION');
    let payload;
    try { payload = await response.json(); } catch { throw new AppError(502, 'Gemini devolvió una respuesta inválida.', 'INVALID_AI_RESULT'); }
    const candidate = payload.candidates?.[0];
    if (payload.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate?.finishReason)) throw new AppError(422, 'El modelo no puede evaluar este contenido.', 'AI_SAFETY_REFUSAL');
    if (candidate?.finishReason !== 'STOP') throw new AppError(502, 'Gemini no completó la evaluación.', 'AI_INCOMPLETE');
    let raw;
    try { raw = JSON.parse(candidate.content.parts.filter(p => !p.thought).map(p => p.text || '').join('')); }
    catch { throw new AppError(502, 'Gemini no devolvió el formato requerido.', 'INVALID_AI_RESULT'); }
    return { ...validateEvaluation(normalizeGeminiResults(raw, variables), variables, conversation, { partial: true }), model: payload.modelVersion || this.model,
      responseId: payload.responseId || null, usage: payload.usageMetadata || null };
  }
}

import { AppError } from './errors.js';
import { evaluationInput, evaluationSchema, systemInstructions, validateEvaluation } from './evaluator.js';

export class GeminiEvaluator {
  constructor({ apiKey, baseUrl, model, timeoutMs = 120000, fetchImpl = fetch }) {
    Object.assign(this, { apiKey, baseUrl: baseUrl?.replace(/\/$/, ''), model, timeoutMs, fetchImpl });
  }
  get configured() { return !!(this.apiKey && this.baseUrl && this.model); }
  async evaluate(conversation, variables) {
    if (!this.configured) throw new AppError(503, 'Falta configurar Gemini.', 'AI_CONFIGURATION');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemInstructions }] },
          contents: [{ role: 'user', parts: [{ text: evaluationInput(conversation, variables) }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: evaluationSchema(variables) } }),
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
    return { results: validateEvaluation(raw, variables, conversation), model: payload.modelVersion || this.model,
      responseId: payload.responseId || null, usage: payload.usageMetadata || null };
  }
}

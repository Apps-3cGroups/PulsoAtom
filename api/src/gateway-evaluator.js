import { AppError } from './errors.js';
import { evaluationInput, evaluationInstructions, evaluationSchema, supportsAiVariable, validateEvaluation } from './evaluator.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';

const safeUsage = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = ['prompt_tokens', 'completion_tokens', 'total_tokens']
    .filter(key => Number.isInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]]);
  return entries.length ? Object.fromEntries(entries) : null;
};

export class GatewayEvaluator {
  #client;
  constructor({ baseUrl, token, portalKey, toolKey, model, timeoutMs = 180000,
    maxTokens = 16000, temperature = 0, responseFormat = 'json_schema', fetchImpl = fetch } = {}) {
    this.#client = new GatewayApiClient({ baseUrl, token, portalKey, timeoutMs, fetchImpl });
    Object.assign(this, { baseUrl: this.#client.baseUrl, portalKey, toolKey, model, timeoutMs, maxTokens, temperature, responseFormat });
  }
  get configured() {
    return this.#client.configured && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(this.toolKey || '')
      && typeof this.model === 'string' && !!this.model.trim() && this.model.length <= 200
      && Number.isInteger(this.maxTokens) && this.maxTokens >= 1 && this.maxTokens <= 65536
      && Number.isFinite(this.temperature) && this.temperature >= 0 && this.temperature <= 2
      && ['json_schema', 'json_object'].includes(this.responseFormat);
  }
  async discovery() {
    if (!this.configured) throw new AppError(503, 'Falta configurar el modelo local y su herramienta en el Gateway.', 'AI_CONFIGURATION');
    const catalog = await this.#client.listTools();
    const models = await this.#client.invoke({ toolKey: this.toolKey, method: 'GET', path: '/v1/models', operation: 'preflight' });
    // Backend preflight only: do not return the catalog's provider URLs to the UI.
    return { catalog, models: models.response, requestId: models.requestId };
  }
  async evaluate(conversation, variables, options) {
    if (!this.configured) throw new AppError(503, 'Falta configurar el modelo local y su herramienta en el Gateway.', 'AI_CONFIGURATION');
    if (!variables.length || variables.some(v => !supportsAiVariable(v))) throw new AppError(422, 'El checklist incluye una variable no admitida por este evaluador.', 'UNSUPPORTED_VARIABLE');
    if (!conversation.messages.length) throw new AppError(422, 'La conversación no tiene mensajes evaluables.', 'EMPTY_CONVERSATION');
    const schema = evaluationSchema(variables);
    const messages = [{ role: 'system', content: evaluationInstructions }];
    if (this.responseFormat === 'json_object') {
      messages.push({ role: 'system', content: `Devuelve únicamente un objeto JSON que cumpla este esquema. No incluyas Markdown ni texto fuera del JSON: ${JSON.stringify(schema)}` });
    }
    messages.push({ role: 'user', content: evaluationInput(conversation, variables, options) });
    const envelope = await this.#client.invoke({ toolKey: this.toolKey, method: 'POST', path: '/v1/chat/completions',
      body: { model: this.model, messages, temperature: this.temperature, max_tokens: this.maxTokens, stream: false,
        response_format: this.responseFormat === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'pulso_evaluation', strict: true, schema } }
          : { type: 'json_object' } } });
    const payload = envelope.response;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError(502, 'El modelo local devolvió una respuesta inválida.', 'INVALID_AI_RESULT');
    // Never silently attribute a result to the requested model when the server
    // omitted its identity or answered with a different loaded model.
    if (typeof payload.model !== 'string' || !payload.model.trim()) throw new AppError(502, 'El servicio local no informó qué modelo produjo la respuesta.', 'MODEL_IDENTITY_UNVERIFIED');
    if (payload.model !== this.model) throw new AppError(409, 'El servicio local respondió con un modelo distinto al solicitado. Revisa su configuración.', 'MODEL_CHANGED');
    if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new AppError(502, 'El modelo local no devolvió una única evaluación.', 'INVALID_AI_RESULT');
    const choice = payload.choices[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new AppError(422, 'El modelo no puede evaluar este contenido.', 'AI_SAFETY_REFUSAL');
    if (choice?.finish_reason !== 'stop') throw new AppError(502, 'El modelo local no completó la evaluación.', 'AI_INCOMPLETE');
    const message = choice.message;
    if (message?.function_call != null || (message?.tool_calls != null
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length))) {
      throw new AppError(502, 'El modelo local devolvió una llamada de herramienta en lugar de una evaluación.', 'INVALID_AI_RESULT');
    }
    let text = message?.content, responseField = 'content';
    // Clef Flash's current chat runtime can place its complete structured answer
    // in reasoning_content while leaving content empty. Only this exact model
    // may use that channel; never extract JSON fragments from reasoning prose
    // or replace a nonempty final answer, even when that answer is invalid.
    const emptyContent = text == null || (typeof text === 'string' && !text.trim());
    if (payload.model === 'clef-flash' && emptyContent) {
      text = message?.reasoning_content;
      responseField = 'reasoning_content';
    }
    if (typeof text !== 'string' || !text.trim()) throw new AppError(502, 'El modelo local no devolvió una evaluación estructurada.', 'INVALID_AI_RESULT');
    let raw;
    try { raw = JSON.parse(text); }
    catch { throw new AppError(502, 'El modelo local no devolvió el JSON requerido.', 'INVALID_AI_RESULT'); }
    if (responseField === 'reasoning_content' && (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'results'))) {
      throw new AppError(502, 'El modelo local no devolvió el objeto de evaluación requerido.', 'INVALID_AI_RESULT');
    }
    if (responseField === 'reasoning_content' && raw.results && typeof raw.results === 'object'
      && Object.values(raw.results).some(item => item && typeof item === 'object' && !Array.isArray(item)
        && Object.keys(item).some(key => !['status', 'value', 'reason', 'evidence_message_ids'].includes(key)))) {
      throw new AppError(502, 'El modelo local añadió campos ajenos al contrato de evaluación.', 'INVALID_AI_RESULT');
    }
    return { ...validateEvaluation(raw, variables, conversation, { partial: true }), model: payload.model,
      responseId: envelope.requestId, responseField, usage: safeUsage(payload.usage) };
  }
}

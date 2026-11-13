import { AppError } from './errors.js';
import { evaluationInput, evaluationInstructions, evaluationSchema, supportsAiVariable, validateEvaluation } from './evaluator.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';
import { verifyNumberedModelInstance } from './services/gatewayModelIdentity.js';
import { CLEF_FLASH_OUTPUT_SCHEMA_VERSION, clefFlashEvaluationSchema } from './services/clefFlashSchema.js';
import { CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION, clefFlashDecisionInstructions } from './services/clefFlashInstructions.js';

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
    if (model === 'clef-flash') {
      this.outputSchemaVersion = CLEF_FLASH_OUTPUT_SCHEMA_VERSION;
      this.decisionInstructionsVersion = CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION;
    }
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
    const boundedFailure = error => ['AI_CONTEXT_LIMIT', 'AI_RESOURCE_LIMIT'].includes(error.code);
    const canDivide = error => boundedFailure(error)
      || (error.code === 'AI_TRANSIENT' && error.details?.upstreamStatus === 504);
    // These local runtimes can exceed time/memory limits on the full checklist.
    // Bound their first request while retaining all source and variable rules.
    let reason = 'checklist-size';
    const partitionChecklist = this.model.startsWith('gemma-') || this.model === 'clef-flash';
    if (!partitionChecklist || variables.length <= 8) {
      try { return await this.#evaluateSingle(conversation, variables, options); }
      catch (error) {
        if (!canDivide(error) || variables.length <= 1) throw error;
        reason = error.code === 'AI_CONTEXT_LIMIT' ? 'context-limit' : error.code === 'AI_RESOURCE_LIMIT' ? 'memory-limit' : 'gateway-timeout';
      }
    }
    // Only the checklist/schema is partitioned; no transcript is truncated.
    const answers = [], batches = [];
    const queue = [];
    const groupSize = Math.min(8, Math.ceil(variables.length / 2));
    for (let i = 0; i < variables.length; i += groupSize) queue.push(variables.slice(i, i + groupSize));
    let failure;
    while (queue.length) {
      const group = queue.shift();
      try {
        const answer = await this.#evaluateSingle(conversation, group, options);
        answers.push(answer);
        batches.push({ variableIds: group.map(v => v.id), responseId: answer.responseId, responseField: answer.responseField, reason });
      } catch (error) {
        // A timeout on an already bounded request can be an unavailable
        // runtime. Do not multiply it into a tree of further timed-out calls.
        if (boundedFailure(error) && group.length > 1) {
          const middle = Math.ceil(group.length / 2); queue.unshift(group.slice(0, middle), group.slice(middle)); continue;
        }
        if (!answers.length) throw error;
        failure = { code: error.code }; break;
      }
    }
    const usage = answers.reduce((sum, a) => { for (const [key, n] of Object.entries(a.usage || {})) sum[key] = (sum[key] || 0) + n; return sum; }, {});
    const { runtimeIdentity: _identity, ...last } = answers.at(-1);
    return { ...last, results: answers.flatMap(a => a.results), validationErrors: answers.flatMap(a => a.validationErrors),
      runtimeIdentities: answers.flatMap(a => a.runtimeIdentity ? [a.runtimeIdentity] : []), contextBatches: batches,
      usage: Object.keys(usage).length ? usage : null, ...(failure ? { failure } : {}) };
  }
  async #evaluateSingle(conversation, variables, options) {
    if (!this.configured) throw new AppError(503, 'Falta configurar el modelo local y su herramienta en el Gateway.', 'AI_CONFIGURATION');
    if (!variables.length || variables.some(v => !supportsAiVariable(v))) throw new AppError(422, 'El checklist incluye una variable no admitida por este evaluador.', 'UNSUPPORTED_VARIABLE');
    if (!conversation.messages.length) throw new AppError(422, 'La conversación no tiene mensajes evaluables.', 'EMPTY_CONVERSATION');
    const formatRepair = this.model.startsWith('gemma-') && options?.validationErrors?.some(e => e.rules?.length)
      ? 'status-value-evidence-1' : null;
    // Retry grammar encodes the existing validator contract. It permits all
    // valid decisions, including abstention, and never repairs values in code.
    const schema = this.model === 'clef-flash' || formatRepair ? clefFlashEvaluationSchema(variables, conversation) : evaluationSchema(variables);
    const instructions = this.model === 'clef-flash'
      ? `${evaluationInstructions}\n\n${clefFlashDecisionInstructions}` : evaluationInstructions;
    const messages = [{ role: 'system', content: instructions }];
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
    const runtimeIdentity = payload.model === this.model ? null : await verifyNumberedModelInstance({
      client: this.#client, toolKey: this.toolKey, requested: this.model, returned: payload.model, responseRequestId: envelope.requestId });
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
    if (this.model === 'clef-flash' && emptyContent) {
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
    const validated = validateEvaluation(raw, variables, conversation, { partial: true });
    if (responseField === 'reasoning_content') {
      for (const variable of variables) {
        const item = raw.results[variable.id];
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || !Object.keys(item).some(key => !['status', 'value', 'reason', 'evidence_message_ids'].includes(key))) continue;
        // Reject this item without discarding valid answers for other variables.
        // Only the controlled rule enters retry feedback, never unexpected data.
        validated.results = validated.results.filter(result => result.variableId !== variable.id);
        const existing = validated.validationErrors.find(error => error.variableId === variable.id);
        if (existing) existing.rules.push('unexpected_fields');
        else validated.validationErrors.push({ variableId: variable.id, code: 'INVALID_AI_RESULT',
          rules: ['unexpected_fields'], message: `Respuesta inválida para ${variable.id}: unexpected_fields.` });
      }
    }
    return { ...validated, model: this.model, ...(runtimeIdentity ? { runtimeIdentity } : {}), ...(formatRepair ? { formatRepair } : {}),
      responseId: envelope.requestId, responseField, usage: safeUsage(payload.usage),
      ...(this.outputSchemaVersion ? { outputSchemaVersion: this.outputSchemaVersion } : {}),
      ...(this.decisionInstructionsVersion ? { decisionInstructionsVersion: this.decisionInstructionsVersion } : {}) };
  }
}

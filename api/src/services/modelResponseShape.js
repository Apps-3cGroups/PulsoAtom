const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finishReasons = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call']);

function shape(value) {
  const type = value === undefined ? 'missing' : value === null ? 'null'
    : Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : object(value) ? 'object' : 'other';
  if (typeof value === 'string') return { type, characters: value.length, textParts: value.length ? 1 : 0 };
  if (Array.isArray(value)) {
    const texts = value.flatMap(part => typeof part === 'string' ? [part]
      : object(part) && typeof part.text === 'string' ? [part.text] : []);
    return { type, characters: texts.reduce((total, text) => total + text.length, 0), textParts: texts.length, parts: value.length };
  }
  return { type, characters: 0, textParts: 0 };
}

function jsonShape(value) {
  if (typeof value !== 'string') return { isObject: false, hasResults: false };
  try {
    const parsed = JSON.parse(value);
    return { isObject: object(parsed), hasResults: object(parsed) && Object.hasOwn(parsed, 'results') };
  } catch { return { isObject: false, hasResults: false }; }
}

// Structural diagnostics only. Never return model text, field names taken from
// a response, reasoning, tool arguments, model identity or parsed JSON values.
export function summarizeModelResponse(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const choice = choices[0], message = object(choice?.message) ? choice.message : {};
  const content = jsonShape(message.content), reasoningContent = jsonShape(message.reasoning_content), reasoning = jsonShape(message.reasoning);
  return {
    choicesCount: choices.length,
    content: shape(message.content),
    reasoningContent: shape(message.reasoning_content),
    reasoning: shape(message.reasoning),
    toolCallsCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    refusalPresent: message.refusal !== undefined && message.refusal !== null && message.refusal !== '' && message.refusal !== false,
    finishReason: finishReasons.has(choice?.finish_reason) ? choice.finish_reason : null,
    contentIsJsonObject: content.isObject, contentHasResults: content.hasResults,
    reasoningIsJsonObject: reasoningContent.isObject || reasoning.isObject,
    reasoningHasResults: reasoningContent.hasResults || reasoning.hasResults,
  };
}

const hidden = '[REDACTADO]';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function privateValues(env) {
  const values = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (!/(secret|token|password|passwd|pwd|key|url|host|user|db_?name|database)/i.test(name) || typeof value !== 'string' || value.length < 4) continue;
    values.push(value);
    if (/url/i.test(name)) {
      try { const url = new URL(value); values.push(url.hostname, decodeURIComponent(url.username), decodeURIComponent(url.password)); } catch {}
    }
  }
  return [...new Set(values.filter(value => value.length >= 4))].sort((a, b) => b.length - a.length);
}

function redact(message, values) {
  if (message.length > 32768) return '[Mensaje omitido por longitud]';
  let text = message;
  // Never print embedded requests, generated choices or stack traces even if a
  // provider placed them inside error.message instead of a separate property.
  text = text.replace(/(?:\r?\n)\s*(?:at\s|Traceback\b|File\s+["'])[\s\S]*/i, ' [Detalle omitido]')
    .replace(/\b(?:request\s+body|request\s+payload|stack\s*trace)\s*[:=][\s\S]*/i, '[Detalle omitido]')
    .replace(/["']?(?:request|payload|body|choices|messages|stack)["']?\s*[:=]\s*[\[{][\s\S]*/i, '[Detalle omitido]');
  text = text
    .replace(/\b(?:https?|ftp|mysql|postgres(?:ql)?):\/\/[^\s<>"']+/gi, hidden)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, hidden)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, hidden)
    .replace(/\[?(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]{0,39}\]?/gi, hidden)
    .replace(/(?:[A-Z]:\\(?:Users|Documents and Settings)\\[^\s"'<>]+|\/(?:Users|home|root|(?:private\/)?var\/folders)\/[^\s"'<>]+)/gi, hidden)
    .replace(/\b(?:Bearer|Basic)\s+[A-Z0-9._~+\/-]+=*/gi, hidden)
    .replace(/\b(?:AIza[A-Z0-9_-]{20,}|sk-(?:proj-)?[A-Z0-9_-]{16,}|gh[pousr]_[A-Z0-9_]{16,})\b/gi, hidden)
    .replace(/["']?\b(?:authorization|x-gateway-token|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|base[_-]?url|hostname|host|username|user|db[_-]?name)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '[Campo privado]');
  // Replace known values last: replacing a substring first could split a whole
  // recognizable API key and leave its prefix/suffix visible.
  for (const value of values) text = text.replace(new RegExp(escape(value), 'gi'), hidden);
  return text.trim().slice(0, 800);
}

function layerMessages(layer, values) {
  if (!record(layer)) return [];
  const error = layer.error;
  const candidates = [record(error) ? error.message : error, record(error) ? error.string : null,
    record(error) ? error.detail : null, layer.detail, layer.message];
  return [...new Set(candidates.filter(value => typeof value === 'string' && value.trim())
    .map(value => redact(value, values)).filter(Boolean))].slice(0, 2);
}

/** Diagnostic-only projection; no full response, request, stack or model output. */
export function safeGatewayErrorDetails(envelope, env = {}) {
  const values = privateValues(env);
  return { gateway: layerMessages(envelope, values), upstream: layerMessages(envelope?.response, values) };
}

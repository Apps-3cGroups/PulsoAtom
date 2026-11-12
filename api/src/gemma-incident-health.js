import { AppError } from './errors.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';
import { verifyNumberedModelInstance } from './services/gatewayModelIdentity.js';

// Synthetic availability probe only: it never creates an evaluation or uses
// customer data. Its timeout is separate from the frozen evaluation profile.
export async function assertGemmaIncidentHealth(profile, { token, fetchImpl = fetch } = {}) {
  const adapter = profile.evaluator;
  const client = new GatewayApiClient({ baseUrl: adapter.baseUrl, token,
    portalKey: adapter.portalKey, timeoutMs: 30000, fetchImpl });
  try {
    const answer = await client.invoke({ toolKey: adapter.toolKey, method: 'POST', path: '/v1/chat/completions', operation: 'preflight',
      body: { model: profile.model, messages: [{ role: 'user', content: 'Devuelve solamente el número 1.' }],
        temperature: 0, max_tokens: 16, stream: false } });
    const payload = answer.response;
    if (typeof payload?.model !== 'string' || !payload.model || !Array.isArray(payload.choices) || payload.choices.length !== 1
      || !['stop', 'length'].includes(payload.choices[0]?.finish_reason)) throw new Error('INVALID_HEALTH_RESPONSE');
    if (payload.model !== profile.model) await verifyNumberedModelInstance({ client, toolKey: adapter.toolKey,
      requested: profile.model, returned: payload.model, responseRequestId: answer.requestId });
    return { requestId: answer.requestId, checkedAt: new Date().toISOString() };
  } catch {
    throw new AppError(503, 'Gemma no respondió a la comprobación mínima; la recuperación conserva los pendientes.', 'GEMMA_PROVIDER_UNAVAILABLE');
  }
}

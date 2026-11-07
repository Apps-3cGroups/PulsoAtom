import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeGatewayErrorDetails } from '../src/services/safeGatewayError.js';

test('errors preserve useful literal model and parameter details while redacting both layers', () => {
  const env = { AGENT_SHARED_TOKEN: 'private-gateway-1234', GATEWAY_BASE_URL: 'http://internal.example:9000/api',
    APP_DB_PASSWORD: 'long-private-password', APP_DB_USER: 'privateAdmin', APP_DB_NAME: 'privateDatabase' };
  const output = safeGatewayErrorDetails({ error: { message: 'Model cloudflare_clef rejects parameter response_format at /v1/chat/completions. private-gateway-1234 http://internal.example:9000/api privateAdmin privateDatabase' },
    response: { error: { string: 'max_tokens is invalid. long-private-password Bearer another-private-credential API_KEY="another-secret" 10.252.1.214 ops@example.com /Users/mario/private.env C:\\Users\\mario\\private.env' } } }, env);
  assert.match(output.gateway[0], /Model cloudflare_clef rejects parameter response_format at \/v1\/chat\/completions/);
  assert.match(output.upstream[0], /max_tokens is invalid/);
  const serialized = JSON.stringify(output);
  for (const secret of [...Object.values(env), 'internal.example', 'another-private-credential', 'another-secret', '10.252.1.214', 'ops@example.com', 'mario']) assert.ok(!serialized.includes(secret), secret);
});

test('projection excludes bodies, choices, stack and embedded request bodies, and limits every layer', () => {
  const output = safeGatewayErrorDetails({ error: { message: 'Unsupported response_format\n at privateFunction (/private/code.js:1)', stack: 'STACK_SECRET' },
    detail: 'B'.repeat(900), message: 'third-not-included', request: { token: 'REQUEST_SECRET' },
    response: { error: 'Invalid model. Request body: {"messages":["CONVERSATION_SECRET"]}', detail: 'second error',
      choices: [{ message: { content: 'MODEL_OUTPUT_SECRET' } }] } });
  assert.equal(output.gateway.length, 2);
  assert.equal(output.upstream.length, 2);
  assert.equal(output.gateway[1].length, 800);
  const serialized = JSON.stringify(output);
  for (const value of ['STACK_SECRET', 'REQUEST_SECRET', 'CONVERSATION_SECRET', 'MODEL_OUTPUT_SECRET', 'privateFunction', 'third-not-included']) assert.ok(!serialized.includes(value));
  assert.deepEqual(safeGatewayErrorDetails(null), { gateway: [], upstream: [] });
});

test('overlapping environment secrets redact longest first and unsafe address forms are removed', () => {
  const output = safeGatewayErrorDetails({ message: 'abcdefghij abcdef http://other.internal/path user@example.com [2001:db8::1] api_key=outside-env-secret; /home/private/file',
    response: { error: 'AIzaSySyntheticLongKey123456789012345678 sk-proj-abcdefghijklmnopqrstuv' } },
  { TOKEN: 'abcdef', PASSWORD: 'abcdefghij' });
  const serialized = JSON.stringify(output);
  for (const value of ['abcdefghij', 'abcdef', 'ghij', 'other.internal', 'user@example.com', '2001:db8', 'outside-env-secret', '/home/private', 'AIzaSy', 'sk-proj-']) assert.ok(!serialized.includes(value), value);
});

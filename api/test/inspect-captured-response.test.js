import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarizeCapturedResponse, inspectCapturedResponse } from '../scripts/inspect-captured-response.js';

test('inspects nested and serialized captures without inference, requests, IDs, content or reasoning', () => {
  const secret = 'SYNTHETIC_PRIVATE_VALUE';
  const capture = { httpStatus: 200, requestHash: secret, conversationId: secret,
    envelope: { request_uuid: secret, response: JSON.stringify({ model: secret, choices: [{ finish_reason: 'stop',
      message: { content: '{"results":{}}', reasoning_content: secret, tool_calls: [{ arguments: secret }] } }] }) },
    unrelated: { choices: [{ message: { content: secret } }] } };
  const before = structuredClone(capture), report = summarizeCapturedResponse(capture);
  assert.equal(report.inferenceCount, 0);
  assert.equal(report.httpStatus, 200);
  assert.equal(report.responsesInspected, 1);
  assert.equal(report.responseAvailable, true);
  assert.equal(report.shapes[0].contentHasResults, true);
  assert.equal(report.shapes[0].reasoningContent.characters, secret.length);
  assert.equal(report.shapes[0].toolCallsCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE|requestHash|request_uuid|conversationId/);
  assert.deepEqual(capture, before);
});

test('does not expose provider error strings, arbitrary finish reasons or unexpected HTTP metadata', () => {
  const report = summarizeCapturedResponse({ httpStatus: 'PRIVATE_HTTP', envelope: { error: 'PRIVATE_GATEWAY',
    response: { error: 'PRIVATE_UPSTREAM', choices: [{ finish_reason: 'PRIVATE_FINISH', message: { content: null } }] } } });
  assert.equal(report.gatewayErrorPresent, true);
  assert.equal(report.upstreamErrorPresent, true);
  assert.equal(report.httpStatus, null);
  assert.equal(report.shapes[0].finishReason, null);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.equal(summarizeCapturedResponse({ unexpected: { choices: [] } }).responseAvailable, false);
});

test('limits traversal and deduplicates repeated capture objects without changing input', () => {
  const model = { choices: [{ message: { content: '' } }] };
  assert.equal(summarizeCapturedResponse({ response: model, output: model }).responsesInspected, 1);
  const deep = {};
  let current = deep;
  for (let i = 0; i < 15; i++) current = current.response = {};
  current.choices = [{ message: { content: 'PRIVATE' } }];
  const report = summarizeCapturedResponse(deep);
  assert.equal(report.limited, true);
  assert.equal(report.responseAvailable, false);
});

test('offline file inspection is read only and rejects malformed captures with a safe CLI error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulso-capture-test-'));
  try {
    const file = join(directory, 'synthetic-capture.json');
    const text = JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_PRIVATE_VALUE' } }] });
    await writeFile(file, text);
    const report = await inspectCapturedResponse(file);
    assert.equal(report.responsesInspected, 1);
    assert.equal(await readFile(file, 'utf8'), text);
    await writeFile(file, 'PRIVATE_INVALID_JSON');
    const result = spawnSync(process.execPath, [new URL('../scripts/inspect-captured-response.js', import.meta.url).pathname, '--file', file], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.error, 'CAPTURE_INSPECTION_UNAVAILABLE');
    assert.equal(error.inferenceCount, 0);
    assert.ok(!result.stderr.includes(directory));
    assert.ok(!result.stderr.includes('PRIVATE_INVALID_JSON'));
    await writeFile(file, '[]');
    await assert.rejects(inspectCapturedResponse(file), /CAPTURE_NOT_SUPPORTED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

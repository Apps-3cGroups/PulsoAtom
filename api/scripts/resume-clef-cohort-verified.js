import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';
import { ORIGINAL_GEMMA_MAINTENANCE_ID } from './inspect-clef-cohort.js';

// Replay the exact privately captured failure through the updated parser before
// a new worker is installed. This verification makes no model/network request.
try {
  if (process.argv.length !== 2) throw new Error('INVALID_ARGUMENTS');
  const directory = `/var/www/nodeapps/PulsoAtom/api/.data/clef-cohort-${ORIGINAL_GEMMA_MAINTENANCE_ID}`;
  const names = (await readdir(directory)).filter(name => /^private-error-diagnostic-\d+\.json$/.test(name)).sort();
  if (!names.length) throw new Error('MISSING_CAPTURE');
  const raw = await readFile(`${directory}/${names.at(-1)}`, 'utf8');
  const capture = JSON.parse(raw);
  if (capture.responseStatus !== 200 || capture.body?.upstream_status_code !== 400
    || capture.body?.path !== '/v1/chat/completions' || capture.body?.method !== 'POST') throw new Error('UNEXPECTED_CAPTURE');
  const client = new GatewayApiClient({ baseUrl: 'http://replay.invalid', token: 'synthetic-replay-token', portalKey: 'portal-pulso',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => structuredClone(capture.body) }) });
  let code;
  try { await client.invoke({ toolKey: capture.body.tool_key, method: 'POST', path: '/v1/chat/completions' }); }
  catch (error) { code = error.code; }
  if (code !== 'AI_CONTEXT_LIMIT') throw new Error('CAPTURE_NOT_CLASSIFIED');
  console.log(JSON.stringify({ capturedErrorVerified: true, code, networkRequests: 0, captureHash: createHash('sha256').update(raw).digest('hex') }));
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./start-clef-cohort.js', import.meta.url)), '--resume'],
    { env: process.env, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
} catch (error) {
  console.error(JSON.stringify({ success: false, code: /^[A-Z_]{3,80}$/.test(error.message || '') ? error.message : 'VERIFIED_RESUME_FAILED' }));
  process.exitCode = 1;
}

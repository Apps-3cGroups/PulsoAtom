import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { summarizeModelResponse } from '../src/services/modelResponseShape.js';

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const wrapperFields = ['envelope', 'response', 'response_json', 'response_body', 'output', 'result', 'data'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

/**
 * Inspect structure only: never return text, reasoning, arguments, IDs, model
 * identity, arbitrary field names or provider error strings. This is not an
 * evaluation validator and cannot promote a captured response to a result.
 */
export function summarizeCapturedResponse(capture) {
  const shapes = [], seen = new Set();
  let limited = false, gatewayErrorPresent = false, upstreamErrorPresent = false;
  function inspect(value, depth = 0) {
    if (value == null) return;
    if (depth > 8 || shapes.length >= 10) { limited = true; return; }
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_CAPTURE_BYTES) { limited = true; return; }
      try { inspect(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    if (Object.hasOwn(value, 'error') && value.error != null && value.error !== false && value.error !== '') {
      if (depth <= 1) gatewayErrorPresent = true;
      else upstreamErrorPresent = true;
    }
    if (Array.isArray(value.choices)) { shapes.push(summarizeModelResponse(value)); return; }
    for (const field of wrapperFields) if (Object.hasOwn(value, field)) inspect(value[field], depth + 1);
  }
  inspect(capture);
  return {
    operation: 'inspect-captured-model-response', inferenceCount: 0,
    httpStatus: httpStatus(capture?.httpStatus),
    responseAvailable: shapes.length > 0, responsesInspected: shapes.length,
    gatewayErrorPresent, upstreamErrorPresent, limited, shapes,
  };
}

export async function inspectCapturedResponse(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('CAPTURE_PATH_REQUIRED');
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_CAPTURE_BYTES) throw new Error('CAPTURE_NOT_SUPPORTED');
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BYTES) throw new Error('CAPTURE_NOT_SUPPORTED');
    const capture = JSON.parse(text);
    if (!object(capture)) throw new Error('CAPTURE_NOT_SUPPORTED');
    return summarizeCapturedResponse(capture);
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--file') throw new Error('INVALID_ARGUMENTS');
    console.log(JSON.stringify(await inspectCapturedResponse(process.argv[3]), null, 2));
  } catch {
    // Even filesystem errors can reveal deployment paths: never print them.
    console.error(JSON.stringify({ operation: 'inspect-captured-model-response', inferenceCount: 0, error: 'CAPTURE_INSPECTION_UNAVAILABLE' }));
    process.exitCode = 1;
  }
}

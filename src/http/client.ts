import { resolveTimeoutMs, validateTargetUrl } from './safety.js';

const MAX_BODY_BYTES = 1_048_576;

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowedHostsEnv?: string;
}

export interface SafeFetchResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
  json?: unknown;
  durationMs: number;
  truncated: boolean;
}

/**
 * Executes an HTTP request against a validated target URL with timeout and body-size guards.
 */
export async function safeFetch(
  targetUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const validation = validateTargetUrl(targetUrl, options.allowedHostsEnv);
  if (!validation.valid || !validation.url) {
    throw new Error(validation.reason ?? 'Invalid target URL.');
  }

  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const method = (options.method ?? 'GET').toUpperCase();
  const startedAt = performance.now();

  const response = await fetch(validation.url.toString(), {
    method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });

  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  const truncated = rawBuffer.byteLength > MAX_BODY_BYTES;
  const bodyText = rawBuffer.subarray(0, MAX_BODY_BYTES).toString('utf8');

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let json: unknown;
  const contentType = headers['content-type'] ?? '';
  if (contentType.includes('application/json') || bodyText.trimStart().startsWith('{') || bodyText.trimStart().startsWith('[')) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      // Leave json undefined if payload is malformed JSON
    }
  }

  return {
    url: validation.url.toString(),
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyText,
    json,
    durationMs,
    truncated,
  };
}

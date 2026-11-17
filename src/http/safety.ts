const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30000;

const DEFAULT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
]);

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]);

export interface UrlValidationResult {
  valid: boolean;
  url?: URL;
  reason?: string;
}

/**
 * Resolves and clamps the HTTP request timeout in milliseconds.
 */
export function resolveTimeoutMs(rawTimeout?: number | string): number {
  if (rawTimeout === undefined || rawTimeout === '') {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = typeof rawTimeout === 'number' ? rawTimeout : Number.parseInt(rawTimeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(parsed), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Validates that a target URL uses HTTP(S), does not target cloud metadata endpoints,
 * and belongs to loopback or an explicitly allowlisted host (API_QA_ALLOWED_HOSTS).
 */
export function validateTargetUrl(
  rawUrl: string,
  allowedHostsEnv = process.env.API_QA_ALLOWED_HOSTS,
): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: `Invalid URL: "${rawUrl}".` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: `Unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    return {
      valid: false,
      reason: `Target host "${hostname}" is blocked for SSRF protection.`,
    };
  }

  if (DEFAULT_LOOPBACK_HOSTS.has(hostname)) {
    return { valid: true, url: parsed };
  }

  const allowlist = (allowedHostsEnv ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (allowlist.includes('*') || allowlist.includes(hostname)) {
    return { valid: true, url: parsed };
  }

  return {
    valid: false,
    reason: `Host "${hostname}" is not in loopback or API_QA_ALLOWED_HOSTS.`,
  };
}

/**
 * Redacts sensitive HTTP header values before returning diagnostics to MCP clients.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

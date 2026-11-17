import { safeFetch } from '../http/client.js';
import { redactHeaders } from '../http/safety.js';

export interface AuditHttpSecurityInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  check_unauthenticated?: boolean;
  timeout_ms?: number;
}

export interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  check: string;
  message: string;
}

export interface AuditHttpSecurityResult {
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
  findings: SecurityFinding[];
  passed: boolean;
}

/**
 * Audits HTTP security headers, information-leakage headers, CORS configuration,
 * and optional unauthenticated access on an API endpoint.
 */
export async function executeAuditHttpSecurity(
  input: AuditHttpSecurityInput,
): Promise<AuditHttpSecurityResult> {
  const method = (input.method ?? 'GET').toUpperCase();
  const res = await safeFetch(input.url, {
    method,
    headers: input.headers,
    timeoutMs: input.timeout_ms,
  });

  const findings: SecurityFinding[] = [];
  const h = res.headers;

  if (h['x-content-type-options']?.toLowerCase() !== 'nosniff') {
    findings.push({
      severity: 'medium',
      check: 'x-content-type-options',
      message: 'Missing "X-Content-Type-Options: nosniff" header.',
    });
  }

  if (!h['x-frame-options'] && !h['content-security-policy']) {
    findings.push({
      severity: 'low',
      check: 'clickjacking-headers',
      message: 'Missing both "X-Frame-Options" and "Content-Security-Policy" headers.',
    });
  }

  if (res.url.startsWith('https://') && !h['strict-transport-security']) {
    findings.push({
      severity: 'medium',
      check: 'hsts',
      message: 'HTTPS endpoint is missing "Strict-Transport-Security" header.',
    });
  }

  if (h['x-powered-by']) {
    findings.push({
      severity: 'low',
      check: 'server-fingerprint',
      message: `Header "X-Powered-By: ${h['x-powered-by']}" exposes framework fingerprint.`,
    });
  }

  if (
    h['access-control-allow-origin'] === '*' &&
    h['access-control-allow-credentials']?.toLowerCase() === 'true'
  ) {
    findings.push({
      severity: 'high',
      check: 'cors-wildcard-credentials',
      message:
        'CORS allows wildcard origin "*" together with "Access-Control-Allow-Credentials: true".',
    });
  }

  if (input.check_unauthenticated && input.headers) {
    const strippedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      const lower = k.toLowerCase();
      if (lower !== 'authorization' && lower !== 'x-api-key' && lower !== 'cookie') {
        strippedHeaders[k] = v;
      }
    }

    const unauthRes = await safeFetch(input.url, {
      method: method === 'GET' || method === 'HEAD' ? method : 'GET',
      headers: strippedHeaders,
      timeoutMs: input.timeout_ms,
    });

    if (unauthRes.status >= 200 && unauthRes.status < 300) {
      findings.push({
        severity: 'high',
        check: 'unauthenticated-access',
        message: `Endpoint returned HTTP ${unauthRes.status} when authentication headers were omitted.`,
      });
    }
  }

  return {
    url: res.url,
    status: res.status,
    responseHeaders: redactHeaders(h),
    findings,
    passed: findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length === 0,
  };
}

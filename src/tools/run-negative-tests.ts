import { safeFetch } from '../http/client.js';

export interface RunNegativeTestsInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  valid_payload?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface NegativeCaseResult {
  caseName: string;
  status: number;
  durationMs: number;
  passed: boolean;
  findings: string[];
}

export interface RunNegativeTestsResult {
  url: string;
  method: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: NegativeCaseResult[];
}

const STACK_TRACE_PATTERNS = [
  /at\s+[A-Za-z0-9_$.]+\s+\([^)]+:\d+:\d+\)/,
  /\b(?:TypeError|ReferenceError|SyntaxError|QueryFailedError)\b/,
  /\bSQLSTATE\[[0-9A-Z]+\]/i,
];

function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower !== 'authorization' && lower !== 'x-api-key' && lower !== 'cookie') {
      out[k] = v;
    }
  }
  return out;
}

function buildTypeBrokenPayload(valid: Record<string, unknown>): Record<string, unknown> {
  const mutated: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valid)) {
    if (typeof v === 'string') mutated[k] = 999999;
    else if (typeof v === 'number') mutated[k] = 'not-a-number';
    else if (typeof v === 'boolean') mutated[k] = 'invalid-boolean';
    else mutated[k] = null;
  }
  return mutated;
}

function buildNegativeNumberPayload(valid: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;
  const mutated: Record<string, unknown> = { ...valid };
  for (const [k, v] of Object.entries(valid)) {
    if (typeof v === 'number') {
      mutated[k] = -1;
      changed = true;
    }
  }
  return changed ? mutated : null;
}

function buildOversizedStringPayload(valid: Record<string, unknown>): Record<string, unknown> | null {
  const mutated: Record<string, unknown> = { ...valid };
  for (const [k, v] of Object.entries(valid)) {
    if (typeof v === 'string') {
      mutated[k] = 'A'.repeat(10000);
      return mutated;
    }
  }
  return null;
}

/**
 * Runs deterministic negative and boundary test cases against an API endpoint
 * to catch 5xx crashes and leaked stack traces.
 */
export async function executeRunNegativeTests(
  input: RunNegativeTestsInput,
): Promise<RunNegativeTestsResult> {
  const method = (input.method ?? 'POST').toUpperCase();
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...input.headers,
  };

  interface ProbeCase {
    name: string;
    headers: Record<string, string>;
    body?: string;
  }

  const probes: ProbeCase[] = [
    { name: 'empty_json_body', headers: baseHeaders, body: '{}' },
    { name: 'malformed_json', headers: baseHeaders, body: '{broken-json' },
  ];

  if (input.valid_payload && Object.keys(input.valid_payload).length > 0) {
    probes.push({
      name: 'wrong_field_types',
      headers: baseHeaders,
      body: JSON.stringify(buildTypeBrokenPayload(input.valid_payload)),
    });

    const negNum = buildNegativeNumberPayload(input.valid_payload);
    if (negNum) {
      probes.push({
        name: 'negative_numbers',
        headers: baseHeaders,
        body: JSON.stringify(negNum),
      });
    }

    const oversized = buildOversizedStringPayload(input.valid_payload);
    if (oversized) {
      probes.push({
        name: 'oversized_string_10k',
        headers: baseHeaders,
        body: JSON.stringify(oversized),
      });
    }
  }

  const hasAuthHeader = Object.keys(baseHeaders).some((k) =>
    ['authorization', 'x-api-key', 'cookie'].includes(k.toLowerCase()),
  );
  if (hasAuthHeader) {
    probes.push({
      name: 'missing_auth_headers',
      headers: stripAuthHeaders(baseHeaders),
      body: input.valid_payload ? JSON.stringify(input.valid_payload) : '{}',
    });
  }

  const cases: NegativeCaseResult[] = [];
  for (const probe of probes) {
    const res = await safeFetch(input.url, {
      method,
      headers: probe.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : probe.body,
      timeoutMs: input.timeout_ms,
    });

    const findings: string[] = [];
    if (res.status >= 500) {
      findings.push(`Server returned ${res.status} on negative input instead of 4xx.`);
    }
    if (probe.name === 'missing_auth_headers' && res.status >= 200 && res.status < 300) {
      findings.push(`Endpoint returned ${res.status} without authentication headers.`);
    }
    for (const pattern of STACK_TRACE_PATTERNS) {
      if (pattern.test(res.bodyText)) {
        findings.push('Response body appears to leak internal stack trace or SQL details.');
        break;
      }
    }

    cases.push({
      caseName: probe.name,
      status: res.status,
      durationMs: res.durationMs,
      passed: findings.length === 0,
      findings,
    });
  }

  const passedCases = cases.filter((c) => c.passed).length;
  return {
    url: input.url,
    method,
    totalCases: cases.length,
    passedCases,
    failedCases: cases.length - passedCases,
    cases,
  };
}

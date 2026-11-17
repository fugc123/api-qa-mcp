import { safeFetch } from '../http/client.js';
import {
  parseOpenApiSpec,
  validateAgainstSchema,
  type ContractViolation,
} from '../openapi/parser.js';

export interface CheckContractDriftInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  openapi_url?: string;
  spec_json?: Record<string, unknown>;
  route_path?: string;
  timeout_ms?: number;
}

export interface CheckContractDriftResult {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  matchedRoute?: string;
  expectedSchemaFound: boolean;
  driftDetected: boolean;
  violations: ContractViolation[];
  notes: string[];
}

function matchOpenApiPath(requestPathname: string, specPaths: string[]): string | undefined {
  if (specPaths.includes(requestPathname)) return requestPathname;

  for (const template of specPaths) {
    const regexStr =
      '^' + template.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/') + '$';
    if (new RegExp(regexStr).test(requestPathname)) {
      return template;
    }
  }
  return undefined;
}

/**
 * Sends a live HTTP request and validates the response JSON against its OpenAPI contract schema.
 */
export async function executeCheckContractDrift(
  input: CheckContractDriftInput,
): Promise<CheckContractDriftResult> {
  let rawSpec: unknown = input.spec_json;
  if (!rawSpec && input.openapi_url) {
    const specRes = await safeFetch(input.openapi_url, {
      method: 'GET',
      headers: input.headers,
      timeoutMs: input.timeout_ms,
    });
    if (specRes.status < 200 || specRes.status >= 300 || !specRes.json) {
      throw new Error(`Could not load OpenAPI spec from ${input.openapi_url} (status ${specRes.status}).`);
    }
    rawSpec = specRes.json;
  }

  if (!rawSpec) {
    throw new Error('Provide either spec_json or openapi_url.');
  }

  const parsedSpec = parseOpenApiSpec(rawSpec);
  const method = (input.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = { ...input.headers };
  let serializedBody: string | undefined;

  if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    serializedBody = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['content-type'] = 'application/json';
    }
  }

  const liveRes = await safeFetch(input.url, {
    method,
    headers: reqHeaders,
    body: serializedBody,
    timeoutMs: input.timeout_ms,
  });

  const pathname = input.route_path ?? new URL(liveRes.url).pathname;
  const candidateRoutes = parsedSpec.endpoints
    .filter((e) => e.method === method)
    .map((e) => e.path);

  const matchedRoute = matchOpenApiPath(pathname, candidateRoutes);
  const endpoint = parsedSpec.endpoints.find(
    (e) => e.method === method && e.path === matchedRoute,
  );

  const statusKey = String(liveRes.status);
  const responseSchema =
    endpoint?.responseSchemas[statusKey] ?? endpoint?.responseSchemas['default'];

  if (!endpoint || !responseSchema) {
    return {
      url: liveRes.url,
      method,
      status: liveRes.status,
      durationMs: liveRes.durationMs,
      matchedRoute,
      expectedSchemaFound: false,
      driftDetected: false,
      violations: [],
      notes: [
        endpoint
          ? `Route "${matchedRoute}" has no response schema documented for HTTP ${statusKey}.`
          : `No matching OpenAPI endpoint found for ${method} ${pathname}.`,
      ],
    };
  }

  if (liveRes.json === undefined) {
    return {
      url: liveRes.url,
      method,
      status: liveRes.status,
      durationMs: liveRes.durationMs,
      matchedRoute,
      expectedSchemaFound: true,
      driftDetected: true,
      violations: [
        {
          path: '$',
          expected: 'application/json',
          actual: liveRes.headers['content-type'] ?? 'non-json',
          message: `OpenAPI defines a JSON schema for ${statusKey}, but response was not valid JSON.`,
        },
      ],
      notes: [],
    };
  }

  const violations = validateAgainstSchema(liveRes.json, responseSchema, parsedSpec.rawSpec);
  return {
    url: liveRes.url,
    method,
    status: liveRes.status,
    durationMs: liveRes.durationMs,
    matchedRoute,
    expectedSchemaFound: true,
    driftDetected: violations.length > 0,
    violations,
    notes:
      violations.length === 0
        ? [`Response matches OpenAPI schema for ${method} ${matchedRoute} (${statusKey}).`]
        : [],
  };
}

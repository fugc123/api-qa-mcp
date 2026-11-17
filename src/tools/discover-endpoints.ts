import { safeFetch } from '../http/client.js';
import { parseOpenApiSpec, type EndpointSummary } from '../openapi/parser.js';

export interface DiscoverEndpointsInput {
  base_url?: string;
  openapi_url?: string;
  spec_json?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout_ms?: number;
}

export interface DiscoverEndpointsResult {
  title: string;
  version: string;
  sourceUrl?: string;
  endpointCount: number;
  endpoints: Array<Pick<EndpointSummary, 'method' | 'path' | 'operationId' | 'summary' | 'requiresAuth'>>;
}

const COMMON_SPEC_PATHS = ['/openapi.json', '/swagger.json', '/api-docs-json', '/docs-json', '/api/openapi.json'];

/**
 * Discovers API endpoints from an inline OpenAPI spec, explicit openapi_url, or common spec paths.
 */
export async function executeDiscoverEndpoints(
  input: DiscoverEndpointsInput,
): Promise<DiscoverEndpointsResult> {
  if (input.spec_json) {
    const parsed = parseOpenApiSpec(input.spec_json);
    return {
      title: parsed.title,
      version: parsed.version,
      endpointCount: parsed.endpoints.length,
      endpoints: parsed.endpoints.map(({ method, path, operationId, summary, requiresAuth }) => ({
        method,
        path,
        operationId,
        summary,
        requiresAuth,
      })),
    };
  }

  const candidateUrls: string[] = [];
  if (input.openapi_url) {
    candidateUrls.push(input.openapi_url);
  } else if (input.base_url) {
    const base = input.base_url.replace(/\/+$/, '');
    for (const suffix of COMMON_SPEC_PATHS) {
      candidateUrls.push(`${base}${suffix}`);
    }
  } else {
    throw new Error('Provide one of openapi_url, base_url, or spec_json.');
  }

  let lastError = 'No OpenAPI specification found.';
  for (const url of candidateUrls) {
    try {
      const res = await safeFetch(url, {
        method: 'GET',
        headers: input.headers,
        timeoutMs: input.timeout_ms,
      });
      if (res.status >= 200 && res.status < 300 && res.json) {
        const parsed = parseOpenApiSpec(res.json);
        return {
          title: parsed.title,
          version: parsed.version,
          sourceUrl: url,
          endpointCount: parsed.endpoints.length,
          endpoints: parsed.endpoints.map(({ method, path, operationId, summary, requiresAuth }) => ({
            method,
            path,
            operationId,
            summary,
            requiresAuth,
          })),
        };
      }
      lastError = `GET ${url} returned status ${res.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to discover OpenAPI spec: ${lastError}`);
}

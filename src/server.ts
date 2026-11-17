import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeAuditHttpSecurity } from './tools/audit-http-security.js';
import { executeCheckContractDrift } from './tools/check-contract-drift.js';
import { executeDiscoverEndpoints } from './tools/discover-endpoints.js';
import { executeProbeIdempotencyRace } from './tools/probe-idempotency-race.js';
import { executeRunNegativeTests } from './tools/run-negative-tests.js';

function formatToolResponse(payload: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return formatToolResponse({ error: message }, true);
}

/**
 * Creates and configures the api-qa-mcp server with all 5 backend QA tools.
 */
export function createApiQaServer(): McpServer {
  const server = new McpServer({
    name: 'api-qa-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'discover_endpoints',
    {
      title: 'Discover OpenAPI Endpoints',
      description:
        'Discovers API routes, methods, and auth requirements from an OpenAPI 3.x / Swagger 2.0 spec URL, base URL, or inline JSON.',
      inputSchema: {
        base_url: z.string().optional().describe('Base URL of the API (probes /openapi.json, /swagger.json, etc.).'),
        openapi_url: z.string().optional().describe('Direct URL to the OpenAPI/Swagger JSON document.'),
        spec_json: z.record(z.unknown()).optional().describe('Inline OpenAPI JSON object.'),
        headers: z.record(z.string()).optional().describe('Optional HTTP headers for fetching the spec.'),
        timeout_ms: z.number().int().positive().max(30000).optional(),
      },
    },
    async (args) => {
      try {
        return formatToolResponse(await executeDiscoverEndpoints(args));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'run_negative_tests',
    {
      title: 'Run Negative & Boundary Tests',
      description:
        'Sends malformed JSON, wrong types, negative numbers, oversized strings, and unauthenticated probes to catch 5xx crashes and leaked stack traces.',
      inputSchema: {
        url: z.string().min(1).describe('Full target endpoint URL.'),
        method: z.string().optional().describe('HTTP method (default: POST).'),
        headers: z.record(z.string()).optional().describe('Optional request headers.'),
        valid_payload: z
          .record(z.unknown())
          .optional()
          .describe('Sample valid JSON payload used to generate type-mutated and boundary cases.'),
        timeout_ms: z.number().int().positive().max(30000).optional(),
      },
    },
    async (args) => {
      try {
        const result = await executeRunNegativeTests(args);
        return formatToolResponse(result, result.failedCases > 0);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'check_contract_drift',
    {
      title: 'Check OpenAPI Contract Drift',
      description:
        'Executes a live request against an endpoint and validates the JSON response against its OpenAPI schema.',
      inputSchema: {
        url: z.string().min(1).describe('Full target endpoint URL.'),
        method: z.string().optional().describe('HTTP method (default: GET).'),
        headers: z.record(z.string()).optional().describe('Optional request headers.'),
        body: z.unknown().optional().describe('Optional request body.'),
        openapi_url: z.string().optional().describe('Direct URL to the OpenAPI JSON spec.'),
        spec_json: z.record(z.unknown()).optional().describe('Inline OpenAPI JSON spec.'),
        route_path: z.string().optional().describe('Explicit OpenAPI route template override (e.g. /users/{id}).'),
        timeout_ms: z.number().int().positive().max(30000).optional(),
      },
    },
    async (args) => {
      try {
        const result = await executeCheckContractDrift(args);
        return formatToolResponse(result, result.driftDetected);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'probe_idempotency_race',
    {
      title: 'Probe Idempotency & Concurrency Race',
      description:
        'Dispatches N concurrent identical requests with the same Idempotency-Key to detect duplicate creations or 5xx concurrency errors.',
      inputSchema: {
        url: z.string().min(1).describe('Full target endpoint URL.'),
        method: z.string().optional().describe('HTTP method (default: POST).'),
        headers: z.record(z.string()).optional().describe('Optional request headers.'),
        body: z.unknown().optional().describe('JSON payload sent identically across concurrent requests.'),
        concurrency: z.number().int().min(2).max(20).optional().describe('Concurrent requests count (default: 5, max: 20).'),
        idempotency_key: z.string().optional().describe('Explicit Idempotency-Key header value.'),
        timeout_ms: z.number().int().positive().max(30000).optional(),
      },
    },
    async (args) => {
      try {
        const result = await executeProbeIdempotencyRace(args);
        return formatToolResponse(result, result.potentialRaceDetected);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'audit_http_security',
    {
      title: 'Audit HTTP Security Headers & Auth',
      description:
        'Inspects response security headers, framework fingerprinting, CORS misconfigurations, and optional unauthenticated access.',
      inputSchema: {
        url: z.string().min(1).describe('Full target endpoint URL.'),
        method: z.string().optional().describe('HTTP method (default: GET).'),
        headers: z.record(z.string()).optional().describe('Optional request headers.'),
        check_unauthenticated: z
          .boolean()
          .optional()
          .describe('If true, also probes the endpoint without auth headers.'),
        timeout_ms: z.number().int().positive().max(30000).optional(),
      },
    },
    async (args) => {
      try {
        return formatToolResponse(await executeAuditHttpSecurity(args));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  return server;
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditHttpSecurity } from '../src/tools/audit-http-security.js';
import { executeCheckContractDrift } from '../src/tools/check-contract-drift.js';
import { executeDiscoverEndpoints } from '../src/tools/discover-endpoints.js';
import { executeProbeIdempotencyRace } from '../src/tools/probe-idempotency-race.js';
import { executeRunNegativeTests } from '../src/tools/run-negative-tests.js';

let server: http.Server;
let baseUrl: string;
let raceCounter = 0;

const openApiSpec = {
  openapi: '3.0.3',
  info: { title: 'Test QA API', version: '1.0.0' },
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'total'],
                  properties: {
                    id: { type: 'string' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createOrder',
        security: [{ bearerAuth: [] }],
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openApiSpec));
        return;
      }

      if (req.url === '/orders' && req.method === 'GET') {
        // Intentionally returns total as string instead of integer to trigger contract drift
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-powered-by': 'Express',
        });
        res.end(JSON.stringify({ id: 'ord_1', total: '1500' }));
        return;
      }

      if (req.url === '/orders-valid' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        });
        res.end(JSON.stringify({ id: 'ord_1', total: 1500 }));
        return;
      }

      if (req.url === '/orders' && req.method === 'POST') {
        if (!req.headers.authorization) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
          if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid amount' }));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `ord_${++raceCounter}` }));
        } catch {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('SyntaxError: Unexpected token in JSON at Object.parse (app.js:12:5)');
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('api-qa-mcp tools integration', () => {
  it('discover_endpoints probes /openapi.json from base_url', async () => {
    const res = await executeDiscoverEndpoints({ base_url: baseUrl });
    expect(res.title).toBe('Test QA API');
    expect(res.endpointCount).toBe(2);
    expect(res.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /orders',
      'POST /orders',
    ]);
  });

  it('run_negative_tests catches 500 + stack trace leak on malformed JSON', async () => {
    const res = await executeRunNegativeTests({
      url: `${baseUrl}/orders`,
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      valid_payload: { amount: 100, note: 'ok' },
    });

    expect(res.failedCases).toBe(1);
    const malformed = res.cases.find((c) => c.caseName === 'malformed_json');
    expect(malformed?.passed).toBe(false);
    expect(malformed?.findings.some((f) => f.includes('500'))).toBe(true);
    expect(malformed?.findings.some((f) => f.includes('stack trace'))).toBe(true);
  });

  it('check_contract_drift detects type mismatch against OpenAPI schema', async () => {
    const drift = await executeCheckContractDrift({
      url: `${baseUrl}/orders`,
      method: 'GET',
      openapi_url: `${baseUrl}/openapi.json`,
    });

    expect(drift.expectedSchemaFound).toBe(true);
    expect(drift.driftDetected).toBe(true);
    expect(drift.violations[0].path).toBe('$.total');

    const clean = await executeCheckContractDrift({
      url: `${baseUrl}/orders-valid`,
      method: 'GET',
      route_path: '/orders',
      openapi_url: `${baseUrl}/openapi.json`,
    });
    expect(clean.driftDetected).toBe(false);
  });

  it('probe_idempotency_race flags duplicate 201 creations under concurrency', async () => {
    const res = await executeProbeIdempotencyRace({
      url: `${baseUrl}/orders`,
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: { amount: 500 },
      concurrency: 4,
    });

    expect(res.statusCounts['201']).toBe(4);
    expect(res.potentialRaceDetected).toBe(true);
    expect(res.uniqueResponseBodies).toBe(4);
  });

  it('audit_http_security flags missing security headers and X-Powered-By', async () => {
    const res = await executeAuditHttpSecurity({
      url: `${baseUrl}/orders`,
    });

    expect(res.passed).toBe(false);
    expect(res.findings.some((f) => f.check === 'x-content-type-options')).toBe(true);
    expect(res.findings.some((f) => f.check === 'server-fingerprint')).toBe(true);
  });
});

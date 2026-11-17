import { describe, expect, it } from 'vitest';
import { redactHeaders, resolveTimeoutMs, validateTargetUrl } from '../src/http/safety.js';
import { parseOpenApiSpec, validateAgainstSchema } from '../src/openapi/parser.js';

describe('HTTP safety guardrails', () => {
  it('allows localhost and 127.0.0.1 by default', () => {
    expect(validateTargetUrl('http://localhost:3000/api/health').valid).toBe(true);
    expect(validateTargetUrl('http://127.0.0.1:8080/openapi.json').valid).toBe(true);
  });

  it('blocks cloud metadata and non-allowlisted external hosts', () => {
    expect(validateTargetUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
    expect(validateTargetUrl('https://api.example.com/users', '').valid).toBe(false);
  });

  it('allows external hosts only when explicitly listed in API_QA_ALLOWED_HOSTS', () => {
    expect(validateTargetUrl('https://staging.example.com/health', 'staging.example.com').valid).toBe(true);
  });

  it('rejects non-HTTP protocols', () => {
    expect(validateTargetUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('redacts sensitive headers and clamps timeout', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer secret-token',
      'X-Api-Key': 'key-123',
      'Content-Type': 'application/json',
    });
    expect(redacted.Authorization).toBe('[REDACTED]');
    expect(redacted['X-Api-Key']).toBe('[REDACTED]');
    expect(redacted['Content-Type']).toBe('application/json');

    expect(resolveTimeoutMs(undefined)).toBe(5000);
    expect(resolveTimeoutMs(10)).toBe(100);
    expect(resolveTimeoutMs(999999)).toBe(30000);
  });
});

describe('OpenAPI parser and contract validator', () => {
  const sampleSpec = {
    openapi: '3.0.3',
    info: { title: 'Payments API', version: '1.2.0' },
    components: {
      schemas: {
        TransferResponse: {
          type: 'object',
          required: ['id', 'amount', 'status'],
          properties: {
            id: { type: 'string' },
            amount: { type: 'integer' },
            status: { type: 'string', enum: ['pending', 'settled', 'failed'] },
          },
        },
      },
    },
    paths: {
      '/transfers': {
        post: {
          operationId: 'createTransfer',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount'],
                  properties: { amount: { type: 'integer' } },
                },
              },
            },
          },
          responses: {
            '201': {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TransferResponse' },
                },
              },
            },
          },
        },
      },
    },
  };

  it('parses OpenAPI 3 endpoints and resolves $ref schemas', () => {
    const parsed = parseOpenApiSpec(sampleSpec);
    expect(parsed.title).toBe('Payments API');
    expect(parsed.endpoints).toHaveLength(1);
    expect(parsed.endpoints[0]).toMatchObject({
      path: '/transfers',
      method: 'POST',
      operationId: 'createTransfer',
      requiresAuth: true,
    });
    expect(parsed.endpoints[0].responseSchemas['201'].required).toEqual(['id', 'amount', 'status']);
  });

  it('detects missing fields, type mismatches, and invalid enum values', () => {
    const parsed = parseOpenApiSpec(sampleSpec);
    const schema = parsed.endpoints[0].responseSchemas['201'];

    expect(
      validateAgainstSchema({ id: 'tx_1', amount: 1500, status: 'pending' }, schema, sampleSpec),
    ).toEqual([]);

    const violations = validateAgainstSchema(
      { id: 123, status: 'unknown' },
      schema,
      sampleSpec,
    );
    expect(violations.map((v) => v.path)).toContain('$.amount');
    expect(violations.map((v) => v.path)).toContain('$.id');
    expect(violations.map((v) => v.path)).toContain('$.status');
  });
});

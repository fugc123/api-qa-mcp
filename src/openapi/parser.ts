export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  nullable?: boolean;
  [key: string]: unknown;
}

export interface EndpointSummary {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  requiresAuth: boolean;
  requestBodySchema?: JsonSchema;
  responseSchemas: Record<string, JsonSchema>;
}

export interface ParsedOpenApi {
  title: string;
  version: string;
  endpoints: EndpointSummary[];
  rawSpec: Record<string, unknown>;
}

export interface ContractViolation {
  path: string;
  expected: string;
  actual: string;
  message: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * Resolves a local JSON pointer ($ref like "#/components/schemas/User") inside an OpenAPI spec.
 */
export function resolveSchemaRef(
  schema: JsonSchema | undefined,
  rootSpec: Record<string, unknown>,
  visited = new Set<string>(),
): JsonSchema | undefined {
  if (!schema) return undefined;
  if (!schema.$ref) return schema;
  if (visited.has(schema.$ref)) return schema;
  if (!schema.$ref.startsWith('#/')) return schema;

  visited.add(schema.$ref);
  const segments = schema.$ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = rootSpec;
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in current) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return schema;
    }
  }

  if (current && typeof current === 'object') {
    return resolveSchemaRef(current as JsonSchema, rootSpec, visited);
  }
  return schema;
}

/**
 * Extracts normalized endpoints and schemas from an OpenAPI 3.x or Swagger 2.0 document.
 */
export function parseOpenApiSpec(raw: unknown): ParsedOpenApi {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OpenAPI specification must be a JSON object.');
  }

  const spec = raw as Record<string, unknown>;
  const info = (spec.info as Record<string, unknown> | undefined) ?? {};
  const title = typeof info.title === 'string' ? info.title : 'Untitled API';
  const version = typeof info.version === 'string' ? info.version : 'unknown';
  const globalSecurity = Array.isArray(spec.security) && spec.security.length > 0;
  const paths = (spec.paths as Record<string, Record<string, unknown>> | undefined) ?? {};

  const endpoints: EndpointSummary[] = [];

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const [methodKey, opValue] of Object.entries(pathItem)) {
      const lowerMethod = methodKey.toLowerCase();
      if (!HTTP_METHODS.has(lowerMethod) || !opValue || typeof opValue !== 'object') continue;

      const op = opValue as Record<string, unknown>;
      const opSecurity = Array.isArray(op.security) ? op.security.length > 0 : globalSecurity;

      let requestBodySchema: JsonSchema | undefined;
      const reqBody = op.requestBody as Record<string, unknown> | undefined;
      if (reqBody && typeof reqBody === 'object') {
        const content = reqBody.content as Record<string, Record<string, unknown>> | undefined;
        const jsonMedia = content?.['application/json'];
        if (jsonMedia?.schema && typeof jsonMedia.schema === 'object') {
          requestBodySchema = resolveSchemaRef(jsonMedia.schema as JsonSchema, spec);
        }
      } else if (Array.isArray(op.parameters)) {
        // Swagger 2.0 body parameter fallback
        const bodyParam = op.parameters.find(
          (p) => p && typeof p === 'object' && (p as Record<string, unknown>).in === 'body',
        ) as Record<string, unknown> | undefined;
        if (bodyParam?.schema && typeof bodyParam.schema === 'object') {
          requestBodySchema = resolveSchemaRef(bodyParam.schema as JsonSchema, spec);
        }
      }

      const responseSchemas: Record<string, JsonSchema> = {};
      const responses = (op.responses as Record<string, Record<string, unknown>> | undefined) ?? {};
      for (const [statusCode, respObj] of Object.entries(responses)) {
        if (!respObj || typeof respObj !== 'object') continue;
        const content = respObj.content as Record<string, Record<string, unknown>> | undefined;
        const jsonSchema = content?.['application/json']?.schema ?? respObj.schema;
        if (jsonSchema && typeof jsonSchema === 'object') {
          const resolved = resolveSchemaRef(jsonSchema as JsonSchema, spec);
          if (resolved) responseSchemas[statusCode] = resolved;
        }
      }

      endpoints.push({
        path: routePath,
        method: lowerMethod.toUpperCase(),
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        requiresAuth: opSecurity,
        requestBodySchema,
        responseSchemas,
      });
    }
  }

  return { title, version, endpoints, rawSpec: spec };
}

function describeActualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validates a runtime JSON value against a JSON Schema / OpenAPI Schema object.
 */
export function validateAgainstSchema(
  value: unknown,
  rawSchema: JsonSchema,
  rootSpec: Record<string, unknown> = {},
  jsonPath = '$',
): ContractViolation[] {
  const schema = resolveSchemaRef(rawSchema, rootSpec) ?? rawSchema;
  const violations: ContractViolation[] = [];

  if (value === null) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.nullable === true || allowedTypes.includes('null')) {
      return violations;
    }
    if (schema.type) {
      violations.push({
        path: jsonPath,
        expected: String(schema.type),
        actual: 'null',
        message: `Expected ${String(schema.type)} at ${jsonPath}, got null.`,
      });
      return violations;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push({
      path: jsonPath,
      expected: `enum(${schema.enum.join(', ')})`,
      actual: JSON.stringify(value),
      message: `Value at ${jsonPath} is not in enum [${schema.enum.join(', ')}].`,
    });
  }

  const expectedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];

  if (expectedTypes.length > 0) {
    const actualType = describeActualType(value);
    const matches = expectedTypes.some((t) => {
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      return actualType === t;
    });

    if (!matches) {
      violations.push({
        path: jsonPath,
        expected: expectedTypes.join(' | '),
        actual: actualType,
        message: `Type mismatch at ${jsonPath}: expected ${expectedTypes.join(' | ')}, got ${actualType}.`,
      });
      return violations;
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqField of schema.required) {
        if (!(reqField in record)) {
          violations.push({
            path: `${jsonPath}.${reqField}`,
            expected: 'present',
            actual: 'missing',
            message: `Missing required property "${reqField}" at ${jsonPath}.`,
          });
        }
      }
    }

    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propName in record) {
          violations.push(
            ...validateAgainstSchema(record[propName], propSchema, rootSpec, `${jsonPath}.${propName}`),
          );
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      violations.push(
        ...validateAgainstSchema(item, schema.items as JsonSchema, rootSpec, `${jsonPath}[${index}]`),
      );
    });
  }

  return violations;
}

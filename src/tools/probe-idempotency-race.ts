import { randomUUID } from 'node:crypto';
import { safeFetch } from '../http/client.js';

export interface ProbeIdempotencyRaceInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  concurrency?: number;
  idempotency_key?: string;
  timeout_ms?: number;
}

export interface ProbeIdempotencyRaceResult {
  url: string;
  method: string;
  concurrency: number;
  idempotencyKeyUsed: string;
  statusCounts: Record<string, number>;
  uniqueResponseBodies: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  potentialRaceDetected: boolean;
  warnings: string[];
}

/**
 * Fires N concurrent identical requests with the same Idempotency-Key
 * to surface race conditions, duplicate creations, or 5xx lock errors.
 */
export async function executeProbeIdempotencyRace(
  input: ProbeIdempotencyRaceInput,
): Promise<ProbeIdempotencyRaceResult> {
  const method = (input.method ?? 'POST').toUpperCase();
  const concurrency = Math.min(Math.max(2, Math.floor(input.concurrency ?? 5)), 20);
  const idempotencyKey = input.idempotency_key ?? `qa-race-${randomUUID()}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    ...input.headers,
  };

  const serializedBody =
    input.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : typeof input.body === 'string'
        ? input.body
        : JSON.stringify(input.body);

  const requests = Array.from({ length: concurrency }, () =>
    safeFetch(input.url, {
      method,
      headers,
      body: serializedBody,
      timeoutMs: input.timeout_ms,
    }),
  );

  const responses = await Promise.all(requests);
  const statusCounts: Record<string, number> = {};
  const uniqueBodies = new Set<string>();
  const latencies: number[] = [];

  for (const res of responses) {
    const key = String(res.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    uniqueBodies.add(res.bodyText);
    latencies.push(res.durationMs);
  }

  const createdCount = statusCounts['201'] ?? 0;
  const serverErrors = Object.entries(statusCounts)
    .filter(([code]) => Number(code) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);

  const warnings: string[] = [];
  if (createdCount > 1) {
    warnings.push(
      `Received ${createdCount} HTTP 201 responses for the same Idempotency-Key; endpoint may create duplicate resources under concurrency.`,
    );
  }
  if (uniqueBodies.size > 1 && createdCount + (statusCounts['200'] ?? 0) > 1) {
    warnings.push(
      `Received ${uniqueBodies.size} distinct response payloads across concurrent identical requests.`,
    );
  }
  if (serverErrors > 0) {
    warnings.push(
      `Received ${serverErrors} 5xx server error(s) under ${concurrency}x concurrency (possible lock/unique-constraint unhandled error).`,
    );
  }

  const totalLatency = latencies.reduce((acc, v) => acc + v, 0);

  return {
    url: input.url,
    method,
    concurrency,
    idempotencyKeyUsed: idempotencyKey,
    statusCounts,
    uniqueResponseBodies: uniqueBodies.size,
    minLatencyMs: Math.min(...latencies),
    maxLatencyMs: Math.max(...latencies),
    avgLatencyMs: Number((totalLatency / latencies.length).toFixed(2)),
    potentialRaceDetected: warnings.length > 0,
    warnings,
  };
}

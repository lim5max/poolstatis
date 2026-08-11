import { createHash } from 'node:crypto';

export interface AutomationWorkerOptions {
  batchSize: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  actor: string;
  projectId?: string;
}

export interface WorkerRunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export function retryDelay(options: AutomationWorkerOptions, attemptCount: number): number {
  return Math.min(options.maxRetryMs, options.baseRetryMs * (2 ** Math.max(0, attemptCount - 1)));
}

export function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return fallback;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

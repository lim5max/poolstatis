/**
 * Platform error with a machine code and an agent-facing hint.
 * The hint is part of the product: agents are the primary API consumers,
 * so every 4xx should teach the caller how to fix the call.
 */
export class ApiError extends Error {
  public readonly retryable: boolean | undefined;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryable = typeof details?.retryable === 'boolean' ? details.retryable : undefined;
  }

  toBody(): { error: { code: string; message: string; hint?: string; retryable?: boolean; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (what: string, hint?: string) =>
  new ApiError(404, `${what}_not_found`, `${what.replace(/_/g, ' ')} not found`, hint);

export const badRequest = (code: string, message: string, hint?: string) =>
  new ApiError(400, code, message, hint);

export const unauthorized = (message = 'invalid or missing API key') =>
  new ApiError(401, 'unauthorized', message, 'pass the key as `Authorization: Bearer <token>`');

export const organizationWriteDisabled = () =>
  new ApiError(
    402,
    'organization_write_disabled',
    'writes are disabled for this organization',
    'read access remains available; ask an organization operator to restore writes',
  );

/**
 * Stable database-policy SQLSTATE contract for hosted overlays.
 *
 * Match only dedicated codes. PostgreSQL messages/details are deliberately
 * ignored so a trigger cannot leak tenant data, credentials, or policy
 * implementation details through the public API.
 */
export function databasePolicyError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'PSQ01') {
    return new ApiError(
      402,
      'billing_limit_reached',
      'the accepted event batch would exceed an organization storage policy',
      'reduce the batch or ask an organization operator to change the storage policy',
    );
  }
  if (code === 'PSP01') {
    return new ApiError(
      402,
      'project_limit_reached',
      'the organization project policy does not allow another project',
      'reuse an existing project or ask an organization operator to change the project policy',
    );
  }
  if (code === 'PSO01') {
    return organizationWriteDisabled();
  }
  if (code === 'PSD01') {
    return new ApiError(
      410,
      'project_deleting',
      'project deletion has disabled new writes',
    );
  }
  return null;
}

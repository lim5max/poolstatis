/**
 * Platform error with a machine code and an agent-facing hint.
 * The hint is part of the product: agents are the primary API consumers,
 * so every 4xx should teach the caller how to fix the call.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): { error: { code: string; message: string; hint?: string; retryable?: boolean } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
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

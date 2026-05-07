export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class RetryableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetryableError";
    this.code = code;
  }
}

export class ExternalServiceError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "ExternalServiceError";
    this.code = code;
    this.status = status;
  }
}

export function isRetryableError(error: unknown) {
  return error instanceof RetryableError || error instanceof TimeoutError;
}

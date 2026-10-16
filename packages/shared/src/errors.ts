/**
 * An error with an HTTP status. Thrown by seller handlers to say "I could not deliver";
 * any status >= 400 means the x402 middleware will not settle, so the buyer is not charged.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

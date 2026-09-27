export type GabiroErrorCode = "VALIDATION" | "NOT_FOUND" | "EXISTS" | "CONFLICT" | "CORRUPT" | "UNAVAILABLE";

/** An expected, user-facing error. `message` always says what went wrong and how to fix it. */
export class GabiroError extends Error {
  constructor(
    public readonly code: GabiroErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GabiroError";
  }
}

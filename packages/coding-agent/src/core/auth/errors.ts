/*
 * Host-side ChatGPT auth failure (`LlmException` / `InvalidDataException`
 * semantics, ). `code` the `LlmErrorCodes` vocabulary where
 * applicable (`connection`, `timeout`, `bad-response`) plus the passthrough
 * provider error codes (`invalid_grant`, `server_error`,...) and local
 * validation codes (`invalid-data`, `auth-failed`).
 */
export class ChatGptAuthError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatGptAuthError";
    this.code = code;
    this.status = status;
  }
}

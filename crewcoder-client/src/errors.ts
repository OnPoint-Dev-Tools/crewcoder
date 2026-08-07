export type CrewCoderErrorCode =
  | "ABORTED"
  | "INVALID_ARGUMENT"
  | "INVALID_RESPONSE"
  | "RECONNECT_EXHAUSTED"
  | "REQUEST_FAILED"
  | "SESSION_DISPOSED"
  | "SESSION_RUNNING"
  | "STREAM_DISCONNECTED";

export class CrewCoderError extends Error {
  readonly code: CrewCoderErrorCode;
  readonly cause?: unknown;

  constructor(code: CrewCoderErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "CrewCoderError";
    this.code = code;
    this.cause = options.cause;
  }
}

export class CrewCoderFleetRequestError extends CrewCoderError {
  readonly status: number;
  readonly responseBody: string;
  readonly retryable: boolean;

  constructor(status: number, responseBody: string, statusText = "") {
    const detail = responseBody || statusText || "Request failed";
    super("REQUEST_FAILED", `Fleet request failed (${status}): ${detail}`);
    this.name = "CrewCoderFleetRequestError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export class CrewCoderFleetProtocolError extends CrewCoderError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("INVALID_RESPONSE", message, options);
    this.name = "CrewCoderFleetProtocolError";
  }
}

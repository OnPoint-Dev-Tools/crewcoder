export type CrewCoderErrorCode = "ABORTED" | "INVALID_ARGUMENT" | "INVALID_RESPONSE" | "RECONNECT_EXHAUSTED" | "REQUEST_FAILED" | "SESSION_DISPOSED" | "SESSION_RUNNING" | "STREAM_DISCONNECTED";
export declare class CrewCoderError extends Error {
    readonly code: CrewCoderErrorCode;
    readonly cause?: unknown;
    constructor(code: CrewCoderErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export declare class CrewCoderFleetRequestError extends CrewCoderError {
    readonly status: number;
    readonly responseBody: string;
    readonly retryable: boolean;
    constructor(status: number, responseBody: string, statusText?: string);
}
export declare class CrewCoderFleetProtocolError extends CrewCoderError {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map
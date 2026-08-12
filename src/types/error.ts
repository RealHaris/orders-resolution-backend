export type ErrorCodes = "general" | "user" | "auth" | "rate-limit";

export enum StatusCodes {
  ACCEPTED = 202,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  CONFLICT = 409,
  TOO_MANY_REQUESTS = 429,
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504,
}

export enum ErrorMessage {
  UNEXPECTED_ERROR = "An unexpected error occurred, please try again",
  SERVER_ERROR = "An unexpected server error occurred, please try again",
}

/**
 * Structured error thrown by services and mapped by the global handler.
 */
export class ErrorData {
  errorStackTrace?: unknown;
  msg: string;
  code: ErrorCodes;
  statusCode: StatusCodes;
  logError: boolean = true;
  errorDataObj?: boolean = true;
  errors?: {
    message: string;
    path: string;
    code: string;
  }[];
  /** Remaining dollars allowed when a payment would overpay. */
  maxAllowedAmount?: number;

  /**
   * Creates a structured application error for the global handler.
   * @param msg - User-facing error message
   * @param code - Error category used for logging and client handling
   * @param errorStackTrace - Original error or value for stack logging
   * @param statusCode - HTTP status to return
   * @param logError - Whether the global handler should log this error
   * @param errors - Optional field-level validation errors
   * @param maxAllowedAmount - Remaining dollars allowed when a payment overpays
   */
  constructor(
    msg: string,
    code: ErrorCodes,
    errorStackTrace: unknown,
    statusCode: StatusCodes,
    logError: boolean = true,
    errors?: {
      message: string;
      path: string;
      code: string;
    }[],
    maxAllowedAmount?: number
  ) {
    this.msg = msg;
    this.code = code;
    this.errorStackTrace = errorStackTrace;
    this.statusCode = statusCode;
    this.logError = logError;
    this.errors = errors;
    this.maxAllowedAmount = maxAllowedAmount;
  }
}

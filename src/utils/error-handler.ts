import type { Request, Response } from "express";

import { logger } from "@/config/logger.config";
import type { ErrorData } from "@/types/error";
import { getIPFromReq } from "@/utils/request.utils";

/**
 * Max body size to log (to avoid huge payloads).
 */
const MAX_BODY_LOG_SIZE = 10000;

/**
 * Pick the log level for a handled error based on its HTTP status.
 * @param statusCode - The resolved HTTP status code of the error.
 */
const getLoggerForStatus = (statusCode?: number) => {
  const numericStatus = statusCode ?? 500;
  const isClientError = numericStatus >= 400 && numericStatus < 500;
  return isClientError ? logger.warn.bind(logger) : logger.error.bind(logger);
};

/**
 * Safely extract request body for logging.
 */
const getLoggableBody = (req: Request): unknown => {
  if (!req.body || !["POST", "PUT", "PATCH"].includes(req.method)) {
    return undefined;
  }

  try {
    const bodyStr = JSON.stringify(req.body);
    if (bodyStr.length > MAX_BODY_LOG_SIZE) {
      return "[BODY_TOO_LARGE]";
    }
    return req.body;
  } catch {
    return "[BODY_NOT_SERIALIZABLE]";
  }
};

/**
 * Reads a stack trace from an unknown thrown value when available.
 */
const getErrorStack = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
};

/**
 * Sends a JSON error response and logs according to status.
 */
export const handleError = (req: Request, res: Response, error: ErrorData) => {
  const {
    errorStackTrace,
    statusCode,
    logError,
    errorDataObj,
    code,
    ...props
  } = error as ErrorData;

  const reqId = req.reqId || "N/A";

  if (logError) {
    const errorContext: Record<string, unknown> = {
      reqId,
      code,
      statusCode,
      method: req.method,
      url: req.originalUrl,
      msg: props.msg,
    };

    const ip = getIPFromReq(req);
    if (ip) {
      errorContext.ip = ip;
    }
    const userAgentHeader = req.headers["user-agent"];
    const userAgent = Array.isArray(userAgentHeader)
      ? userAgentHeader[0]
      : userAgentHeader;
    if (userAgent) {
      errorContext.userAgent = userAgent;
    }

    if (req.params && Object.keys(req.params).length > 0) {
      errorContext.params = req.params;
    }
    if (req.query && Object.keys(req.query).length > 0) {
      errorContext.query = req.query;
    }
    const body = getLoggableBody(req);
    if (body) {
      errorContext.body = body;
    }

    if (req.payload?.user) {
      errorContext.user = {
        _id: req.payload.user._id,
        email: req.payload.user.email,
        role: req.payload.user.role,
      };
    }

    const logAtLevel = getLoggerForStatus(statusCode as number | undefined);

    if (errorStackTrace) {
      const stack = getErrorStack(errorStackTrace);
      if (stack) {
        errorContext.stack = stack;
      }
    }
    logAtLevel(errorContext, `Error: ${props.msg}`);
  }

  return res
    .status(statusCode ? parseInt(statusCode.toString(), 10) : 500)
    .json({ ...props, statusCode, reqId });
};

/**
 * Logs an error with proper serialization for ErrorData and Error instances.
 * @param error - The error to log
 * @param name - Descriptive label identifying where the error occurred
 */
export const logError = (error: ErrorData | Error | unknown, name: string) => {
  if (error && typeof error === "object" && "errorDataObj" in error) {
    const { errorStackTrace, statusCode, errorDataObj, code, ...props } =
      error as ErrorData;

    const errorContext: Record<string, unknown> = {
      code,
      statusCode,
      msg: props.msg,
    };

    const logAtLevel = getLoggerForStatus(statusCode as number | undefined);

    if (errorStackTrace) {
      const stack = getErrorStack(errorStackTrace);
      if (stack) {
        errorContext.stack = stack;
      }
    }
    logAtLevel(errorContext, `Error: ${name}`);
  } else {
    logger.error({ err: error }, name);
  }
};

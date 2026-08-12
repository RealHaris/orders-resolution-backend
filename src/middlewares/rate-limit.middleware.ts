import type { NextFunction, Request, Response } from "express";

import { logger } from "@/config/logger.config";
import { RATE_LIMIT_CONFIG } from "@/config/rate-limit.config";
import { rateLimiterProvider } from "@/services/rate-limiting/rate-limiter.provider";
import { StatusCodes } from "@/types/error";
import { handleError } from "@/utils/error-handler";
import { getIPFromReq } from "@/utils/request.utils";

/**
 * Gets rate limit key based on authentication status.
 */
const getRateLimitKey = (req: Request): string => {
  if (req.payload?.user?._id) {
    return `user:${req.payload.user._id}`;
  }

  const ip = getIPFromReq(req);
  if (ip && ip !== "unknown" && ip !== "") {
    return `ip:${ip}`;
  }

  return "";
};

const AUTH_ROUTE_PATTERNS = ["/login", "/signup"];

/**
 * Determines which rate limit rule to apply.
 */
const getRateLimitRule = (req: Request): keyof typeof RATE_LIMIT_CONFIG => {
  const isAuthRoute = AUTH_ROUTE_PATTERNS.some((pattern) =>
    req.path.includes(pattern)
  );
  if (isAuthRoute) {
    return "AUTH_LOGIN_REGISTER";
  }
  return "API_GENERAL";
};

/**
 * Dynamic rate limit middleware. Must run AFTER auth on authenticated routes.
 */
export const dynamicRateLimitMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (process.env.NODE_ENV === "test") {
    return next();
  }
  try {
    const key = getRateLimitKey(req);

    if (!key) {
      logger.warn(
        { path: req.path, reqId: req.reqId },
        "[RateLimit] Unidentifiable client, skipping rate limit"
      );
      return next();
    }

    const ruleName = getRateLimitRule(req);
    const limiter = rateLimiterProvider.getLimiter(ruleName);
    const rateLimitRes = await limiter.consume(key);

    res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG[ruleName].points);
    res.setHeader("X-RateLimit-Remaining", rateLimitRes.remainingPoints);

    next();
  } catch (error: unknown) {
    const rateLimitError = error as { msBeforeNext?: number };

    if (rateLimitError.msBeforeNext !== undefined) {
      const ruleName = getRateLimitRule(req);
      res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG[ruleName].points);
      res.setHeader("X-RateLimit-Remaining", 0);

      return handleError(req, res, {
        code: "rate-limit",
        logError: false,
        msg: "Too many requests, please try again later.",
        statusCode: StatusCodes.TOO_MANY_REQUESTS,
        errorStackTrace: error,
      });
    }

    logger.error({ err: error }, "[RateLimitMiddleware] Unexpected error");
    next();
  }
};

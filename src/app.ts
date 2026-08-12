import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import { logger } from "@/config/logger.config";
import healthEndpoint from "@/routes/health";
import ordersEndpoint from "@/routes/orders";
import usersEndpoint from "@/routes/users";
import { type ErrorData, ErrorMessage, StatusCodes } from "@/types/error";
import { requestIdMiddleware } from "@/utils/auth/auth-utils";
import { handleError } from "@/utils/error-handler";

/**
 * Allows requests with no Origin header or an origin listed in CORS_ORIGINS.
 */
const corsOriginCheck: cors.CorsOptions["origin"] = (origin, callback) => {
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:6010")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin) return callback(null, true);
  if (allowedOrigins.indexOf(origin) === -1) {
    return callback(null, false);
  }
  return callback(null, true);
};

/**
 * Global Express error handler.
 */
const handleErrors = (
  error: unknown,
  req: express.Request,
  res: express.Response,
  _next: express.NextFunction
) => {
  if (error && typeof error === "object" && "errorDataObj" in error) {
    handleError(req, res, error as ErrorData);
    return;
  }

  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "CastError" &&
    "kind" in error &&
    error.kind === "ObjectId"
  ) {
    handleError(req, res, {
      code: "user",
      logError: true,
      msg: "Invalid resource id",
      statusCode: StatusCodes.BAD_REQUEST,
      errorStackTrace: error,
      errorDataObj: true,
    });
    return;
  }

  handleError(req, res, {
    code: "general",
    logError: true,
    msg: ErrorMessage.UNEXPECTED_ERROR,
    statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
    errorStackTrace: error,
  });
};

/**
 * Catch-all 404 for unmatched routes.
 */
const notFoundHandler = (_req: express.Request, res: express.Response) => {
  return res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    statusCode: StatusCodes.NOT_FOUND,
    message: "The requested resource was not found.",
  });
};

/**
 * Builds the Express application without connecting to Mongo or listening.
 */
export const createApp = (): express.Express => {
  const app = express();
  const isProductionEnvironment = process.env.NODE_ENV === "production";

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      frameguard: { action: "deny" },
      hsts: isProductionEnvironment
        ? {
            maxAge: 63_072_000,
            includeSubDomains: true,
          }
        : false,
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
    })
  );
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(
    cors({
      origin: corsOriginCheck,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      maxAge: 600,
      optionsSuccessStatus: 204,
    })
  );
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/health", healthEndpoint);
  app.use("/api/users", usersEndpoint);
  app.use("/api/orders", ordersEndpoint);
  app.use(notFoundHandler);
  app.use(handleErrors);

  logger.debug("Express app created");
  return app;
};

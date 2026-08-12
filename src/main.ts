import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import { Constants } from "@/config/constants";
import { logger } from "@/config/logger.config";
import healthEndpoint from "@/routes/health";
import ordersEndpoint from "@/routes/orders";
import usersEndpoint from "@/routes/users";
import { type ErrorData, ErrorMessage, StatusCodes } from "@/types/error";
import { requestIdMiddleware } from "@/utils/auth/auth-utils";
import { connectToDB } from "@/utils/db/db-conn";
import { handleError } from "@/utils/error-handler";

const app = express();

/**
 * Disable framework fingerprinting response header.
 */
app.disable("x-powered-by");

const isProductionEnvironment = process.env.NODE_ENV === "production";

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

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:6010")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedCorsMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const allowedCorsHeaders = ["Authorization", "Content-Type", "Idempotency-Key"];

/**
 * Allows requests with no Origin header or an origin listed in CORS_ORIGINS.
 */
const corsOriginCheck: cors.CorsOptions["origin"] = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (allowedOrigins.indexOf(origin) === -1) {
    return callback(null, false);
  }
  return callback(null, true);
};

app.use(
  cors({
    origin: corsOriginCheck,
    credentials: true,
    methods: allowedCorsMethods,
    allowedHeaders: allowedCorsHeaders,
    maxAge: 600,
    optionsSuccessStatus: 204,
  })
);

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

connectToDB();
app.use(express.json({ limit: "32kb" }));

app.use("/api/health", healthEndpoint);
app.use("/api/users", usersEndpoint);
app.use("/api/orders", ordersEndpoint);

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

app.use(notFoundHandler);

app.use(handleErrors);

const PORT = process.env.PORT || Constants.DEFAULT_PORT;
app.set("port", PORT);

/** Logs when the HTTP server is listening. */
const onServerListen = () => {
  logger.info(
    {
      environment: process.env.NODE_ENV,
      port: app.get("port"),
    },
    "Express server started"
  );
};

app.listen(PORT, onServerListen);

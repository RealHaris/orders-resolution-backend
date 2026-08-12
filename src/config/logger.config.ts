import pino from "pino";

/**
 * Sensitive keys that should be redacted from logs.
 */
const redactPaths = [
  "password",
  "currentPassword",
  "newPassword",
  "confirmPassword",
  "*.password",
  "user.password",
  "accessToken",
  "refreshToken",
  "secret",
  "apiKey",
  "*.accessToken",
  "*.secret",
  "body.password",
  "body.currentPassword",
  "body.newPassword",
  "body.confirmPassword",
];

const prettyTransport = {
  target: "pino-pretty",
  options: {
    colorize: true,
    ignore: "pid,host,hostname,environment",
    translateTime: "SYS:standard",
  },
};

/**
 * Pino logger. Pretty-print in development; JSON otherwise.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
  formatters: {
    bindings: (bindings) => {
      return {
        pid: bindings.pid,
        host: bindings.hostname,
        environment: process.env.NODE_ENV,
      };
    },
    level: (label, number) => {
      return { level: number, levelName: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    (process.env.NODE_ENV ?? "development") === "development"
      ? prettyTransport
      : undefined,
});

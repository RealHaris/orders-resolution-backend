import type { Request } from "express";

/**
 * Resolves client IP from the request, preferring the first X-Forwarded-For hop.
 */
export const getIPFromReq = (req: Request): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
};

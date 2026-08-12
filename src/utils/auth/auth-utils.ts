import { randomUUID } from "node:crypto";

import type { CookieOptions, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { AuthConfig } from "@/config/auth";
import type { UserRoles } from "@/data/users/user.data";

/**
 * JWT payload stored in the accessToken cookie.
 */
export type JwtUserPayload = {
  user: {
    _id: string;
    email: string;
    role: UserRoles;
  };
};

/**
 * Middleware to attach a unique request ID to each incoming request.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const reqId = randomUUID();
  req.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);
  next();
}

/**
 * Verifies the accessToken cookie and attaches req.payload.
 */
export const accessTokenVerification = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : undefined;
    const accessToken = req.cookies.accessToken || bearerToken;
    if (!accessToken) throw new Error("Unauthorized");

    try {
      const payload = jwt.verify(
        accessToken,
        process.env.JWT_SECRET_KEY as string
      ) as JwtUserPayload;
      if (!payload?.user) throw new Error();
      req.payload = payload;
      return payload;
    } catch {
      res.clearCookie("accessToken");
      throw new Error("Invalid token");
    }
  } catch {
    throw new Error("Unauthorized");
  }
};

/**
 * Middleware factory that verifies the access token and checks the user role.
 * @param allowedRoles - Roles permitted to access the route.
 */
export const roleBasedAccessTokenVerification = (allowedRoles: UserRoles[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await accessTokenVerification(req, res);

      if (!allowedRoles.includes(payload.user.role)) {
        return res
          .status(403)
          .json({ msg: "Forbidden: Insufficient permissions" });
      }

      next();
    } catch {
      return res.status(401).json({ msg: "Unauthorized" });
    }
  };
};

/**
 * Signs a JWT containing _id, email, and role.
 */
export const createJwtToken = (user: {
  _id: string;
  email: string;
  role: UserRoles;
}): string => {
  const payload: JwtUserPayload = {
    user: {
      _id: user._id,
      email: user.email,
      role: user.role,
    },
  };
  return jwt.sign(payload, process.env.JWT_SECRET_KEY as string, {
    expiresIn: AuthConfig.ACCESS_TOKEN_EXPIRES,
  });
};

/**
 * Sets the httpOnly accessToken cookie.
 */
export const createAccessTokenCookie = (res: Response, accessToken: string) => {
  const isDevelopment = process.env.NODE_ENV === "development";
  const cookieOpts: CookieOptions = {
    path: "/",
    maxAge: AuthConfig.COOKIE_MAX_AGE_IN_DAYS * 24 * 60 * 60 * 1000,
    secure: !isDevelopment,
    httpOnly: true,
    sameSite: isDevelopment ? "lax" : "none",
    domain: isDevelopment ? "localhost" : undefined,
  };
  res.cookie("accessToken", accessToken, cookieOpts);
};

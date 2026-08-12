import type { NextFunction, Request, Response } from "express";
import { body } from "express-validator";

import { usersService } from "@/services/users/users.service";
import { createAccessTokenCookie } from "@/utils/auth/auth-utils";
import { validateExpressRequest } from "@/utils/validations/validation.utils";

/**
 * Validation rules for signup.
 */
export const validateSignup = () => [
  body("email")
    .isEmail()
    .withMessage("Email must be a valid email address")
    .normalizeEmail(),
  body("password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be between 8 and 128 characters"),
];

/**
 * Validation rules for login.
 */
export const validateLogin = () => [
  body("email")
    .isEmail()
    .withMessage("Email must be a valid email address")
    .normalizeEmail(),
  body("password").isString().notEmpty().withMessage("Password is required"),
];

/**
 * Controller for user auth endpoints.
 */
class UsersController {
  /**
   * POST /api/users/signup
   */
  async signup(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const { email, password } = req.body as {
        email: string;
        password: string;
      };
      const result = await usersService.signup({ email, password });
      createAccessTokenCookie(res, result.accessToken);
      return res.status(201).json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.accessToken,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/users/login
   */
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const { email, password } = req.body as {
        email: string;
        password: string;
      };
      const result = await usersService.login({ email, password });
      createAccessTokenCookie(res, result.accessToken);
      return res.json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.accessToken,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/users/logout — public; always clears the cookie.
   */
  async logout(_req: Request, res: Response, next: NextFunction) {
    try {
      res.clearCookie("accessToken");
      return res.json({ success: true, data: { msg: "Logged out" } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/users/me
   */
  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.payload.user._id.toString();
      const user = await usersService.me(userId);
      return res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }
}

export const usersController = new UsersController();

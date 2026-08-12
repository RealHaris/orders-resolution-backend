import { Router } from "express";

import {
  usersController,
  validateLogin,
  validateSignup,
} from "@/controllers/users/users.controller";
import { UserRoles } from "@/data/users/user.data";
import { dynamicRateLimitMiddleware } from "@/middlewares/rate-limit.middleware";
import { roleBasedAccessTokenVerification } from "@/utils/auth/auth-utils";

const router = Router();

router.post(
  "/signup",
  dynamicRateLimitMiddleware,
  validateSignup(),
  usersController.signup.bind(usersController)
);

router.post(
  "/login",
  dynamicRateLimitMiddleware,
  validateLogin(),
  usersController.login.bind(usersController)
);

router.post(
  "/logout",
  dynamicRateLimitMiddleware,
  usersController.logout.bind(usersController)
);

router.get(
  "/me",
  roleBasedAccessTokenVerification([UserRoles.USER]),
  dynamicRateLimitMiddleware,
  usersController.me.bind(usersController)
);

export default router;

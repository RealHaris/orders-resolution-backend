import { Router } from "express";

import {
  orderController,
  validateCreateOrder,
  validateCreatePayment,
  validateListOrders,
  validateOrderId,
  validateUpdateOrder,
} from "@/controllers/orders/order.controller";
import { UserRoles } from "@/data/users/user.data";
import { dynamicRateLimitMiddleware } from "@/middlewares/rate-limit.middleware";
import { roleBasedAccessTokenVerification } from "@/utils/auth/auth-utils";

const router = Router();

const authMiddleware = [
  roleBasedAccessTokenVerification([UserRoles.USER]),
  dynamicRateLimitMiddleware,
];

router.post(
  "/",
  ...authMiddleware,
  validateCreateOrder(),
  orderController.create.bind(orderController)
);

router.get(
  "/",
  ...authMiddleware,
  validateListOrders(),
  orderController.list.bind(orderController)
);

router.get(
  "/summary",
  ...authMiddleware,
  orderController.summary.bind(orderController)
);

router.get(
  "/:id",
  ...authMiddleware,
  validateOrderId(),
  orderController.getById.bind(orderController)
);

router.put(
  "/:id",
  ...authMiddleware,
  validateUpdateOrder(),
  orderController.update.bind(orderController)
);

router.delete(
  "/:id",
  ...authMiddleware,
  validateOrderId(),
  orderController.remove.bind(orderController)
);

router.post(
  "/:id/payments",
  ...authMiddleware,
  validateCreatePayment(),
  orderController.addPayment.bind(orderController)
);

export default router;

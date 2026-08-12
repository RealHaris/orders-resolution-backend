import type { NextFunction, Request, Response } from "express";
import { body, header, param, query } from "express-validator";

import { ORDER_CONSTANTS } from "@/constants/order.constants";
import type { OrderStatus } from "@/data/orders/order.data";
import { orderService } from "@/services/orders/order.service";
import { sendExportFile } from "@/utils/export.utils";
import { parsePaginationParams } from "@/utils/pagination.utils";
import { validateExpressRequest } from "@/utils/validations/validation.utils";

const ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "partially_paid",
  "paid",
  "overdue",
];

/**
 * Validation for POST /orders.
 */
export const validateCreateOrder = () => [
  body("customer")
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.MAX_CUSTOMER_LENGTH })
    .withMessage("Customer is required"),
  body("dueDate").isString().withMessage("dueDate is required"),
  body("lineItems")
    .isArray({
      min: ORDER_CONSTANTS.MIN_LINE_ITEMS,
      max: ORDER_CONSTANTS.MAX_LINE_ITEMS,
    })
    .withMessage("Add at least one line item"),
  body("lineItems.*.description")
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.MAX_DESCRIPTION_LENGTH })
    .withMessage("Description is required"),
  body("lineItems.*.quantity")
    .isInt({
      min: ORDER_CONSTANTS.MIN_QUANTITY,
      max: ORDER_CONSTANTS.MAX_QUANTITY,
    })
    .withMessage("Quantity must be at least 1"),
  body("lineItems.*.unitPrice").exists().withMessage("Unit price is required"),
];

/**
 * Validation for GET /orders query.
 */
export const validateListOrders = () => [
  query("pageNum")
    .optional()
    .isInt({ min: 1 })
    .withMessage("pageNum must be an integer of at least 1"),
  query("pageSize")
    .optional()
    .isInt({
      min: ORDER_CONSTANTS.MIN_PAGE_SIZE,
      max: ORDER_CONSTANTS.MAX_PAGE_SIZE,
    })
    .withMessage(
      `pageSize must be between ${ORDER_CONSTANTS.MIN_PAGE_SIZE} and ${ORDER_CONSTANTS.MAX_PAGE_SIZE}`
    ),
  query("status")
    .optional()
    .isIn(ORDER_STATUSES)
    .withMessage(
      "status must be one of: pending, partially_paid, paid, overdue"
    ),
  query("search")
    .optional()
    .isString()
    .trim()
    .isLength({ max: ORDER_CONSTANTS.MAX_CUSTOMER_LENGTH }),
];

/**
 * Validation for :id params.
 */
export const validateOrderId = () => [
  param("id").isMongoId().withMessage("Invalid resource id"),
];

/**
 * Validation for PUT /orders/:id.
 */
export const validateUpdateOrder = () => [
  ...validateOrderId(),
  body("customer")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.MAX_CUSTOMER_LENGTH })
    .withMessage("Customer is required"),
  body("dueDate").optional().isString(),
  body("lineItems")
    .optional()
    .isArray({
      min: ORDER_CONSTANTS.MIN_LINE_ITEMS,
      max: ORDER_CONSTANTS.MAX_LINE_ITEMS,
    })
    .withMessage("Add at least one line item"),
  body("lineItems.*.description")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.MAX_DESCRIPTION_LENGTH }),
  body("lineItems.*.quantity").optional().isInt({
    min: ORDER_CONSTANTS.MIN_QUANTITY,
    max: ORDER_CONSTANTS.MAX_QUANTITY,
  }),
];

/**
 * Validation for POST /orders/:id/payments.
 */
export const validateCreatePayment = () => [
  ...validateOrderId(),
  body("amount").exists().withMessage("Amount is required"),
  body("date").isString().withMessage("date is required"),
  body("note")
    .optional()
    .isString()
    .isLength({ max: ORDER_CONSTANTS.MAX_NOTE_LENGTH }),
  header("idempotency-key")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH }),
];

/**
 * Validation for POST /orders/:id/refunds.
 */
export const validateCreateRefund = () => [
  ...validateOrderId(),
  body("amount").exists().withMessage("Amount is required"),
  body("date").isString().withMessage("date is required"),
  body("note")
    .optional()
    .isString()
    .isLength({ max: ORDER_CONSTANTS.MAX_NOTE_LENGTH }),
  header("idempotency-key")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH }),
];

/**
 * Validation for POST /orders/export.
 */
export const validateExportOrders = () => [
  body("startDate").isString().withMessage("startDate is required"),
  body("endDate").isString().withMessage("endDate is required"),
  body("fileName")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: ORDER_CONSTANTS.MAX_EXPORT_FILENAME_LENGTH }),
];

/**
 * Reads an optional Idempotency-Key header.
 */
const readIdempotencyKey = (req: Request): string | undefined => {
  const rawKey = req.headers["idempotency-key"];
  return typeof rawKey === "string" ? rawKey.trim() || undefined : undefined;
};

/**
 * Controller for order endpoints.
 */
class OrderController {
  /**
   * POST /api/orders
   */
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { customer, dueDate, lineItems } = req.body;
      const data = await orderService.create({
        userId,
        customer,
        dueDate,
        lineItems,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/orders
   */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { pageNum, pageSize } = parsePaginationParams(
        req.query as { pageNum?: string; pageSize?: string }
      );
      const status = req.query.status as OrderStatus | undefined;
      const searchRaw = req.query.search as string | undefined;
      const search = searchRaw?.trim() || undefined;
      const data = await orderService.list({
        userId,
        pageNum,
        pageSize,
        status,
        search,
      });
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/orders/summary
   */
  async summary(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.payload.user._id.toString();
      const data = await orderService.summary(userId);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/orders/:id
   */
  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const data = await orderService.getById(req.params.id, userId);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/orders/:id — partial update.
   */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { customer, dueDate, lineItems } = req.body as {
        customer?: string;
        dueDate?: string;
        lineItems?: unknown;
      };
      const data = await orderService.update(req.params.id, userId, {
        customer,
        dueDate,
        lineItems: lineItems as
          | { description: string; quantity: number; unitPrice: number }[]
          | undefined,
      });
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/orders/:id
   */
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const data = await orderService.remove(req.params.id, userId);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/orders/:id/payments
   */
  async addPayment(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { amount, date, note } = req.body as {
        amount: number | string;
        date: string;
        note?: string;
      };
      const result = await orderService.addPayment({
        orderId: req.params.id,
        userId,
        amount,
        date,
        note,
        idempotencyKey: readIdempotencyKey(req),
      });
      const statusCode = result.created ? 201 : 200;
      return res.status(statusCode).json({ success: true, data: result.order });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/orders/:id/refunds
   */
  async addRefund(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { amount, date, note } = req.body as {
        amount: number | string;
        date: string;
        note?: string;
      };
      const result = await orderService.addRefund({
        orderId: req.params.id,
        userId,
        amount,
        date,
        note,
        idempotencyKey: readIdempotencyKey(req),
      });
      const statusCode = result.created ? 201 : 200;
      return res.status(statusCode).json({ success: true, data: result.order });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/orders/export
   */
  async exportCsv(req: Request, res: Response, next: NextFunction) {
    try {
      validateExpressRequest(req);
      const userId = req.payload.user._id.toString();
      const { startDate, endDate, fileName } = req.body as {
        startDate: string;
        endDate: string;
        fileName?: string;
      };
      const result = await orderService.exportCsv({
        userId,
        startDate,
        endDate,
      });
      return sendExportFile(res, fileName || result.fileName, result.csv);
    } catch (error) {
      next(error);
    }
  }
}

export const orderController = new OrderController();

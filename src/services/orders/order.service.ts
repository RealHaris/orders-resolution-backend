import { Types } from "mongoose";

import { ORDER_CONSTANTS } from "@/constants/order.constants";
import type {
  Order,
  OrderAuditAction,
  OrderAuditEvent,
  OrderLineItem,
  OrderPayment,
  OrderStatus,
  PaymentKind,
} from "@/data/orders/order.data";
import {
  type OrderListFilter,
  orderRepository,
} from "@/repositories/orders/order.repository";
import { ErrorData, StatusCodes } from "@/types/error";
import {
  parseIsoDate,
  startOfTodayUtc,
  startOfUtcDay,
  toIsoString,
} from "@/utils/date.utils";
import { buildExportCsv } from "@/utils/export.utils";
import { centsToDollars, dollarsToCents } from "@/utils/money.utils";
import { toOrderListItem, toOrderResponse } from "@/utils/order-response.utils";
import { amountDueCents, deriveOrderStatus } from "@/utils/order-status.utils";
import { formatPaginatedResponse } from "@/utils/pagination.utils";
import { escapeRegex } from "@/utils/regex.utils";

type LineItemInput = {
  description: string;
  quantity: number;
  unitPrice: number | string;
};

/**
 * Throws 404 when the order is missing or not owned.
 */
const notFound = () =>
  new ErrorData(
    "Order not found",
    "user",
    new Error("Order not found"),
    StatusCodes.NOT_FOUND,
    false
  );

/**
 * Builds an audit event without from/to status (filled by the atomic pipeline).
 */
const mintAuditEvent = (input: {
  action: OrderAuditAction;
  actorUserId: string;
  metadata?: Record<string, unknown>;
}): Omit<OrderAuditEvent, "fromStatus" | "toStatus"> => ({
  _id: new Types.ObjectId().toString(),
  action: input.action,
  actorUserId: input.actorUserId,
  metadata: input.metadata,
  createdAt: new Date(),
});

/**
 * Builds a payment or refund ledger row. Amount is always positive cents.
 */
const mintLedgerEntry = (input: {
  kind: PaymentKind;
  amountCents: number;
  date: Date;
  note?: string;
  idempotencyKey?: string;
}): OrderPayment =>
  ({
    _id: new Types.ObjectId(),
    kind: input.kind,
    amountCents: input.amountCents,
    date: input.date,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date(),
  }) as unknown as OrderPayment;

/**
 * Builds line items and order total in cents from API dollar inputs.
 */
const buildLineItems = (lineItems: LineItemInput[]) => {
  if (
    lineItems.length < ORDER_CONSTANTS.MIN_LINE_ITEMS ||
    lineItems.length > ORDER_CONSTANTS.MAX_LINE_ITEMS
  ) {
    throw new ErrorData(
      "Add at least one line item",
      "user",
      new Error("Invalid line item count"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }

  const built: Omit<OrderLineItem, "_id">[] = [];
  let orderTotalCents = 0;

  for (const item of lineItems) {
    const description = item.description?.trim() ?? "";
    if (!description) {
      throw new ErrorData(
        "Description is required",
        "user",
        new Error("Empty description"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < ORDER_CONSTANTS.MIN_QUANTITY ||
      item.quantity > ORDER_CONSTANTS.MAX_QUANTITY
    ) {
      throw new ErrorData(
        "Quantity must be at least 1",
        "user",
        new Error("Invalid quantity"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }
    const unitPriceCents = dollarsToCents(item.unitPrice);
    if (
      unitPriceCents < ORDER_CONSTANTS.MIN_UNIT_PRICE_CENTS ||
      unitPriceCents > ORDER_CONSTANTS.MAX_UNIT_PRICE_CENTS
    ) {
      throw new ErrorData(
        "Unit price must be at least 0.01 with at most 2 decimal places",
        "user",
        new Error("Invalid unit price"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }
    const lineTotalCents = item.quantity * unitPriceCents;
    orderTotalCents += lineTotalCents;
    built.push({
      description,
      quantity: item.quantity,
      unitPriceCents,
      lineTotalCents,
    });
  }

  return { lineItems: built, orderTotalCents };
};

/**
 * Maps list status query to a Mongo filter (always includes userId).
 */
const buildListFilter = (input: {
  userId: string;
  status?: OrderStatus;
  search?: string;
}): OrderListFilter => {
  const today = startOfTodayUtc();
  const filter: OrderListFilter = { userId: input.userId };

  if (input.search) {
    filter.customer = {
      $regex: escapeRegex(input.search),
      $options: "i",
    };
  }

  if (!input.status) {
    return filter;
  }

  if (input.status === "paid") {
    filter.paymentStatus = "paid";
  } else if (input.status === "pending") {
    filter.paymentStatus = "pending";
    filter.dueDate = { $gte: today };
  } else if (input.status === "partially_paid") {
    filter.paymentStatus = "partially_paid";
    filter.dueDate = { $gte: today };
  } else if (input.status === "overdue") {
    filter.paymentStatus = { $ne: "paid" };
    filter.dueDate = { $lt: today };
  }

  return filter;
};

/**
 * Interprets a failed atomic payment write using a follow-up read.
 */
const throwFromFailedPayment = (order: Order | null): never => {
  if (!order) {
    throw notFound();
  }
  if ((order.payments?.length ?? 0) >= ORDER_CONSTANTS.MAX_PAYMENTS) {
    throw new ErrorData(
      `This order has reached the maximum number of payments (${ORDER_CONSTANTS.MAX_PAYMENTS}).`,
      "user",
      new Error("Payment cap"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
  const remaining = amountDueCents(order);
  const maxAllowedAmount = centsToDollars(Math.max(remaining, 0));
  if (remaining <= 0) {
    throw new ErrorData(
      "This order is already fully paid. Maximum allowed amount is 0.00.",
      "user",
      new Error("Already paid"),
      StatusCodes.BAD_REQUEST,
      false,
      undefined,
      0
    );
  }
  throw new ErrorData(
    `Payment exceeds the remaining balance. Maximum allowed amount is ${maxAllowedAmount}.`,
    "user",
    new Error("Overpay"),
    StatusCodes.BAD_REQUEST,
    false,
    undefined,
    maxAllowedAmount
  );
};

/**
 * Interprets a failed atomic refund write using a follow-up read.
 */
const throwFromFailedRefund = (order: Order | null): never => {
  if (!order) {
    throw notFound();
  }
  if ((order.payments?.length ?? 0) >= ORDER_CONSTANTS.MAX_PAYMENTS) {
    throw new ErrorData(
      `This order has reached the maximum number of payments (${ORDER_CONSTANTS.MAX_PAYMENTS}).`,
      "user",
      new Error("Payment cap"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
  const maxAllowedAmount = centsToDollars(Math.max(order.amountPaidCents, 0));
  if (order.amountPaidCents <= 0) {
    throw new ErrorData(
      "This order has no paid amount to refund. Maximum allowed amount is 0.00.",
      "user",
      new Error("Nothing to refund"),
      StatusCodes.BAD_REQUEST,
      false,
      undefined,
      0
    );
  }
  throw new ErrorData(
    `Refund exceeds the amount paid. Maximum allowed amount is ${maxAllowedAmount}.`,
    "user",
    new Error("Over-refund"),
    StatusCodes.BAD_REQUEST,
    false,
    undefined,
    maxAllowedAmount
  );
};

/**
 * Shared date validation for payments and refunds.
 */
const parseLedgerDate = (value: string): Date => {
  const parsedDate = parseIsoDate(value);
  if (startOfUtcDay(parsedDate) > startOfTodayUtc()) {
    throw new ErrorData(
      "Date cannot be in the future",
      "user",
      new Error("Future date"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
  return parsedDate;
};

/**
 * Resolves an idempotent ledger replay or mismatch after a failed atomic write.
 */
const resolveIdempotentReplay = (
  existing: Order,
  input: {
    amountCents: number;
    parsedDate: Date;
    idempotencyKey: string;
    kind: PaymentKind;
  }
): { created: false; order: ReturnType<typeof toOrderResponse> } | null => {
  const prior = existing.payments?.find(
    (p) => p.idempotencyKey === input.idempotencyKey
  );
  if (!prior) {
    return null;
  }
  const sameKind = (prior.kind ?? "payment") === input.kind;
  const sameAmount = prior.amountCents === input.amountCents;
  const sameDay =
    startOfUtcDay(prior.date).getTime() ===
    startOfUtcDay(input.parsedDate).getTime();
  if (sameKind && sameAmount && sameDay) {
    return {
      created: false as const,
      order: toOrderResponse(existing),
    };
  }
  throw new ErrorData(
    "This idempotency key was already used with a different payment.",
    "user",
    new Error("Idempotency mismatch"),
    StatusCodes.CONFLICT,
    false
  );
};

/**
 * Service for order CRUD, payments, refunds, and CSV export.
 */
export class OrderService {
  /**
   * Creates an order with computed line totals and an initial audit event.
   */
  async create(input: {
    userId: string;
    customer: string;
    dueDate: string;
    lineItems: LineItemInput[];
  }) {
    const customer = input.customer.trim();
    if (!customer) {
      throw new ErrorData(
        "Customer is required",
        "user",
        new Error("Empty customer"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }
    const dueDate = parseIsoDate(input.dueDate);
    const { lineItems, orderTotalCents } = buildLineItems(input.lineItems);
    const toStatus = deriveOrderStatus({
      amountPaidCents: 0,
      orderTotalCents,
      dueDate,
    });
    const createdAt = new Date();
    const order = await orderRepository.create({
      userId: input.userId,
      customer,
      dueDate,
      lineItems,
      orderTotalCents,
      auditEvent: {
        _id: new Types.ObjectId().toString(),
        action: "order.created",
        toStatus,
        actorUserId: input.userId,
        createdAt,
      },
    });
    return toOrderResponse(order);
  }

  /**
   * Paginated dashboard list.
   */
  async list(input: {
    userId: string;
    pageNum: number;
    pageSize: number;
    status?: OrderStatus;
    search?: string;
  }) {
    const filter = buildListFilter({
      userId: input.userId,
      status: input.status,
      search: input.search,
    });
    const { items, total } = await orderRepository.listForUser({
      filter,
      skip: input.pageNum * input.pageSize,
      pageSize: input.pageSize,
    });
    const list = items.map((order) => toOrderListItem(order));
    return formatPaginatedResponse(list, total, input.pageNum, input.pageSize);
  }

  /**
   * Status counts for filter tabs.
   */
  async summary(userId: string) {
    return orderRepository.countSummary(userId, startOfTodayUtc());
  }

  /**
   * Full order detail including line items, payments, and audit log.
   */
  async getById(orderId: string, userId: string) {
    const order = await orderRepository.findByIdAndUser(orderId, userId);
    if (!order) {
      throw notFound();
    }
    return toOrderResponse(order);
  }

  /**
   * Partial update. Line items are rejected after the first payment or refund.
   */
  async update(
    orderId: string,
    userId: string,
    input: {
      customer?: string;
      dueDate?: string;
      lineItems?: LineItemInput[];
    }
  ) {
    const hasCustomer = input.customer !== undefined;
    const hasDueDate = input.dueDate !== undefined;
    const hasLineItems = input.lineItems !== undefined;

    if (!hasCustomer && !hasDueDate && !hasLineItems) {
      throw new ErrorData(
        "Provide at least one of: customer, dueDate, lineItems",
        "user",
        new Error("Empty update"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    let customer: string | undefined;
    if (hasCustomer) {
      customer = input.customer.trim();
      if (!customer) {
        throw new ErrorData(
          "Customer is required",
          "user",
          new Error("Empty customer"),
          StatusCodes.BAD_REQUEST,
          false
        );
      }
    }

    const dueDate = hasDueDate ? parseIsoDate(input.dueDate) : undefined;
    const today = startOfTodayUtc();
    const changedFields = [
      hasCustomer ? "customer" : null,
      hasDueDate ? "dueDate" : null,
      hasLineItems ? "lineItems" : null,
    ].filter(Boolean);
    const auditEvent = mintAuditEvent({
      action: "order.updated",
      actorUserId: userId,
      metadata: { fields: changedFields },
    });

    if (hasLineItems) {
      const { lineItems, orderTotalCents } = buildLineItems(input.lineItems);
      const updated = await orderRepository.replaceLineItemsIfUnpaid({
        orderId,
        userId,
        customer,
        dueDate,
        lineItems,
        orderTotalCents,
        auditEvent,
        today,
      });
      if (updated) {
        return toOrderResponse(updated);
      }
      const existing = await orderRepository.findByIdAndUser(orderId, userId);
      if (!existing) {
        throw notFound();
      }
      throw new ErrorData(
        "Line items cannot be changed after a payment has been recorded",
        "user",
        new Error("Has payments"),
        StatusCodes.CONFLICT,
        false
      );
    }

    const updated = await orderRepository.updateCustomerAndDueDate({
      orderId,
      userId,
      customer,
      dueDate,
      auditEvent,
      today,
    });
    if (!updated) {
      throw notFound();
    }
    return toOrderResponse(updated);
  }

  /**
   * Deletes an order that has no payments or refunds.
   */
  async remove(orderId: string, userId: string) {
    const deleted = await orderRepository.deleteIfUnpaid(orderId, userId);
    if (deleted) {
      return { deleted: true };
    }
    const existing = await orderRepository.findByIdAndUser(orderId, userId);
    if (!existing) {
      throw notFound();
    }
    throw new ErrorData(
      "Orders with payments cannot be deleted",
      "user",
      new Error("Has payments"),
      StatusCodes.CONFLICT,
      false
    );
  }

  /**
   * Records a payment atomically. Optional idempotency key prevents double-submit.
   */
  async addPayment(input: {
    orderId: string;
    userId: string;
    amount: number | string;
    date: string;
    note?: string;
    idempotencyKey?: string;
  }) {
    const amountCents = dollarsToCents(input.amount);
    if (amountCents < ORDER_CONSTANTS.MIN_PAYMENT_CENTS) {
      throw new ErrorData(
        "Amount must be at least 0.01",
        "user",
        new Error("Amount too small"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    const parsedDate = parseLedgerDate(input.date);
    const note = input.note?.trim() || undefined;
    const payment = mintLedgerEntry({
      kind: "payment",
      amountCents,
      date: parsedDate,
      note,
      idempotencyKey: input.idempotencyKey,
    });
    const today = startOfTodayUtc();
    const auditEvent = mintAuditEvent({
      action: "payment.recorded",
      actorUserId: input.userId,
      metadata: { amount: centsToDollars(amountCents) },
    });

    if (input.idempotencyKey) {
      const updated = await orderRepository.addPaymentIfAffordableIdempotent({
        orderId: input.orderId,
        userId: input.userId,
        payment,
        amountCents,
        idempotencyKey: input.idempotencyKey,
        auditEvent,
        today,
      });
      if (updated) {
        return { created: true as const, order: toOrderResponse(updated) };
      }

      const existing = await orderRepository.findByIdAndUser(
        input.orderId,
        input.userId
      );
      if (!existing) {
        throw notFound();
      }
      const replay = resolveIdempotentReplay(existing, {
        amountCents,
        parsedDate,
        idempotencyKey: input.idempotencyKey,
        kind: "payment",
      });
      if (replay) {
        return replay;
      }
      throwFromFailedPayment(existing);
    }

    const updated = await orderRepository.addPaymentIfAffordable({
      orderId: input.orderId,
      userId: input.userId,
      payment,
      amountCents,
      auditEvent,
      today,
    });
    if (updated) {
      return { created: true as const, order: toOrderResponse(updated) };
    }
    const existing = await orderRepository.findByIdAndUser(
      input.orderId,
      input.userId
    );
    throwFromFailedPayment(existing);
  }

  /**
   * Records a refund atomically against net paid. Amount is always positive.
   */
  async addRefund(input: {
    orderId: string;
    userId: string;
    amount: number | string;
    date: string;
    note?: string;
    idempotencyKey?: string;
  }) {
    const amountCents = dollarsToCents(input.amount);
    if (amountCents < ORDER_CONSTANTS.MIN_REFUND_CENTS) {
      throw new ErrorData(
        "Amount must be at least 0.01",
        "user",
        new Error("Amount too small"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    const parsedDate = parseLedgerDate(input.date);
    const note = input.note?.trim() || undefined;
    const refund = mintLedgerEntry({
      kind: "refund",
      amountCents,
      date: parsedDate,
      note,
      idempotencyKey: input.idempotencyKey,
    });
    const today = startOfTodayUtc();
    const auditEvent = mintAuditEvent({
      action: "refund.recorded",
      actorUserId: input.userId,
      metadata: { amount: centsToDollars(amountCents) },
    });

    if (input.idempotencyKey) {
      const updated = await orderRepository.addRefundIfAffordableIdempotent({
        orderId: input.orderId,
        userId: input.userId,
        refund,
        amountCents,
        idempotencyKey: input.idempotencyKey,
        auditEvent,
        today,
      });
      if (updated) {
        return { created: true as const, order: toOrderResponse(updated) };
      }

      const existing = await orderRepository.findByIdAndUser(
        input.orderId,
        input.userId
      );
      if (!existing) {
        throw notFound();
      }
      const replay = resolveIdempotentReplay(existing, {
        amountCents,
        parsedDate,
        idempotencyKey: input.idempotencyKey,
        kind: "refund",
      });
      if (replay) {
        return replay;
      }
      throwFromFailedRefund(existing);
    }

    const updated = await orderRepository.addRefundIfAffordable({
      orderId: input.orderId,
      userId: input.userId,
      refund,
      amountCents,
      auditEvent,
      today,
    });
    if (updated) {
      return { created: true as const, order: toOrderResponse(updated) };
    }
    const existing = await orderRepository.findByIdAndUser(
      input.orderId,
      input.userId
    );
    throwFromFailedRefund(existing);
  }

  /**
   * Builds a CSV of this user's orders in a createdAt date range.
   */
  async exportCsv(input: {
    userId: string;
    startDate: string;
    endDate: string;
  }): Promise<{ csv: string; fileName: string }> {
    const start = startOfUtcDay(parseIsoDate(input.startDate));
    const endExclusive = startOfUtcDay(parseIsoDate(input.endDate));
    const end = new Date(endExclusive.getTime() + 24 * 60 * 60 * 1000 - 1);

    if (start.getTime() > endExclusive.getTime()) {
      throw new ErrorData(
        "startDate must be on or before endDate",
        "user",
        new Error("Invalid date range"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    const orders = await orderRepository.listForExport({
      userId: input.userId,
      start,
      end,
      limit: ORDER_CONSTANTS.EXPORT_MAX_ROWS + 1,
    });

    if (orders.length > ORDER_CONSTANTS.EXPORT_MAX_ROWS) {
      throw new ErrorData(
        `Export is limited to ${ORDER_CONSTANTS.EXPORT_MAX_ROWS} orders. Narrow the date range.`,
        "user",
        new Error("Export cap"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    const now = new Date();
    const rows = orders.map((order) => {
      const mapped = toOrderListItem(order, now);
      return {
        id: mapped._id,
        customer: mapped.customer,
        status: mapped.status,
        dueDate: mapped.dueDate,
        orderTotal: mapped.orderTotal,
        amountPaid: mapped.amountPaid,
        amountDue: mapped.amountDue,
        createdAt: mapped.createdAt,
      };
    });

    const startLabel = toIsoString(start).slice(0, 10);
    const endLabel = toIsoString(endExclusive).slice(0, 10);
    return {
      csv: buildExportCsv(rows),
      fileName: `orders-${startLabel}-to-${endLabel}`,
    };
  }
}

export const orderService = new OrderService();

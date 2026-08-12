import { Types } from "mongoose";

import { ORDER_CONSTANTS } from "@/constants/order.constants";
import type {
  Order,
  OrderLineItem,
  OrderPayment,
  OrderStatus,
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
} from "@/utils/date.utils";
import { centsToDollars, dollarsToCents } from "@/utils/money.utils";
import { toOrderListItem, toOrderResponse } from "@/utils/order-response.utils";
import { amountDueCents } from "@/utils/order-status.utils";
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
 * Service for order CRUD and payment recording.
 */
export class OrderService {
  /**
   * Creates an order with computed line totals.
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
    const order = await orderRepository.create({
      userId: input.userId,
      customer,
      dueDate,
      lineItems,
      orderTotalCents,
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
   * Full order detail including line items and payments.
   */
  async getById(orderId: string, userId: string) {
    const order = await orderRepository.findByIdAndUser(orderId, userId);
    if (!order) {
      throw notFound();
    }
    return toOrderResponse(order);
  }

  /**
   * Partial update. Line items are rejected after the first payment.
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

    if (hasLineItems) {
      const { lineItems, orderTotalCents } = buildLineItems(input.lineItems);
      const updated = await orderRepository.replaceLineItemsIfUnpaid({
        orderId,
        userId,
        customer,
        dueDate,
        lineItems,
        orderTotalCents,
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
    });
    if (!updated) {
      throw notFound();
    }
    return toOrderResponse(updated);
  }

  /**
   * Deletes an order that has no payments.
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

    const parsedDate = parseIsoDate(input.date);
    if (startOfUtcDay(parsedDate) > startOfTodayUtc()) {
      throw new ErrorData(
        "Payment date cannot be in the future",
        "user",
        new Error("Future payment date"),
        StatusCodes.BAD_REQUEST,
        false
      );
    }

    const note = input.note?.trim() || undefined;
    const payment = {
      _id: new Types.ObjectId(),
      amountCents,
      date: parsedDate,
      note,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    } as unknown as OrderPayment;

    if (input.idempotencyKey) {
      const updated = await orderRepository.addPaymentIfAffordableIdempotent({
        orderId: input.orderId,
        userId: input.userId,
        payment,
        amountCents,
        idempotencyKey: input.idempotencyKey,
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
      const prior = existing.payments?.find(
        (p) => p.idempotencyKey === input.idempotencyKey
      );
      if (prior) {
        const sameAmount = prior.amountCents === amountCents;
        const sameDay =
          startOfUtcDay(prior.date).getTime() ===
          startOfUtcDay(parsedDate).getTime();
        if (sameAmount && sameDay) {
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
      }
      throwFromFailedPayment(existing);
    }

    const updated = await orderRepository.addPaymentIfAffordable({
      orderId: input.orderId,
      userId: input.userId,
      payment,
      amountCents,
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
}

export const orderService = new OrderService();

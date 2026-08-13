import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";

import { ORDER_CONSTANTS } from "@/constants/order.constants";
import type {
  Order,
  OrderAuditEvent,
  OrderLineItem,
  OrderPayment,
} from "@/data/orders/order.data";
import { OrderModel } from "@/models/orders/order.model";

export type OrderListFilter = FilterQuery<Order>;

export type OrderSummaryCounts = {
  all: number;
  pending: number;
  partially_paid: number;
  paid: number;
  overdue: number;
};

/**
 * Remaining-balance and payment-cap $expr used by atomic payment updates.
 * Mongo serializes writes to this one document, so two concurrent pays cannot
 * both match; the loser is rejected without a Redis/SQL lock.
 */
const affordableExpr = (amountCents: number) => ({
  $and: [
    {
      $lte: [{ $add: ["$amountPaidCents", amountCents] }, "$orderTotalCents"],
    },
    {
      $lt: [{ $size: "$payments" }, ORDER_CONSTANTS.MAX_PAYMENTS],
    },
  ],
});

/**
 * Net-paid and ledger-cap $expr used by atomic refund updates.
 * Same single-document serialization as payments: concurrent refunds cannot
 * drive amountPaidCents below zero.
 */
const refundableExpr = (amountCents: number) => ({
  $and: [
    { $gte: ["$amountPaidCents", amountCents] },
    {
      $lt: [{ $size: "$payments" }, ORDER_CONSTANTS.MAX_PAYMENTS],
    },
  ],
});

/**
 * Derives API status from an amount-paid expression and the document dueDate.
 */
const derivedStatusExpr = (amountPaidExpr: unknown, today: Date) => ({
  $cond: [
    { $gte: [amountPaidExpr, "$orderTotalCents"] },
    "paid",
    {
      $cond: [
        { $lt: ["$dueDate", today] },
        "overdue",
        {
          $cond: [{ $gt: [amountPaidExpr, 0] }, "partially_paid", "pending"],
        },
      ],
    },
  ],
});

/**
 * Stored paymentStatus after a net-paid change (overdue is never persisted).
 */
const storedPaymentStatusExpr = (amountPaidExpr: unknown) => ({
  $cond: [
    { $gte: [amountPaidExpr, "$orderTotalCents"] },
    "paid",
    {
      $cond: [{ $gt: [amountPaidExpr, 0] }, "partially_paid", "pending"],
    },
  ],
});

/**
 * Appends an audit event and keeps the newest MAX_AUDIT_EVENTS entries.
 */
const concatAuditLog = (
  event: Omit<OrderAuditEvent, "fromStatus" | "toStatus">,
  fromStatusExpr: unknown,
  toStatusExpr: unknown
) => ({
  $slice: [
    {
      $concatArrays: [
        { $ifNull: ["$auditLog", [] as unknown[]] },
        [
          {
            _id: event._id,
            action: event.action,
            fromStatus: fromStatusExpr,
            toStatus: toStatusExpr,
            actorUserId: event.actorUserId,
            metadata: event.metadata,
            createdAt: event.createdAt,
          },
        ],
      ],
    },
    -ORDER_CONSTANTS.MAX_AUDIT_EVENTS,
  ],
});

/**
 * Pipeline that increments paid amount, appends the payment, sets status, and audits.
 */
const paymentUpdatePipeline = (
  payment: OrderPayment,
  amountCents: number,
  auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">,
  today: Date
) => {
  const nextPaid = { $add: ["$amountPaidCents", amountCents] };
  return [
    {
      $set: {
        amountPaidCents: nextPaid,
        payments: { $concatArrays: ["$payments", [payment]] },
        paymentStatus: storedPaymentStatusExpr(nextPaid),
        auditLog: concatAuditLog(
          auditEvent,
          derivedStatusExpr("$amountPaidCents", today),
          derivedStatusExpr(nextPaid, today)
        ),
      },
    },
  ];
};

/**
 * Pipeline that decrements paid amount, appends the refund, sets status, and audits.
 */
const refundUpdatePipeline = (
  refund: OrderPayment,
  amountCents: number,
  auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">,
  today: Date
) => {
  const nextPaid = { $subtract: ["$amountPaidCents", amountCents] };
  return [
    {
      $set: {
        amountPaidCents: nextPaid,
        payments: { $concatArrays: ["$payments", [refund]] },
        paymentStatus: storedPaymentStatusExpr(nextPaid),
        auditLog: concatAuditLog(
          auditEvent,
          derivedStatusExpr("$amountPaidCents", today),
          derivedStatusExpr(nextPaid, today)
        ),
      },
    },
  ];
};

/**
 * Repository for Order collection operations.
 * All Mongoose queries for orders live here.
 */
export class OrderRepository {
  /**
   * Inserts a new order document including the created audit event.
   */
  async create(input: {
    userId: string;
    customer: string;
    dueDate: Date;
    lineItems: Omit<OrderLineItem, "_id">[];
    orderTotalCents: number;
    auditEvent: OrderAuditEvent;
  }): Promise<Order> {
    const doc = await OrderModel.create({
      userId: input.userId,
      customer: input.customer,
      dueDate: input.dueDate,
      lineItems: input.lineItems,
      orderTotalCents: input.orderTotalCents,
      amountPaidCents: 0,
      paymentStatus: "pending",
      payments: [],
      auditLog: [input.auditEvent],
    });
    return doc.toObject();
  }

  /**
   * Paginated list for a user. Excludes lineItems, payments, and auditLog.
   */
  async listForUser(input: {
    filter: OrderListFilter;
    skip: number;
    pageSize: number;
  }): Promise<{ items: Order[]; total: number }> {
    const [items, total] = await Promise.all([
      OrderModel.find(input.filter)
        .select("-lineItems -payments -auditLog")
        .sort({ dueDate: 1, createdAt: -1 })
        .skip(input.skip)
        .limit(input.pageSize)
        .lean<Order[]>(),
      OrderModel.countDocuments(input.filter),
    ]);
    return { items, total };
  }

  /**
   * Orders for CSV export in a createdAt range. Fetches limit + 1 to detect overflow.
   */
  async listForExport(input: {
    userId: string;
    start: Date;
    end: Date;
    limit: number;
  }): Promise<Order[]> {
    return OrderModel.find({
      userId: input.userId,
      createdAt: { $gte: input.start, $lte: input.end },
    })
      .select("-lineItems -payments -auditLog")
      .sort({ createdAt: 1 })
      .limit(input.limit)
      .lean<Order[]>();
  }

  /**
   * Status counts for dashboard filter tabs.
   */
  async countSummary(userId: string, today: Date): Promise<OrderSummaryCounts> {
    const userObjectId = new Types.ObjectId(userId);
    const [result] = await OrderModel.aggregate<OrderSummaryCounts>([
      { $match: { userId: userObjectId } },
      {
        $facet: {
          all: [{ $count: "count" }],
          paid: [{ $match: { paymentStatus: "paid" } }, { $count: "count" }],
          pending: [
            {
              $match: {
                paymentStatus: "pending",
                dueDate: { $gte: today },
              },
            },
            { $count: "count" },
          ],
          partially_paid: [
            {
              $match: {
                paymentStatus: "partially_paid",
                dueDate: { $gte: today },
              },
            },
            { $count: "count" },
          ],
          overdue: [
            {
              $match: {
                paymentStatus: { $ne: "paid" },
                dueDate: { $lt: today },
              },
            },
            { $count: "count" },
          ],
        },
      },
      {
        $project: {
          all: { $ifNull: [{ $arrayElemAt: ["$all.count", 0] }, 0] },
          pending: { $ifNull: [{ $arrayElemAt: ["$pending.count", 0] }, 0] },
          partially_paid: {
            $ifNull: [{ $arrayElemAt: ["$partially_paid.count", 0] }, 0],
          },
          paid: { $ifNull: [{ $arrayElemAt: ["$paid.count", 0] }, 0] },
          overdue: { $ifNull: [{ $arrayElemAt: ["$overdue.count", 0] }, 0] },
        },
      },
    ]);

    return (
      result ?? {
        all: 0,
        pending: 0,
        partially_paid: 0,
        paid: 0,
        overdue: 0,
      }
    );
  }

  /**
   * Finds one order owned by the user.
   */
  async findByIdAndUser(
    orderId: string,
    userId: string
  ): Promise<Order | null> {
    return OrderModel.findOne({ _id: orderId, userId }).lean<Order | null>();
  }

  /**
   * Updates customer and/or dueDate and appends an audit event.
   */
  async updateCustomerAndDueDate(input: {
    orderId: string;
    userId: string;
    customer?: string;
    dueDate?: Date;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    const nextDueDate =
      input.dueDate !== undefined ? input.dueDate : "$dueDate";
    const $set: Record<string, unknown> = {
      auditLog: concatAuditLog(
        input.auditEvent,
        derivedStatusExpr("$amountPaidCents", input.today),
        {
          $cond: [
            { $gte: ["$amountPaidCents", "$orderTotalCents"] },
            "paid",
            {
              $cond: [
                { $lt: [nextDueDate, input.today] },
                "overdue",
                {
                  $cond: [
                    { $gt: ["$amountPaidCents", 0] },
                    "partially_paid",
                    "pending",
                  ],
                },
              ],
            },
          ],
        }
      ),
    };
    if (input.customer !== undefined) $set.customer = input.customer;
    if (input.dueDate !== undefined) $set.dueDate = input.dueDate;

    return OrderModel.findOneAndUpdate(
      { _id: input.orderId, userId: input.userId },
      [{ $set }],
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Replaces line items only when the order has no payments, and audits.
   */
  async replaceLineItemsIfUnpaid(input: {
    orderId: string;
    userId: string;
    customer?: string;
    dueDate?: Date;
    lineItems: Omit<OrderLineItem, "_id">[];
    orderTotalCents: number;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    const nextDueDate =
      input.dueDate !== undefined ? input.dueDate : "$dueDate";
    const $set: Record<string, unknown> = {
      lineItems: input.lineItems,
      orderTotalCents: input.orderTotalCents,
      auditLog: concatAuditLog(
        input.auditEvent,
        derivedStatusExpr("$amountPaidCents", input.today),
        {
          $cond: [
            { $gte: ["$amountPaidCents", input.orderTotalCents] },
            "paid",
            {
              $cond: [
                { $lt: [nextDueDate, input.today] },
                "overdue",
                {
                  $cond: [
                    { $gt: ["$amountPaidCents", 0] },
                    "partially_paid",
                    "pending",
                  ],
                },
              ],
            },
          ],
        }
      ),
    };
    if (input.customer !== undefined) $set.customer = input.customer;
    if (input.dueDate !== undefined) $set.dueDate = input.dueDate;

    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        "payments.0": { $exists: false },
      },
      [{ $set }],
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Hard-deletes an order only when it has no payments or refunds.
   */
  async deleteIfUnpaid(orderId: string, userId: string): Promise<Order | null> {
    return OrderModel.findOneAndDelete({
      _id: orderId,
      userId,
      "payments.0": { $exists: false },
    }).lean<Order | null>();
  }

  /**
   * Atomically appends a payment if remaining balance covers amountCents.
   */
  async addPaymentIfAffordable(input: {
    orderId: string;
    userId: string;
    payment: OrderPayment;
    amountCents: number;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        $expr: affordableExpr(input.amountCents),
      },
      paymentUpdatePipeline(
        input.payment,
        input.amountCents,
        input.auditEvent,
        input.today
      ),
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Atomically appends a payment unless this idempotency key already exists.
   */
  async addPaymentIfAffordableIdempotent(input: {
    orderId: string;
    userId: string;
    payment: OrderPayment;
    amountCents: number;
    idempotencyKey: string;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        payments: {
          $not: { $elemMatch: { idempotencyKey: input.idempotencyKey } },
        },
        $expr: affordableExpr(input.amountCents),
      },
      paymentUpdatePipeline(
        input.payment,
        input.amountCents,
        input.auditEvent,
        input.today
      ),
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Atomically appends a refund if net paid covers amountCents.
   */
  async addRefundIfAffordable(input: {
    orderId: string;
    userId: string;
    refund: OrderPayment;
    amountCents: number;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        $expr: refundableExpr(input.amountCents),
      },
      refundUpdatePipeline(
        input.refund,
        input.amountCents,
        input.auditEvent,
        input.today
      ),
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Atomically appends a refund unless this idempotency key already exists.
   */
  async addRefundIfAffordableIdempotent(input: {
    orderId: string;
    userId: string;
    refund: OrderPayment;
    amountCents: number;
    idempotencyKey: string;
    auditEvent: Omit<OrderAuditEvent, "fromStatus" | "toStatus">;
    today: Date;
  }): Promise<Order | null> {
    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        payments: {
          $not: { $elemMatch: { idempotencyKey: input.idempotencyKey } },
        },
        $expr: refundableExpr(input.amountCents),
      },
      refundUpdatePipeline(
        input.refund,
        input.amountCents,
        input.auditEvent,
        input.today
      ),
      { new: true }
    ).lean<Order | null>();
  }
}

export const orderRepository = new OrderRepository();

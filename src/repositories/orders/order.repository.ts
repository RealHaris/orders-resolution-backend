import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";

import { ORDER_CONSTANTS } from "@/constants/order.constants";
import type {
  Order,
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
 * Pipeline that increments paid amount, appends the payment, and sets paymentStatus.
 */
const paymentUpdatePipeline = (payment: OrderPayment, amountCents: number) => [
  {
    $set: {
      amountPaidCents: { $add: ["$amountPaidCents", amountCents] },
      payments: { $concatArrays: ["$payments", [payment]] },
      paymentStatus: {
        $cond: [
          {
            $gte: [
              { $add: ["$amountPaidCents", amountCents] },
              "$orderTotalCents",
            ],
          },
          "paid",
          "partially_paid",
        ],
      },
    },
  },
];

/**
 * Repository for Order collection operations.
 * All Mongoose queries for orders live here.
 */
export class OrderRepository {
  /**
   * Inserts a new order document.
   */
  async create(input: {
    userId: string;
    customer: string;
    dueDate: Date;
    lineItems: Omit<OrderLineItem, "_id">[];
    orderTotalCents: number;
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
    });
    return doc.toObject();
  }

  /**
   * Paginated list for a user. Excludes lineItems and payments.
   */
  async listForUser(input: {
    filter: OrderListFilter;
    skip: number;
    pageSize: number;
  }): Promise<{ items: Order[]; total: number }> {
    const [items, total] = await Promise.all([
      OrderModel.find(input.filter)
        .select("-lineItems -payments")
        .sort({ dueDate: 1, createdAt: -1 })
        .skip(input.skip)
        .limit(input.pageSize)
        .lean<Order[]>(),
      OrderModel.countDocuments(input.filter),
    ]);
    return { items, total };
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
   * Updates customer and/or dueDate for an owned order.
   */
  async updateCustomerAndDueDate(input: {
    orderId: string;
    userId: string;
    customer?: string;
    dueDate?: Date;
  }): Promise<Order | null> {
    const $set: { customer?: string; dueDate?: Date } = {};
    if (input.customer !== undefined) $set.customer = input.customer;
    if (input.dueDate !== undefined) $set.dueDate = input.dueDate;

    return OrderModel.findOneAndUpdate(
      { _id: input.orderId, userId: input.userId },
      { $set },
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Replaces line items only when the order has no payments.
   */
  async replaceLineItemsIfUnpaid(input: {
    orderId: string;
    userId: string;
    customer?: string;
    dueDate?: Date;
    lineItems: Omit<OrderLineItem, "_id">[];
    orderTotalCents: number;
  }): Promise<Order | null> {
    const $set: Record<string, unknown> = {
      lineItems: input.lineItems,
      orderTotalCents: input.orderTotalCents,
    };
    if (input.customer !== undefined) $set.customer = input.customer;
    if (input.dueDate !== undefined) $set.dueDate = input.dueDate;

    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        "payments.0": { $exists: false },
      },
      { $set },
      { new: true }
    ).lean<Order | null>();
  }

  /**
   * Hard-deletes an order only when it has no payments.
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
  }): Promise<Order | null> {
    return OrderModel.findOneAndUpdate(
      {
        _id: input.orderId,
        userId: input.userId,
        $expr: affordableExpr(input.amountCents),
      },
      paymentUpdatePipeline(input.payment, input.amountCents),
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
      paymentUpdatePipeline(input.payment, input.amountCents),
      { new: true }
    ).lean<Order | null>();
  }
}

export const orderRepository = new OrderRepository();

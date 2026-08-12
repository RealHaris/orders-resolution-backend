import { model, Schema } from "mongoose";

import type { Order } from "@/data/orders/order.data";

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceCents: { type: Number, required: true, min: 1 },
    lineTotalCents: { type: Number, required: true, min: 1 },
  },
  { _id: true }
);

const paymentSchema = new Schema(
  {
    amountCents: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    note: { type: String, trim: true },
    idempotencyKey: { type: String },
    createdAt: { type: Date, required: true },
  },
  { _id: true }
);

const orderSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    customer: { type: String, required: true, trim: true },
    dueDate: { type: Date, required: true },
    lineItems: { type: [lineItemSchema], required: true },
    orderTotalCents: { type: Number, required: true, min: 1 },
    amountPaidCents: { type: Number, required: true, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["pending", "partially_paid", "paid"],
      required: true,
      default: "pending",
    },
    payments: { type: [paymentSchema], default: [] },
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, paymentStatus: 1, dueDate: 1 });
orderSchema.index({ userId: 1, dueDate: 1 });

export const OrderModel = model<Order>("Order", orderSchema);

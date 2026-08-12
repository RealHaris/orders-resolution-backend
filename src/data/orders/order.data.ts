/** Stored payment progress. Overdue is derived at read time, never stored. */
export type PaymentStatus = "pending" | "partially_paid" | "paid";

/** API-facing order status including derived overdue. */
export type OrderStatus = PaymentStatus | "overdue";

/** A single order line item stored in cents. */
export class OrderLineItem {
  _id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** Append-only payment subdocument. */
export class OrderPayment {
  _id?: string;
  amountCents: number;
  date: Date;
  note?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

/** Order owned by a single user. */
export class Order {
  _id?: string;
  userId: string;
  customer: string;
  dueDate: Date;
  lineItems: OrderLineItem[];
  orderTotalCents: number;
  amountPaidCents: number;
  paymentStatus: PaymentStatus;
  payments: OrderPayment[];
  createdAt: Date;
  updatedAt: Date;
}

/** Stored payment progress. Overdue is derived at read time, never stored. */
export type PaymentStatus = "pending" | "partially_paid" | "paid";

/** API-facing order status including derived overdue. */
export type OrderStatus = PaymentStatus | "overdue";

/** Cash-ledger row type. Amount is always positive cents. */
export type PaymentKind = "payment" | "refund";

/** Audit actions written with every state-changing mutation. */
export type OrderAuditAction =
  | "order.created"
  | "order.updated"
  | "payment.recorded"
  | "refund.recorded";

/** A single order line item stored in cents. */
export class OrderLineItem {
  _id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** Append-only payment or refund subdocument. Amount is always positive. */
export class OrderPayment {
  _id?: string;
  kind: PaymentKind;
  amountCents: number;
  date: Date;
  note?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

/** Append-only status/action event on the order. */
export class OrderAuditEvent {
  _id?: string;
  action: OrderAuditAction;
  fromStatus?: OrderStatus;
  toStatus: OrderStatus;
  actorUserId: string;
  metadata?: Record<string, unknown>;
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
  auditLog: OrderAuditEvent[];
  createdAt: Date;
  updatedAt: Date;
}

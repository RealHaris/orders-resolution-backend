import type {
  Order,
  OrderAuditEvent,
  OrderLineItem,
  OrderPayment,
  OrderStatus,
  PaymentKind,
} from "@/data/orders/order.data";
import { toIsoString } from "@/utils/date.utils";
import { centsToDollars } from "@/utils/money.utils";
import { amountDueCents, deriveOrderStatus } from "@/utils/order-status.utils";

export type OrderLineItemResponse = {
  _id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type OrderPaymentResponse = {
  _id: string;
  kind: PaymentKind;
  amount: number;
  date: string;
  note?: string;
  createdAt: string;
};

export type OrderAuditEventResponse = {
  _id: string;
  action: OrderAuditEvent["action"];
  fromStatus?: OrderStatus;
  toStatus: OrderStatus;
  actorUserId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type OrderResponse = {
  _id: string;
  customer: string;
  dueDate: string;
  status: ReturnType<typeof deriveOrderStatus>;
  subtotal: number;
  orderTotal: number;
  amountPaid: number;
  amountDue: number;
  lineItems: OrderLineItemResponse[];
  payments: OrderPaymentResponse[];
  auditLog: OrderAuditEventResponse[];
  createdAt: string;
  updatedAt: string;
};

export type OrderListItemResponse = Omit<
  OrderResponse,
  "lineItems" | "payments" | "auditLog"
>;

/** Maps a stored line item to its public dollar-based JSON shape. */
const mapLineItem = (item: OrderLineItem): OrderLineItemResponse => ({
  _id: item._id?.toString() ?? "",
  description: item.description,
  quantity: item.quantity,
  unitPrice: centsToDollars(item.unitPriceCents),
  lineTotal: centsToDollars(item.lineTotalCents),
});

/** Maps a stored payment or refund to its public dollar-based JSON shape. */
const mapPayment = (payment: OrderPayment): OrderPaymentResponse => ({
  _id: payment._id?.toString() ?? "",
  kind: payment.kind ?? "payment",
  amount: centsToDollars(payment.amountCents),
  date: toIsoString(payment.date),
  note: payment.note,
  createdAt: toIsoString(payment.createdAt),
});

/** Maps a stored audit event to its public JSON shape. */
const mapAuditEvent = (event: OrderAuditEvent): OrderAuditEventResponse => ({
  _id: event._id?.toString() ?? "",
  action: event.action,
  fromStatus: event.fromStatus,
  toStatus: event.toStatus,
  actorUserId: event.actorUserId?.toString() ?? "",
  metadata: event.metadata,
  createdAt: toIsoString(event.createdAt),
});

/** Computes subtotal, paid, and due amounts in dollars for API output. */
const moneyFields = (order: Order) => {
  const total = centsToDollars(order.orderTotalCents);
  return {
    subtotal: total,
    orderTotal: total,
    amountPaid: centsToDollars(order.amountPaidCents),
    amountDue: centsToDollars(amountDueCents(order)),
  };
};

/**
 * Maps an order document to the public detail JSON shape.
 */
export const toOrderResponse = (
  order: Order,
  now: Date = new Date()
): OrderResponse => {
  const payments = [...(order.payments ?? [])].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  const auditLog = [...(order.auditLog ?? [])].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );

  return {
    _id: order._id?.toString() ?? "",
    customer: order.customer,
    dueDate: toIsoString(order.dueDate),
    status: deriveOrderStatus(order, now),
    ...moneyFields(order),
    lineItems: (order.lineItems ?? []).map(mapLineItem),
    payments: payments.map(mapPayment),
    auditLog: auditLog.map(mapAuditEvent),
    createdAt: toIsoString(order.createdAt),
    updatedAt: toIsoString(order.updatedAt),
  };
};

/**
 * Maps an order document to the dashboard list item (no line items, payments, or audit).
 */
export const toOrderListItem = (
  order: Order,
  now: Date = new Date()
): OrderListItemResponse => {
  const { lineItems, payments, auditLog, ...rest } = toOrderResponse(
    order,
    now
  );
  return rest;
};

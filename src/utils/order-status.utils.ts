import type { Order, OrderStatus } from "@/data/orders/order.data";
import { startOfTodayUtc } from "@/utils/date.utils";

/**
 * Derives API status: paid wins, then overdue, then partially_paid, else pending.
 */
export const deriveOrderStatus = (
  order: Pick<Order, "amountPaidCents" | "orderTotalCents" | "dueDate">,
  now: Date = new Date()
): OrderStatus => {
  if (order.amountPaidCents >= order.orderTotalCents) {
    return "paid";
  }
  if (order.dueDate < startOfTodayUtc(now)) {
    return "overdue";
  }
  if (order.amountPaidCents > 0) {
    return "partially_paid";
  }
  return "pending";
};

/**
 * Remaining amount in cents.
 */
export const amountDueCents = (
  order: Pick<Order, "orderTotalCents" | "amountPaidCents">
) => order.orderTotalCents - order.amountPaidCents;

/**
 * Constants for order, payment, refund, audit, and export rules.
 */
export const ORDER_CONSTANTS = {
  MIN_LINE_ITEMS: 1,
  MAX_LINE_ITEMS: 50,
  MIN_QUANTITY: 1,
  MAX_QUANTITY: 10_000,
  MIN_UNIT_PRICE_CENTS: 1,
  MAX_UNIT_PRICE_CENTS: 100_000_000,
  MIN_PAYMENT_CENTS: 1,
  MIN_REFUND_CENTS: 1,
  MAX_PAYMENTS: 200,
  MAX_AUDIT_EVENTS: 500,
  EXPORT_MAX_ROWS: 10_000,
  MAX_CUSTOMER_LENGTH: 200,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_NOTE_LENGTH: 500,
  MIN_PAGE_SIZE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  IDEMPOTENCY_KEY_MAX_LENGTH: 64,
  MAX_EXPORT_FILENAME_LENGTH: 80,
} as const;

/**
 * Stable CSV field ids and orders-resolution-style header labels.
 */
export const ORDER_EXPORT_FIELD_HEADERS: Record<string, string> = {
  id: "Order ID",
  customer: "Customer",
  status: "Status",
  dueDate: "Due Date",
  orderTotal: "Order Total",
  amountPaid: "Amount Paid",
  amountDue: "Amount Due",
  createdAt: "Created At",
};

/** Ordered CSV columns for order export. */
export const ORDER_EXPORT_FIELDS = [
  "id",
  "customer",
  "status",
  "dueDate",
  "orderTotal",
  "amountPaid",
  "amountDue",
  "createdAt",
] as const;

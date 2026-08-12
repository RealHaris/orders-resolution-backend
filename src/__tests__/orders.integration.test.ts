import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app";
import { connectToDB, disconnectFromDB } from "../utils/db/db-conn";

const isoDayOffset = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const cookieFrom = (res: request.Response): string => {
  const raw = res.headers["set-cookie"];
  if (!raw) return "";
  return (Array.isArray(raw) ? raw : [raw]).join("; ");
};

describe("Orders & Settlements API", () => {
  let app: ReturnType<typeof createApp>;
  let mongoServer: { getUri: () => string; stop: () => Promise<boolean> };

  beforeAll(async () => {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.JWT_SECRET_KEY = "test-jwt-secret-key";
    process.env.NODE_ENV = "test";
    await connectToDB();
    app = createApp();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    await Promise.all(
      Object.values(collections).map((collection) => collection.deleteMany({}))
    );
  });

  afterAll(async () => {
    await disconnectFromDB();
    await mongoServer.stop();
  });

  /**
   * Signs up a user and returns the access-token cookie.
   */
  const signup = async (email: string) => {
    const res = await request(app).post("/api/users/signup").send({
      email,
      password: "password12",
    });
    expect(res.status).toBe(201);
    return cookieFrom(res);
  };

  type LedgerRow = { kind: string; amount: number };

  /**
   * Asserts net paid, due, and ledger rows stay consistent in cents.
   */
  const assertLedgerInvariants = (order: {
    orderTotal: number;
    amountPaid: number;
    amountDue: number;
    payments: LedgerRow[];
  }) => {
    const paidCents = Math.round(order.amountPaid * 100);
    const dueCents = Math.round(order.amountDue * 100);
    const totalCents = Math.round(order.orderTotal * 100);
    expect(paidCents).toBeGreaterThanOrEqual(0);
    expect(dueCents).toBeGreaterThanOrEqual(0);
    expect(paidCents).toBeLessThanOrEqual(totalCents);
    expect(paidCents + dueCents).toBe(totalCents);

    const netCents = order.payments.reduce((sum, row) => {
      expect(row.amount).toBeGreaterThan(0);
      const cents = Math.round(row.amount * 100);
      return sum + (row.kind === "refund" ? -cents : cents);
    }, 0);
    expect(netCents).toBe(paidCents);
  };

  /**
   * Creates an order with optional overrides.
   */
  const createOrder = async (
    cookie: string,
    input: {
      customer?: string;
      dueDate?: string;
      lineItems?: Array<{
        description: string;
        quantity: number;
        unitPrice: number;
      }>;
    } = {}
  ) => {
    const res = await request(app)
      .post("/api/orders")
      .set("Cookie", cookie)
      .send({
        customer: input.customer ?? "Acme Corp",
        dueDate: input.dueDate ?? isoDayOffset(7),
        lineItems: input.lineItems ?? [
          { description: "Consulting", quantity: 2, unitPrice: 500 },
        ],
      });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  /**
   * Creates the assignment sample order: 2 × $500 = $1,000.
   */
  const createSampleOrder = async (cookie: string, dueDate = isoDayOffset(7)) =>
    createOrder(cookie, { dueDate });

  /**
   * Loads order detail and asserts 200.
   */
  const getOrder = async (cookie: string, orderId: string) => {
    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  /**
   * Records a payment on an order.
   */
  const pay = async (
    cookie: string,
    orderId: string,
    amount: number | string,
    extra: { date?: string; idempotencyKey?: string; note?: string } = {}
  ) =>
    request(app)
      .post(`/api/orders/${orderId}/payments`)
      .set("Cookie", cookie)
      .set(
        extra.idempotencyKey ? { "Idempotency-Key": extra.idempotencyKey } : {}
      )
      .send({
        amount,
        date: extra.date ?? isoDayOffset(0),
        note: extra.note,
      });

  /**
   * Records a refund on an order.
   */
  const refund = async (
    cookie: string,
    orderId: string,
    amount: number | string,
    extra: { date?: string; idempotencyKey?: string; note?: string } = {}
  ) =>
    request(app)
      .post(`/api/orders/${orderId}/refunds`)
      .set("Cookie", cookie)
      .set(
        extra.idempotencyKey ? { "Idempotency-Key": extra.idempotencyKey } : {}
      )
      .send({
        amount,
        date: extra.date ?? isoDayOffset(0),
        note: extra.note,
      });

  describe("sample scenario", () => {
    it("creates $1000, pays $400 then $600, then rejects $1 overpay", async () => {
      const cookie = await signup("sample@example.com");
      const order = await createSampleOrder(cookie);

      expect(order.status).toBe("pending");
      expect(order.orderTotal).toBe(1000);
      expect(order.amountPaid).toBe(0);
      expect(order.amountDue).toBe(1000);
      expect(order.auditLog[0].action).toBe("order.created");

      const first = await pay(cookie, order._id, 400);
      expect(first.status).toBe(201);
      expect(first.body.data.status).toBe("partially_paid");
      expect(first.body.data.amountPaid).toBe(400);
      expect(first.body.data.amountDue).toBe(600);

      const second = await pay(cookie, order._id, 600);
      expect(second.status).toBe(201);
      expect(second.body.data.status).toBe("paid");
      expect(second.body.data.amountPaid).toBe(1000);
      expect(second.body.data.amountDue).toBe(0);

      const extra = await pay(cookie, order._id, 1);
      expect(extra.status).toBe(400);
      expect(extra.body.maxAllowedAmount).toBe(0);
    });
  });

  describe("refunds", () => {
    it("partial refund of a paid order returns to partially_paid", async () => {
      const cookie = await signup("refund-partial@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      const res = await refund(cookie, order._id, 200);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("partially_paid");
      expect(res.body.data.amountPaid).toBe(800);
      expect(res.body.data.amountDue).toBe(200);
      expect(
        res.body.data.payments.some(
          (p: { kind: string }) => p.kind === "refund"
        )
      ).toBe(true);
    });

    it("full refund of a not-yet-due order returns to pending", async () => {
      const cookie = await signup("refund-full@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      const res = await refund(cookie, order._id, 1000);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("pending");
      expect(res.body.data.amountPaid).toBe(0);
      expect(res.body.data.amountDue).toBe(1000);
    });

    it("rejects a refund larger than net paid", async () => {
      const cookie = await signup("refund-over@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      const res = await refund(cookie, order._id, 401);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(400);
    });

    it("rejects a refund when nothing is paid", async () => {
      const cookie = await signup("refund-zero@example.com");
      const order = await createSampleOrder(cookie);
      const res = await refund(cookie, order._id, 10);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(0);
    });

    it("rejects concurrent refunds that would go below zero", async () => {
      const cookie = await signup("refund-race@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const [a, b] = await Promise.all([
        refund(cookie, order._id, 500),
        refund(cookie, order._id, 500),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);
    });

    it("replays an identical refund idempotency key as 200", async () => {
      const cookie = await signup("refund-idem@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const key = "refund-key-1";
      const first = await refund(cookie, order._id, 100, {
        idempotencyKey: key,
      });
      const second = await refund(cookie, order._id, 100, {
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data.amountPaid).toBe(400);
    });

    it("allows paying the remaining balance after a refund", async () => {
      const cookie = await signup("refund-repay@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 200);
      const res = await pay(cookie, order._id, 200);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.amountDue).toBe(0);
    });

    it("keeps line items and delete locked after a full refund", async () => {
      const cookie = await signup("refund-lock@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 1000);

      const edit = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({
          lineItems: [{ description: "Changed", quantity: 1, unitPrice: 10 }],
        });
      expect(edit.status).toBe(409);

      const del = await request(app)
        .delete(`/api/orders/${order._id}`)
        .set("Cookie", cookie);
      expect(del.status).toBe(409);
    });
  });

  describe("audit log", () => {
    it("records create, payment, refund, and update events with ISO timestamps", async () => {
      const cookie = await signup("audit@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      await refund(cookie, order._id, 100);
      const updated = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({ customer: "Renamed Co" });
      expect(updated.status).toBe(200);

      const actions = updated.body.data.auditLog.map(
        (event: { action: string }) => event.action
      );
      expect(actions).toEqual([
        "order.created",
        "payment.recorded",
        "refund.recorded",
        "order.updated",
      ]);
      for (const event of updated.body.data.auditLog) {
        expect(event.createdAt).toMatch(/Z$/);
        expect(event.actorUserId).toBeTruthy();
        expect(event.toStatus).toBeTruthy();
      }
      expect(updated.body.data.auditLog[1].fromStatus).toBe("pending");
      expect(updated.body.data.auditLog[1].toStatus).toBe("partially_paid");
    });
  });

  describe("CSV export", () => {
    it("returns only this user's in-range orders with download headers", async () => {
      const cookie = await signup("export-a@example.com");
      const other = await signup("export-b@example.com");
      await createSampleOrder(cookie);
      await createSampleOrder(other);

      const res = await request(app)
        .post("/api/orders/export")
        .set("Cookie", cookie)
        .send({
          startDate: isoDayOffset(-1),
          endDate: isoDayOffset(1),
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment; filename=/
      );
      expect(res.text).toContain("Order ID");
      expect(res.text).toContain("Acme Corp");
      const dataRows = res.text.trim().split(/\r?\n/).slice(1);
      expect(dataRows).toHaveLength(1);
    });

    it("rejects startDate after endDate", async () => {
      const cookie = await signup("export-range@example.com");
      const res = await request(app)
        .post("/api/orders/export")
        .set("Cookie", cookie)
        .send({ startDate: isoDayOffset(2), endDate: isoDayOffset(0) });
      expect(res.status).toBe(400);
    });

    it("returns headers only when the range is empty", async () => {
      const cookie = await signup("export-empty@example.com");
      const res = await request(app)
        .post("/api/orders/export")
        .set("Cookie", cookie)
        .send({ startDate: "2000-01-01", endDate: "2000-01-02" });
      expect(res.status).toBe(200);
      const lines = res.text.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Order ID");
    });
  });

  describe("payment regressions", () => {
    it("rejects overpay with remaining maxAllowedAmount", async () => {
      const cookie = await signup("overpay@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      const res = await pay(cookie, order._id, 700);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(600);
    });

    it("rejects a future payment date", async () => {
      const cookie = await signup("future-pay@example.com");
      const order = await createSampleOrder(cookie);
      const res = await pay(cookie, order._id, 10, { date: isoDayOffset(2) });
      expect(res.status).toBe(400);
    });

    it("returns 409 when an idempotency key is reused with a different amount", async () => {
      const cookie = await signup("idem-mismatch@example.com");
      const order = await createSampleOrder(cookie);
      const key = "pay-key-1";
      await pay(cookie, order._id, 100, { idempotencyKey: key });
      const res = await pay(cookie, order._id, 200, { idempotencyKey: key });
      expect(res.status).toBe(409);
    });

    it("returns 404 for another user's order", async () => {
      const owner = await signup("owner@example.com");
      const other = await signup("intruder@example.com");
      const order = await createSampleOrder(owner);
      const res = await request(app)
        .get(`/api/orders/${order._id}`)
        .set("Cookie", other);
      expect(res.status).toBe(404);
    });

    it("does not mark an order due today as overdue", async () => {
      const cookie = await signup("due-today@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(0));
      expect(order.status).toBe("pending");
    });

    it("keeps paid status when the due date is in the past", async () => {
      const cookie = await signup("paid-overdue@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      const res = await pay(cookie, order._id, 1000);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
    });
  });

  describe("payment edge cases", () => {
    it("rejects zero, negative, and three-decimal payment amounts", async () => {
      const cookie = await signup("pay-invalid-amount@example.com");
      const order = await createSampleOrder(cookie);

      const zero = await pay(cookie, order._id, 0);
      expect(zero.status).toBe(400);

      const negative = await pay(cookie, order._id, -10);
      expect(negative.status).toBe(400);

      const extraPrecision = await pay(cookie, order._id, 10.001);
      expect(extraPrecision.status).toBe(400);
    });

    it("rejects a missing payment date and a missing amount", async () => {
      const cookie = await signup("pay-missing@example.com");
      const order = await createSampleOrder(cookie);

      const noDate = await request(app)
        .post(`/api/orders/${order._id}/payments`)
        .set("Cookie", cookie)
        .send({ amount: 10 });
      expect(noDate.status).toBe(400);

      const noAmount = await request(app)
        .post(`/api/orders/${order._id}/payments`)
        .set("Cookie", cookie)
        .send({ date: isoDayOffset(0) });
      expect(noAmount.status).toBe(400);
    });

    it("accepts the minimum $0.01 payment and a string dollar amount", async () => {
      const cookie = await signup("pay-min@example.com");
      const order = await createOrder(cookie, {
        lineItems: [{ description: "Tiny", quantity: 1, unitPrice: 1 }],
      });

      const penny = await pay(cookie, order._id, 0.01);
      expect(penny.status).toBe(201);
      expect(penny.body.data.amountPaid).toBe(0.01);
      expect(penny.body.data.status).toBe("partially_paid");

      const rest = await pay(cookie, order._id, "0.99");
      expect(rest.status).toBe(201);
      expect(rest.body.data.status).toBe("paid");
      expect(rest.body.data.amountDue).toBe(0);
      assertLedgerInvariants(rest.body.data);
    });

    it("round-trips cent amounts like 19.99 without losing a penny", async () => {
      const cookie = await signup("pay-cents@example.com");
      const order = await createOrder(cookie, {
        lineItems: [{ description: "SKU", quantity: 1, unitPrice: 19.99 }],
      });
      expect(order.orderTotal).toBe(19.99);

      const res = await pay(cookie, order._id, 19.99);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.amountPaid).toBe(19.99);
      expect(res.body.data.amountDue).toBe(0);
      assertLedgerInvariants(res.body.data);
    });

    it("allows a backdated payment and stores a note", async () => {
      const cookie = await signup("pay-backdate@example.com");
      const order = await createSampleOrder(cookie);
      const res = await pay(cookie, order._id, 100, {
        date: isoDayOffset(-30),
        note: "Check #441",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.payments[0].kind).toBe("payment");
      expect(res.body.data.payments[0].amount).toBe(100);
      expect(res.body.data.payments[0].note).toBe("Check #441");
    });

    it("pays remaining 0.01 after 999.99 without overshooting", async () => {
      const cookie = await signup("pay-last-penny@example.com");
      const order = await createSampleOrder(cookie);
      const first = await pay(cookie, order._id, 999.99);
      expect(first.status).toBe(201);
      expect(first.body.data.amountDue).toBe(0.01);

      const last = await pay(cookie, order._id, 0.01);
      expect(last.status).toBe(201);
      expect(last.body.data.status).toBe("paid");
      expect(last.body.data.amountDue).toBe(0);
      assertLedgerInvariants(last.body.data);
    });

    it("rejects concurrent payments that would overpay (IDURAR race)", async () => {
      const cookie = await signup("pay-race@example.com");
      const order = await createSampleOrder(cookie);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => pay(cookie, order._id, 1000))
      );
      const created = results.filter((res) => res.status === 201);
      const rejected = results.filter((res) => res.status === 400);
      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      expect(rejected[0].body.maxAllowedAmount).toBe(0);

      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(1000);
      expect(detail.payments).toHaveLength(1);
      assertLedgerInvariants(detail);
    });

    it("replays a concurrent identical payment idempotency key without double charge", async () => {
      const cookie = await signup("pay-idem-race@example.com");
      const order = await createSampleOrder(cookie);
      const key = "same-pay-key";
      const [a, b] = await Promise.all([
        pay(cookie, order._id, 400, { idempotencyKey: key }),
        pay(cookie, order._id, 400, { idempotencyKey: key }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);

      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(400);
      expect(detail.payments).toHaveLength(1);
      assertLedgerInvariants(detail);
    });

    it("scopes the same idempotency key independently per order", async () => {
      const cookie = await signup("pay-idem-orders@example.com");
      const first = await createSampleOrder(cookie);
      const second = await createSampleOrder(cookie);
      const key = "shared-across-orders";
      const a = await pay(cookie, first._id, 100, { idempotencyKey: key });
      const b = await pay(cookie, second._id, 100, { idempotencyKey: key });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it("returns 404 for another user's payment and 400 for a bad id", async () => {
      const owner = await signup("pay-owner@example.com");
      const other = await signup("pay-intruder@example.com");
      const order = await createSampleOrder(owner);

      const stolen = await pay(other, order._id, 10);
      expect(stolen.status).toBe(404);

      const badId = await pay(owner, "not-an-id", 10);
      expect(badId.status).toBe(400);
    });

    it("returns 401 when recording a payment without a cookie", async () => {
      const cookie = await signup("pay-auth@example.com");
      const order = await createSampleOrder(cookie);
      const res = await request(app)
        .post(`/api/orders/${order._id}/payments`)
        .send({ amount: 10, date: isoDayOffset(0) });
      expect(res.status).toBe(401);
    });
  });

  describe("refund edge cases", () => {
    it("rejects zero, negative, and three-decimal refund amounts", async () => {
      const cookie = await signup("refund-invalid-amount@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);

      expect((await refund(cookie, order._id, 0)).status).toBe(400);
      expect((await refund(cookie, order._id, -5)).status).toBe(400);
      expect((await refund(cookie, order._id, 1.001)).status).toBe(400);
    });

    it("rejects a missing refund date and a missing amount", async () => {
      const cookie = await signup("refund-missing@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);

      const noDate = await request(app)
        .post(`/api/orders/${order._id}/refunds`)
        .set("Cookie", cookie)
        .send({ amount: 10 });
      expect(noDate.status).toBe(400);

      const noAmount = await request(app)
        .post(`/api/orders/${order._id}/refunds`)
        .set("Cookie", cookie)
        .send({ date: isoDayOffset(0) });
      expect(noAmount.status).toBe(400);
    });

    it("rejects a future refund date and allows a backdated refund", async () => {
      const cookie = await signup("refund-dates@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);

      const future = await refund(cookie, order._id, 10, {
        date: isoDayOffset(2),
      });
      expect(future.status).toBe(400);

      const backdated = await refund(cookie, order._id, 10, {
        date: isoDayOffset(-14),
        note: "Goodwill",
      });
      expect(backdated.status).toBe(201);
      expect(backdated.body.data.payments[1].kind).toBe("refund");
      expect(backdated.body.data.payments[1].amount).toBe(10);
      expect(backdated.body.data.payments[1].note).toBe("Goodwill");
    });

    it("refunds $12.50 exactly with no off-by-one cent (Recurly-style)", async () => {
      const cookie = await signup("refund-12-50@example.com");
      const order = await createOrder(cookie, {
        lineItems: [{ description: "Plan", quantity: 1, unitPrice: 12.5 }],
      });
      await pay(cookie, order._id, 12.5);
      const res = await refund(cookie, order._id, 12.5);
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaid).toBe(0);
      expect(res.body.data.amountDue).toBe(12.5);
      assertLedgerInvariants(res.body.data);
    });

    it("allows multiple partial refunds until fully refunded, then rejects (Stripe)", async () => {
      const cookie = await signup("refund-stripe-partials@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);

      const first = await refund(cookie, order._id, 300);
      expect(first.status).toBe(201);
      expect(first.body.data.amountPaid).toBe(700);

      const second = await refund(cookie, order._id, 400);
      expect(second.status).toBe(201);
      expect(second.body.data.amountPaid).toBe(300);

      const third = await refund(cookie, order._id, 300);
      expect(third.status).toBe(201);
      expect(third.body.data.amountPaid).toBe(0);
      expect(third.body.data.status).toBe("pending");

      const extra = await refund(cookie, order._id, 0.01);
      expect(extra.status).toBe(400);
      expect(extra.body.maxAllowedAmount).toBe(0);
      assertLedgerInvariants(third.body.data);
    });

    it("refunds the exact net paid after a partial payment, not the order total", async () => {
      const cookie = await signup("refund-net-only@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);

      const tooMuch = await refund(cookie, order._id, 1000);
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.body.maxAllowedAmount).toBe(400);

      const exact = await refund(cookie, order._id, 400);
      expect(exact.status).toBe(201);
      expect(exact.body.data.amountPaid).toBe(0);
      expect(exact.body.data.status).toBe("pending");
      assertLedgerInvariants(exact.body.data);
    });

    it("rejects a second refund that would exceed remaining net paid", async () => {
      const cookie = await signup("refund-remaining@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 600);

      const res = await refund(cookie, order._id, 500);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(400);
    });

    it("accepts a $0.01 refund and a string refund amount", async () => {
      const cookie = await signup("refund-penny@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1);
      const penny = await refund(cookie, order._id, 0.01);
      expect(penny.status).toBe(201);
      expect(penny.body.data.amountPaid).toBe(0.99);

      const rest = await refund(cookie, order._id, "0.99");
      expect(rest.status).toBe(201);
      expect(rest.body.data.amountPaid).toBe(0);
      assertLedgerInvariants(rest.body.data);
    });

    it("returns 409 when a refund idempotency key is reused with a different amount", async () => {
      const cookie = await signup("refund-idem-mismatch@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const key = "refund-mismatch";
      await refund(cookie, order._id, 100, { idempotencyKey: key });
      const res = await refund(cookie, order._id, 200, { idempotencyKey: key });
      expect(res.status).toBe(409);
    });

    it("does not add a second ledger row on refund idempotency replay", async () => {
      const cookie = await signup("refund-idem-rows@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const key = "refund-once";
      await refund(cookie, order._id, 100, { idempotencyKey: key });
      const replay = await refund(cookie, order._id, 100, {
        idempotencyKey: key,
      });
      expect(replay.status).toBe(200);
      expect(
        replay.body.data.payments.filter(
          (row: LedgerRow) => row.kind === "refund"
        )
      ).toHaveLength(1);
      assertLedgerInvariants(replay.body.data);
    });

    it("replays a concurrent identical refund idempotency key without double refund", async () => {
      const cookie = await signup("refund-idem-race@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const key = "same-refund-key";
      const [a, b] = await Promise.all([
        refund(cookie, order._id, 200, { idempotencyKey: key }),
        refund(cookie, order._id, 200, { idempotencyKey: key }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);

      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(300);
      expect(
        detail.payments.filter((row: LedgerRow) => row.kind === "refund")
      ).toHaveLength(1);
      assertLedgerInvariants(detail);
    });

    it("rejects using a payment idempotency key on a refund", async () => {
      const cookie = await signup("refund-cross-kind@example.com");
      const order = await createSampleOrder(cookie);
      const key = "shared-kind-key";
      await pay(cookie, order._id, 200, { idempotencyKey: key });
      const res = await refund(cookie, order._id, 200, { idempotencyKey: key });
      expect(res.status).toBe(409);
    });

    it("returns 404 for another user's refund and 400 for a bad id", async () => {
      const owner = await signup("refund-owner@example.com");
      const other = await signup("refund-intruder@example.com");
      const order = await createSampleOrder(owner);
      await pay(owner, order._id, 100);

      expect((await refund(other, order._id, 10)).status).toBe(404);
      expect((await refund(owner, "not-an-id", 10)).status).toBe(400);
    });

    it("returns 401 when recording a refund without a cookie", async () => {
      const cookie = await signup("refund-auth@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);
      const res = await request(app)
        .post(`/api/orders/${order._id}/refunds`)
        .send({ amount: 10, date: isoDayOffset(0) });
      expect(res.status).toBe(401);
    });

    it("keeps refund ledger amounts positive (never a negative payment)", async () => {
      const cookie = await signup("refund-positive@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      const res = await refund(cookie, order._id, 150);
      expect(res.status).toBe(201);
      const refundRow = res.body.data.payments.find(
        (row: LedgerRow) => row.kind === "refund"
      );
      expect(refundRow.amount).toBe(150);
      assertLedgerInvariants(res.body.data);
    });
  });

  describe("mixed payment and refund ledger", () => {
    it("computes net paid as sum(payments) minus sum(refunds)", async () => {
      const cookie = await signup("mixed-net@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      await pay(cookie, order._id, 300);
      await refund(cookie, order._id, 200);
      const last = await pay(cookie, order._id, 100);
      expect(last.status).toBe(201);
      expect(last.body.data.amountPaid).toBe(600);
      expect(last.body.data.amountDue).toBe(400);
      expect(last.body.data.status).toBe("partially_paid");
      assertLedgerInvariants(last.body.data);
    });

    it("rejects a payment larger than remaining due after a refund", async () => {
      const cookie = await signup("mixed-overpay-after-refund@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 50);
      const res = await pay(cookie, order._id, 100);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(50);
    });

    it("can reach paid again after a refund opened remaining due", async () => {
      const cookie = await signup("mixed-repay-gap@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 50);
      const res = await pay(cookie, order._id, 50);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.amountDue).toBe(0);
      assertLedgerInvariants(res.body.data);
    });

    it("preserves money invariants when a payment and refund race", async () => {
      const cookie = await signup("mixed-race@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const [payRes, refundRes] = await Promise.all([
        pay(cookie, order._id, 500),
        refund(cookie, order._id, 500),
      ]);
      expect(payRes.status).toBe(201);
      expect(refundRes.status).toBe(201);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(500);
      expect(detail.amountDue).toBe(500);
      assertLedgerInvariants(detail);
    });

    it("exports net amountPaid after a refund, not gross collections", async () => {
      const cookie = await signup("mixed-export@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 250);

      const res = await request(app)
        .post("/api/orders/export")
        .set("Cookie", cookie)
        .send({
          startDate: isoDayOffset(-1),
          endDate: isoDayOffset(1),
        });
      expect(res.status).toBe(200);
      expect(res.text).toContain(order._id);
      expect(res.text).toContain(",1000,750,250,");
    });
  });

  describe("status after refunds", () => {
    it("marks a fully refunded past-due order overdue, not pending", async () => {
      const cookie = await signup("status-refund-overdue@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-3));
      await pay(cookie, order._id, 1000);
      const res = await refund(cookie, order._id, 1000);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("overdue");
      expect(res.body.data.amountPaid).toBe(0);
      expect(res.body.data.amountDue).toBe(1000);
    });

    it("keeps overdue (not partially_paid) after a partial refund of a past-due paid order", async () => {
      const cookie = await signup("status-refund-overdue-partial@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-3));
      await pay(cookie, order._id, 1000);
      const res = await refund(cookie, order._id, 200);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("overdue");
      expect(res.body.data.amountPaid).toBe(800);
    });

    it("lists a fully refunded past-due order under overdue, not pending", async () => {
      const cookie = await signup("status-list-overdue@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-3));
      await pay(cookie, order._id, 1000);
      await refund(cookie, order._id, 1000);

      const overdue = await request(app)
        .get("/api/orders?status=overdue")
        .set("Cookie", cookie);
      expect(overdue.status).toBe(200);
      expect(
        overdue.body.data.list.map((row: { _id: string }) => row._id)
      ).toContain(order._id);

      const pending = await request(app)
        .get("/api/orders?status=pending")
        .set("Cookie", cookie);
      expect(
        pending.body.data.list.map((row: { _id: string }) => row._id)
      ).not.toContain(order._id);
    });

    it("still allows editing customer and dueDate after a payment", async () => {
      const cookie = await signup("status-edit-after-pay@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);
      const res = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({ customer: "New Name", dueDate: isoDayOffset(14) });
      expect(res.status).toBe(200);
      expect(res.body.data.customer).toBe("New Name");
    });

    it("flips unpaid overdue back to pending when dueDate is moved to the future", async () => {
      const cookie = await signup("status-due-move@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      expect(order.status).toBe("overdue");
      const res = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({ dueDate: isoDayOffset(10) });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("pending");
    });

    it("records refund audit from paid to overdue when the due date is past", async () => {
      const cookie = await signup("status-audit-overdue@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      await pay(cookie, order._id, 1000);
      const res = await refund(cookie, order._id, 200);
      const refundEvent = res.body.data.auditLog.find(
        (event: { action: string }) => event.action === "refund.recorded"
      );
      expect(refundEvent.fromStatus).toBe("paid");
      expect(refundEvent.toStatus).toBe("overdue");
    });
  });

  describe("search and isolation", () => {
    it("escapes regex characters in customer search", async () => {
      const cookie = await signup("search-regex@example.com");
      await createOrder(cookie, { customer: "Acme (Corp)" });
      const res = await request(app)
        .get("/api/orders?search=Acme (Corp)")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.list).toHaveLength(1);
    });
  });

  describe("payment allocation", () => {
    it("allocates each payment against remaining due and keeps both ledger rows", async () => {
      const cookie = await signup("alloc-remaining@example.com");
      const order = await createSampleOrder(cookie);

      const first = await pay(cookie, order._id, 400);
      expect(first.status).toBe(201);
      expect(first.body.data.amountPaid).toBe(400);
      expect(first.body.data.amountDue).toBe(600);
      expect(first.body.data.payments).toHaveLength(1);

      const second = await pay(cookie, order._id, 250);
      expect(second.status).toBe(201);
      expect(second.body.data.amountPaid).toBe(650);
      expect(second.body.data.amountDue).toBe(350);
      expect(second.body.data.payments).toHaveLength(2);
      expect(
        second.body.data.payments.map((row: LedgerRow) => row.amount)
      ).toEqual([400, 250]);
      assertLedgerInvariants(second.body.data);
    });

    it("marks the order paid when allocated payments sum exactly to the total", async () => {
      const cookie = await signup("alloc-exact-total@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 100);
      await pay(cookie, order._id, 200);
      const last = await pay(cookie, order._id, 700);
      expect(last.status).toBe(201);
      expect(last.body.data.status).toBe("paid");
      expect(last.body.data.amountPaid).toBe(1000);
      expect(last.body.data.amountDue).toBe(0);
      expect(last.body.data.payments).toHaveLength(3);
      assertLedgerInvariants(last.body.data);
    });

    it("accepts a payment of the exact remaining balance", async () => {
      const cookie = await signup("alloc-exact-remaining@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      const res = await pay(cookie, order._id, 600);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.amountDue).toBe(0);
    });
  });

  describe("status transitions", () => {
    it("moves pending → partially_paid → paid with matching audit from/to", async () => {
      const cookie = await signup("status-path@example.com");
      const order = await createSampleOrder(cookie);
      expect(order.status).toBe("pending");
      expect(order.auditLog[0].toStatus).toBe("pending");

      const partial = await pay(cookie, order._id, 400);
      expect(partial.body.data.status).toBe("partially_paid");
      expect(partial.body.data.auditLog[1].fromStatus).toBe("pending");
      expect(partial.body.data.auditLog[1].toStatus).toBe("partially_paid");

      const paid = await pay(cookie, order._id, 600);
      expect(paid.body.data.status).toBe("paid");
      expect(paid.body.data.auditLog[2].fromStatus).toBe("partially_paid");
      expect(paid.body.data.auditLog[2].toStatus).toBe("paid");
    });

    it("clears overdue when the final payment lands (overdue is not sticky)", async () => {
      const cookie = await signup("status-overdue-then-paid@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      expect(order.status).toBe("overdue");
      const res = await pay(cookie, order._id, 1000);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.amountDue).toBe(0);
    });

    it("treats a past-due partial as overdue, not partially_paid", async () => {
      const cookie = await signup("status-partial-past-due@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-1));
      const res = await pay(cookie, order._id, 400);
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("overdue");
      expect(res.body.data.amountDue).toBe(600);
    });

    it("keeps an unpaid order due today as pending", async () => {
      const cookie = await signup("status-due-today@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(0));
      expect(order.status).toBe("pending");
    });

    it("marks an unpaid order due yesterday as overdue", async () => {
      const cookie = await signup("status-due-yesterday@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-1));
      expect(order.status).toBe("overdue");
    });

    it("moves unpaid overdue to pending when dueDate is edited into the future", async () => {
      const cookie = await signup("status-due-future-edit@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      expect(order.status).toBe("overdue");
      const res = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({ dueDate: isoDayOffset(10) });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("pending");
    });

    it("moves a partial to overdue when dueDate is edited into the past", async () => {
      const cookie = await signup("status-due-past-edit@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);
      const res = await request(app)
        .put(`/api/orders/${order._id}`)
        .set("Cookie", cookie)
        .send({ dueDate: isoDayOffset(-1) });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("overdue");
      expect(res.body.data.amountPaid).toBe(400);
    });

    it("stays paid when a fully paid order's due date is in the past", async () => {
      const cookie = await signup("status-paid-past-due@example.com");
      const order = await createSampleOrder(cookie, isoDayOffset(-2));
      const res = await pay(cookie, order._id, 1000);
      expect(res.body.data.status).toBe("paid");
    });
  });

  describe("over-payment rejection", () => {
    it("rejects an amount over remaining due and leaves status and ledger unchanged", async () => {
      const cookie = await signup("overpay-unchanged@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);

      const res = await pay(cookie, order._id, 700);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(600);

      const detail = await getOrder(cookie, order._id);
      expect(detail.status).toBe("partially_paid");
      expect(detail.amountPaid).toBe(400);
      expect(detail.amountDue).toBe(600);
      expect(detail.payments).toHaveLength(1);
    });

    it("rejects $1 over a fully paid order with maxAllowedAmount 0", async () => {
      const cookie = await signup("overpay-paid@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 1000);
      const res = await pay(cookie, order._id, 1);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(0);

      const detail = await getOrder(cookie, order._id);
      expect(detail.status).toBe("paid");
      expect(detail.payments).toHaveLength(1);
    });

    it("rejects a first payment larger than the order total", async () => {
      const cookie = await signup("overpay-first@example.com");
      const order = await createSampleOrder(cookie);
      const res = await pay(cookie, order._id, 1000.01);
      expect(res.status).toBe(400);
      expect(res.body.maxAllowedAmount).toBe(1000);
      expect((await getOrder(cookie, order._id)).amountPaid).toBe(0);
    });
  });

  describe("concurrency", () => {
    it("lets only one of two concurrent $600 payments win when $600 remains", async () => {
      const cookie = await signup("conc-spec-600@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 400);

      const [a, b] = await Promise.all([
        pay(cookie, order._id, 600),
        pay(cookie, order._id, 600),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);

      const winner = a.status === 201 ? a : b;
      const loser = a.status === 400 ? a : b;
      expect(winner.body.data.status).toBe("paid");
      expect(winner.body.data.amountPaid).toBe(1000);
      expect(winner.body.data.amountDue).toBe(0);
      expect(loser.body.maxAllowedAmount).toBe(0);

      const detail = await getOrder(cookie, order._id);
      expect(
        detail.payments.filter((row: LedgerRow) => row.kind === "payment")
      ).toHaveLength(2);
      expect(detail.amountPaid).toBe(1000);
      assertLedgerInvariants(detail);
    });

    it("lets only one concurrent full payment succeed on an unpaid order", async () => {
      const cookie = await signup("conc-full-pay@example.com");
      const order = await createSampleOrder(cookie);
      const [a, b] = await Promise.all([
        pay(cookie, order._id, 1000),
        pay(cookie, order._id, 1000),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(1000);
      expect(detail.payments).toHaveLength(1);
      assertLedgerInvariants(detail);
    });

    it("accepts two concurrent payments that both fit in remaining due", async () => {
      const cookie = await signup("conc-both-fit@example.com");
      const order = await createSampleOrder(cookie);
      const [a, b] = await Promise.all([
        pay(cookie, order._id, 200),
        pay(cookie, order._id, 300),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(500);
      expect(detail.amountDue).toBe(500);
      expect(detail.status).toBe("partially_paid");
      expect(detail.payments).toHaveLength(2);
      assertLedgerInvariants(detail);
    });

    it("lets only one of two concurrent refunds of the full net paid succeed", async () => {
      const cookie = await signup("conc-refund-full@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const [a, b] = await Promise.all([
        refund(cookie, order._id, 500),
        refund(cookie, order._id, 500),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      const loser = a.status === 400 ? a : b;
      expect(loser.body.maxAllowedAmount).toBe(0);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(0);
      expect(
        detail.payments.filter((row: LedgerRow) => row.kind === "refund")
      ).toHaveLength(1);
      assertLedgerInvariants(detail);
    });

    it("does not double-charge when the same payment idempotency key is sent twice at once", async () => {
      const cookie = await signup("conc-pay-idem@example.com");
      const order = await createSampleOrder(cookie);
      const key = "conc-pay-key";
      const [a, b] = await Promise.all([
        pay(cookie, order._id, 400, { idempotencyKey: key }),
        pay(cookie, order._id, 400, { idempotencyKey: key }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(400);
      expect(detail.payments).toHaveLength(1);
    });

    it("does not double-refund when the same refund idempotency key is sent twice at once", async () => {
      const cookie = await signup("conc-refund-idem@example.com");
      const order = await createSampleOrder(cookie);
      await pay(cookie, order._id, 500);
      const key = "conc-refund-key";
      const [a, b] = await Promise.all([
        refund(cookie, order._id, 200, { idempotencyKey: key }),
        refund(cookie, order._id, 200, { idempotencyKey: key }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      const detail = await getOrder(cookie, order._id);
      expect(detail.amountPaid).toBe(300);
      expect(
        detail.payments.filter((row: LedgerRow) => row.kind === "refund")
      ).toHaveLength(1);
    });
  });
});

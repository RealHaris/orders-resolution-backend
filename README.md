# Orders & Settlements

Cookie-JWT invoicing API: create orders, record payments and refunds, derive status, append an audit log, and export CSV.

Money is **cents in Mongo**, **dollars on the API**. Status is derived at read time: **paid wins, then overdue, then partially paid, else pending**.

| | |
|---|---|
| **Frontend** | [https://my-frontend-flax.vercel.app](https://my-frontend-flax.vercel.app) |
| **Backend API** | [https://orders-resolution-backend.onrender.com](https://orders-resolution-backend.onrender.com) |
| **Health check** | [https://orders-resolution-backend.onrender.com/api/health](https://orders-resolution-backend.onrender.com/api/health) |
| **Contact** | [hariskhan.mywork@gmail.com](mailto:hariskhan.mywork@gmail.com) |

Local: API **6011**, UI **6010**. Full contract: [`docs/ORDERS_AND_SETTLEMENTS_API.md`](../docs/ORDERS_AND_SETTLEMENTS_API.md).

---

## Environment variables

Required in **both** apps so the deployed UI can talk to the API (cookies + CORS).

### Backend (`my-backend/.env`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET_KEY` | Yes | Cookie JWT signing secret |
| `CORS_ORIGINS` | Yes | Comma-separated UI origins. Must include `http://localhost:6010` and `https://my-frontend-flax.vercel.app` |
| `PORT` | No | HTTP port (default **6011**) |
| `NODE_ENV` | No | `development` / `test` / `production` |
| `LOG_LEVEL` | No | Pino level (default `info`) |

Copy from `.env.example`. Production `CORS_ORIGINS` example:

```
CORS_ORIGINS=http://localhost:6010,https://my-frontend-flax.vercel.app
```

### Frontend (`my-frontend/.env.local`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEXT_PUBLIC_API_HOST` | Yes | API base including `/api`. Local: `http://localhost:6011/api`. Deployed: `https://orders-resolution-backend.onrender.com/api` |

Copy from `.env.example`. The browser sends the `accessToken` cookie with `credentials: "include"`, so the API origin in this variable must match `CORS_ORIGINS` on the backend.

---

## Prerequisites

- **Node.js 22** (`>=22.22.3 <23` — see `package.json` `engines`)
- **npm**
- A **MongoDB** database (Atlas or local). The API uses a single `MONGODB_URI`.
- Optional: the Next.js app in `orders-fe/my-frontend` if you want the dashboard

---

## Setup

### 1. Backend

```bash
cd orders-resolution
cp .env.example .env
```

Set at least the backend variables in [Environment variables](#environment-variables). Then:

```bash
npm install
npm run dev          # http://localhost:6011
```

Check: `GET http://localhost:6011/api/health` → `{ "success": true, "data": { "ok": true } }`.

Other scripts: `npm test`, `npm run ci` (Biome + `tsc --noEmit` + Vitest), `npm run build`, `npm start`.

### 2. Frontend (optional)

```bash
cdorders-resolutions
```

Create `.env.local` with `NEXT_PUBLIC_API_HOST` (see [Environment variables](#environment-variables)).

```bash
npm install
npm run dev          # http://localhost:6010
```

Sign up, create an order (2 × $500 = $1,000 is the sample), record payments/refunds, export CSV.

Cookies are `httpOnly` JWT (`accessToken`). The browser must send them (`credentials: "include"`). CORS must list the UI origin.

---

## API overview

Authenticated unless noted. Cookie is set on signup/login.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/health` | Public | Liveness |
| `POST` | `/api/users/signup` | Public | Create account, set cookie |
| `POST` | `/api/users/login` | Public | Login, set cookie |
| `POST` | `/api/users/logout` | Public | Always clears cookie |
| `GET` | `/api/users/me` | User | Current user (no password) |
| `POST` | `/api/orders` | User | Create order |
| `GET` | `/api/orders` | User | Paginated list (`status`, `search`, `pageNum`, `pageSize`) |
| `GET` | `/api/orders/summary` | User | Counts per status |
| `POST` | `/api/orders/export` | User | CSV attachment (`startDate`, `endDate`) |
| `GET` | `/api/orders/:id` | User | Detail + line items + payments + audit |
| `PUT` | `/api/orders/:id` | User | Partial update (`customer`, `dueDate`, `lineItems`) |
| `DELETE` | `/api/orders/:id` | User | Delete if the ledger is empty |
| `POST` | `/api/orders/:id/payments` | User | Record a payment (atomic) |
| `POST` | `/api/orders/:id/refunds` | User | Record a refund (atomic) |

Mount `/summary` and `/export` **before** `/:id`. Optional `Idempotency-Key` on pay and refund: same key + same body → **200** replay; same key + different body → **409**.

**Sample scenario** (covered by `npm test`):

1. Create 2 × $500 = $1,000, due in 7 days → `pending`, due $1,000
2. Pay $400 → `partially_paid`, due $600
3. Pay $600 → `paid`, due $0
4. Pay $1 more → **400** with `maxAllowedAmount: 0`

---

## Status derivation and edge-case decisions

Computed in this order (first match wins). Overdue is **never stored**.

```
if amountPaidCents >= orderTotalCents        → paid
else if dueDate < startOfTodayUtc()          → overdue
else if amountPaidCents > 0                  → partially_paid
else                                         → pending
```

Net paid is `sum(payments) − sum(refunds)`. Ledger amounts are always **positive**; a refund is `kind: "refund"`, not a negative payment.

| Decision | Rule |
|----------|------|
| Paid vs overdue | **Paid always wins.** A fully paid past-due order is `paid`. |
| Partial vs overdue | If not fully paid and due date is before today UTC → `overdue`. |
| Due today | Unpaid and due today → `pending` (overdue is strictly **before** today UTC). |
| After a refund | Status re-derives from the new net paid. A not-yet-due full refund → `pending`. A past-due full refund → `overdue` (not a new `refunded` status). |
| Over-payment | Rejected. Status and ledger unchanged. Response includes `maxAllowedAmount`. |
| After first ledger row | Line items freeze (even after a full refund). `customer` / `dueDate` stay editable. Delete is blocked while the ledger is non-empty. |
| Isolation | Another user’s order id is **404**, never 403. |
| Dates | ISO 8601 UTC. Future payment/refund dates rejected; backdating allowed. |
| Money | Integer cents in Mongo; dollars on the API; at most 2 decimal places; minimum $0.01. |

### Concurrency (no distributed lock)

Two `$600` payments on `$600` remaining must not over-collect `$1,200`. A service-layer read-then-write **will** lose that race.

**Approach:** payments and refunds live on the order document. MongoDB serializes writes to one document. One `findOneAndUpdate` filter includes `$expr`:

- Pay: `amountPaidCents + payment <= orderTotalCents`
- Refund: `amountPaidCents >= refundCents`

The loser gets `null` and a **400** with `maxAllowedAmount`. No Redis lock, no `SELECT FOR UPDATE`, no multi-document transaction, no deadlock (single document, single update). Idempotency is the same atomic filter (`$not` + `$elemMatch`).

Covered by the `concurrency` tests, including two concurrent `$600` payments on `$600` remaining.

### Other edge cases

| Case | Behavior |
|------|----------|
| Concurrent payments that would overpay | One 201, loser 400 |
| Concurrent refunds that would go below $0 | One 201, loser 400 |
| Concurrent pay + refund on the same remaining | Both 201; net stays consistent |
| Concurrent identical `Idempotency-Key` | One 201, one 200; no double ledger row |
| Amount 0, negative, or >2 decimal places | 400 |
| Cent amounts like $19.99 / $12.50 | Exact cents |
| CSV empty range | 200, headers only |
| CSV over 10,000 rows | 400 |
| Search with regex characters | Escaped before `$regex` |
| Duplicate signup email | 409 |

---

## Assumptions and tradeoffs

**Assumptions**

- One role (`User`). No admin, no multi-tenant orgs.
- USD implied. No tax, discounts, or multi-currency.
- Manual settlements (no Stripe charge/refund processor).
- Cookie JWT is enough; no refresh-token rotation in this app.
- Dataset is small enough for in-memory CSV (orders-resolution pattern, 10k cap).
- In-memory rate limiting is enough (no Redis).

**Tradeoffs**

| Topic | Chosen | Rejected | Why |
|-------|--------|----------|-----|
| Refunds | Typed ledger row `kind: "refund"`, positive cents | Negative payments; separate `refunds` collection | Same atomic write as payments; negatives break min/guards |
| Audit | Embedded `auditLog[]` (cap 500), written in the same update | `updatedAt` only; separate events collection | Atomic with the mutation; separate collection needs a transaction |
| CSV | Buffered `@json2csv/plainjs` attachment | Browser-built CSV; S3/presigned URL; `res.write` streaming | Cookie auth, one money/status implementation, no extra infra |
| Concurrency | Document-level `$expr` update | Redis lock / SQL `FOR UPDATE` | One order document; locking would add infra and deadlock surface |
| Overdue | Derived on read | Persisted status | Clock can move without a write |

Overdue can appear later just because the calendar moved. Audit logs derived status **at write time**; a later GET may show `overdue` without a new audit row until the next mutation.

---

## What I would improve before production

- **Rate limiting:** move from in-memory to Redis so limits hold across Render instances.
- **Auth cookies:** confirm `Secure` / `SameSite` / domain for a real frontend origin; add refresh tokens or short-lived access + rotation.
- **Observability:** request ids in every log line already help; add error tracking (Sentry) and uptime on `/api/health`.
- **Export:** stream or background job + object storage if exports grow past tens of thousands of rows.
- **Audit:** move `auditLog` to its own collection if it is queried across orders or outgrows the 500-event cap.
- **Payments:** if a processor is added, refund against a charge id and keep this ledger as the AR sub-ledger.
- **Indexes / Atlas:** review slow-query logs under real list filters; keep user-scoped indexes.
- **Secrets:** rotate `JWT_SECRET_KEY` and Mongo credentials independently of this repo; never commit `.env`.
- **Frontend deploy:** dashboard is at [https://my-frontend-flax.vercel.app](https://my-frontend-flax.vercel.app); keep `CORS_ORIGINS` and `NEXT_PUBLIC_API_HOST` in sync.

---

## Submission email (copy/paste)

**To:** *(reviewer)*  
**From:** hariskhan.mywork@gmail.com  
**Subject:** Orders & Settlements API — submission

```
Hi,

Here is my Orders & Settlements app.

Frontend: https://my-frontend-flax.vercel.app
Backend API: https://orders-resolution-backend.onrender.com
Health: https://orders-resolution-backend.onrender.com/api/health

Repo:orders-resolution (API) andorders-resolutions (dashboard).
README covers setup, endpoints, status rules, concurrency (atomic $expr, no distributed lock), tradeoffs, and production follow-ups.

Contact: hariskhan.mywork@gmail.com

Thanks,
Haris
```

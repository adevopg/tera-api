# Buy Coins — Online top-up (Stripe · SumUp · PayPal · Paymentwall)

Adds an online **"Buy Coins"** page to the shop so players can top up their shop
balance (`shop_accounts.balance`) through **Stripe**, **SumUp**, **PayPal** or
**Paymentwall**. Crediting is idempotent and fully logged.

## What was added

**Backend**
- `config/payment.default.js` — packages, currency, provider toggles.
- `src/modules/payment.module.js` — provider clients (Stripe SDK + SumUp REST)
  and the idempotent `settle()` that credits the balance exactly once.
- `src/controllers/portalShopPayment.controller.js` — endpoints:
  - `GET  /shop/PartialBuyCoins` — the Buy Coins page (partial).
  - `POST /shop/GetCoinPackages` — packages + available providers (JSON).
  - `POST /shop/CreatePayment` — creates a checkout, returns `redirectUrl`.
  - `POST /shop/PaymentStatus` — poll a transaction status.
  - `GET  /shop/PaymentReturn` — landing page after the provider redirect.
  - `POST /shop/PaymentWebhookStripe` — Stripe webhook (signature-verified).
  - `POST /shop/PaymentWebhookSumUp` — SumUp webhook (status re-fetched).
  - `POST /shop/PaymentWebhookPayPal` — PayPal webhook (order/capture re-fetched).
  - `GET  /shop/PaymentPingbackPaymentwall` — Paymentwall pingback (SDK-validated).
- `src/models/shop/shopPayTransactions.model.js` + migration `update_000004.js`
  — new table `shop_pay_transactions` (one row per checkout, source of truth for
  idempotent crediting). `DB_VERSION` bumped `3 → 4`.
- `src/lib/expressServer.js` — keeps `req.rawBody` so Stripe signatures verify.

**Frontend**
- `src/views/partials/shopBuyCoins.ejs` — package grid + provider selector.
- `src/views/shopPaymentReturn.ejs` — success/failure landing with status poll.
- `src/views/shopMain.ejs` — new "Buy Coins" nav entry.
- `public/shop/js/shop.js` — `shopGetCoinPackages`, `shopCreatePayment`,
  `shopPaymentStatus`.

## How crediting works (idempotent)

1. `CreatePayment` inserts a `pending` row in `shop_pay_transactions` and asks the
   provider for a hosted checkout; the player is redirected there.
2. On success the provider notifies the **webhook** (and the player is sent back
   to `PaymentReturn`). Both paths call `payment.settle()`, which — inside a
   `SELECT ... FOR UPDATE` transaction — credits the balance **only if the row is
   still `pending`**, writes a `report_shop_fund` entry (`Topup,<provider>,<id>`)
   and flips the row to `paid`. Re-deliveries are no-ops.
3. No callback trusts the request body for the amount: **Stripe** is signature
   verified; **SumUp** and **PayPal** statuses are re-fetched from their APIs;
   **Paymentwall** pingbacks are signature- and IP-validated by the official SDK.

## Setup

1. Install the new dependencies:
   ```
   npm install
   ```
   (adds `stripe` and `paymentwall`; SumUp and PayPal use the built-in `fetch`.)

2. Configure `.env` (see `.env.example` → "PAYMENTS (BUY COINS) CONFIGURATION"):
   ```
   PAYMENT_PUBLIC_BASE_URL=https://shop.your-server.com
   PAYMENT_STRIPE_SECRET_KEY=sk_live_xxx
   PAYMENT_STRIPE_WEBHOOK_SECRET=whsec_xxx
   PAYMENT_SUMUP_API_KEY=sup_sk_xxx
   PAYMENT_SUMUP_MERCHANT_CODE=Mxxxxxxx
   PAYMENT_PAYPAL_CLIENT_ID=xxx
   PAYMENT_PAYPAL_SECRET=xxx
   PAYMENT_PAYPAL_MODE=live
   PAYMENT_PAYMENTWALL_PROJECT_KEY=xxx
   PAYMENT_PAYMENTWALL_SECRET_KEY=xxx
   PAYMENT_PAYMENTWALL_WIDGET=p1_1
   ```
   A provider is only offered when its keys are present **and** it is enabled in
   `config/payment.default.js`.

3. Edit packages/currency in `config/payment.default.js` (hot-reloaded).

   **Choosing which methods are active** — set `active` in that config (or the
   `PAYMENT_PROVIDERS` env var, which wins):
   | value | result |
   |-------|--------|
   | `all` | every configured provider (default) |
   | `none` | disables all payment methods |
   | `stripe` | only that single method |
   | `["stripe","paypal"]` / `stripe,paypal` | only those, in that order |

   A method still needs its keys present and `providers.<id>.enabled !== false`.

4. Register the provider callbacks pointing at your public base URL:
   - **Stripe** → `{BASE}/shop/PaymentWebhookStripe`, event
     `checkout.session.completed` (also `checkout.session.expired`). Copy the
     signing secret into `PAYMENT_STRIPE_WEBHOOK_SECRET`.
   - **SumUp** → the checkout `return_url` is set automatically to
     `{BASE}/shop/PaymentWebhookSumUp`.
   - **PayPal** → in the app's webhooks, point to `{BASE}/shop/PaymentWebhookPayPal`
     (events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`). Crediting
     also happens synchronously when the buyer returns (the order is captured),
     so the webhook is a backup.
   - **Paymentwall** → set the project **Pingback URL** to
     `{BASE}/shop/PaymentPingbackPaymentwall` and whitelist the server IP. The
     widget is signed automatically by the SDK; crediting happens on the pingback.

5. Apply the DB change: the table is created automatically on next start
   (migration `v4` for existing DBs; `sync()` for fresh installs).

## Notes / limitations

- The webhook endpoints are registered **before** the shop session and IP-block
  middlewares, so they must stay publicly reachable by Stripe/SumUp.
- Even without webhooks the `PaymentReturn` page confirms the payment directly
  with the provider, so crediting still works — but configuring webhooks is
  recommended (covers users who close the tab after paying).
- Redirect-to-hosted-checkout works in a normal browser. Inside the in-game TERA
  client web view, opening an external checkout may be restricted; serve the shop
  through a standard browser for card payments, or adapt to an embedded card SDK.
- All prices are charged in the single `currency` from the config; for SumUp it
  must match your merchant account currency.

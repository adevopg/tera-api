"use strict";

/**
 * @typedef {import("../app").modules} modules
 *
 * @typedef {object} payment
 * @property {() => boolean} isEnabled
 * @property {() => object} getConfig
 * @property {() => object[]} getPackages
 * @property {(id: string) => object|null} getPackage
 * @property {() => {id: string, label: string}[]} availableProviders
 * @property {(opts: object) => Promise<{redirectUrl: string, providerRef: string}>} createCheckout
 * @property {(rawBody: Buffer, signature: string) => object} stripeConstructEvent
 * @property {(sessionId: string) => Promise<object>} stripeRetrieveSession
 * @property {(checkoutId: string) => Promise<object>} sumupGetCheckout
 * @property {(orderId: string) => Promise<object>} paypalGetOrder
 * @property {(orderId: string) => Promise<object>} paypalCaptureOrder
 * @property {(captureId: string) => Promise<object>} paypalGetCapture
 * @property {(query: object, ip: string) => object} paymentwallVerifyPingback
 * @property {(opts: object) => Promise<object|null>} settle
 */

const env = require("../utils/env");
const { createLogger } = require("../utils/logger");

const SUMUP_API_BASE = "https://api.sumup.com/v0.1";

/**
 * @param {modules} modules
 * @returns {Promise<payment>}
 */
module.exports = async modules => {
	const logger = createLogger("Payment", { colors: { debug: "magenta" } });

	const stripeSecret = env.string("PAYMENT_STRIPE_SECRET_KEY", "");
	const stripeWebhookSecret = env.string("PAYMENT_STRIPE_WEBHOOK_SECRET", "");
	const sumupApiKey = env.string("PAYMENT_SUMUP_API_KEY", "");
	const sumupMerchantCode = env.string("PAYMENT_SUMUP_MERCHANT_CODE", "");
	const paypalClientId = env.string("PAYMENT_PAYPAL_CLIENT_ID", "");
	const paypalSecret = env.string("PAYMENT_PAYPAL_SECRET", "");
	const paypalMode = env.string("PAYMENT_PAYPAL_MODE", "sandbox");
	const paymentwallProjectKey = env.string("PAYMENT_PAYMENTWALL_PROJECT_KEY", "");
	const paymentwallSecretKey = env.string("PAYMENT_PAYMENTWALL_SECRET_KEY", "");
	const paymentwallWidget = env.string("PAYMENT_PAYMENTWALL_WIDGET", "p1_1");

	let stripe = null;
	let Paymentwall = null;

	if (stripeSecret) {
		try {
			// eslint-disable-next-line global-require
			stripe = require("stripe")(stripeSecret);
			logger.info("Stripe provider initialized.");
		} catch (err) {
			logger.warn(`Stripe is configured but the "stripe" package is not installed: ${err.message}`);
		}
	}

	if (sumupApiKey && sumupMerchantCode) {
		logger.info("SumUp provider initialized.");
	}

	if (paypalClientId && paypalSecret) {
		logger.info(`PayPal provider initialized (${paypalMode} mode).`);
	}

	if (paymentwallProjectKey && paymentwallSecretKey) {
		try {
			// eslint-disable-next-line global-require
			Paymentwall = require("paymentwall");
			Paymentwall.Configure(
				Paymentwall.Base.API_GOODS,
				paymentwallProjectKey,
				paymentwallSecretKey
			);
			logger.info("Paymentwall provider initialized.");
		} catch (err) {
			logger.warn(`Paymentwall is configured but the "paymentwall" package is not installed: ${err.message}`);
		}
	}

	const cfg = () => modules.config.get("payment") || {};

	const toMinorUnits = price => Math.round(Number(price) * 100);

	// Resolves the list of selected method ids. Precedence: PAYMENT_PROVIDERS env
	// (comma-separated, e.g. "stripe,paypal" / "all" / "none") over config `active`.
	const resolveSelection = () => {
		const envSel = env.string("PAYMENT_PROVIDERS", "");

		if (envSel) {
			return envSel.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
		}

		const active = cfg().active;

		if (active === undefined || active === null || active === "all") {
			return ["all"];
		}

		return (Array.isArray(active) ? active : [active]).map(s => String(s).trim().toLowerCase());
	};

	// Whether a provider is selected by the active-methods option.
	const isActive = id => {
		const selection = resolveSelection();

		if (selection.includes("none")) {
			return false;
		}

		if (selection.includes("all")) {
			return true;
		}

		return selection.includes(id);
	};

	const hasCredentials = id => {
		if (id === "stripe") {
			return !!stripe;
		}

		if (id === "sumup") {
			return !!(sumupApiKey && sumupMerchantCode);
		}

		if (id === "paypal") {
			return !!(paypalClientId && paypalSecret);
		}

		if (id === "paymentwall") {
			return !!Paymentwall;
		}

		return false;
	};

	// A provider shows up only when: it is selected (active option) AND has its
	// credentials AND is not individually disabled in config.providers.<id>.
	const isProviderReady = id => {
		const providers = cfg().providers || {};

		return isActive(id) && hasCredentials(id) && providers[id]?.enabled !== false;
	};

	const getPackages = () => (cfg().packages || []).map(p => ({
		id: p.id,
		coins: p.coins,
		price: p.price,
		amount: toMinorUnits(p.price),
		currency: cfg().currency || "EUR",
		bonus: p.bonus || 0,
		popular: !!p.popular
	}));

	const getPackage = id => getPackages().find(p => p.id === id) || null;

	const ALL_PROVIDERS = ["stripe", "sumup", "paypal", "paymentwall"];

	const availableProviders = () => {
		const providers = cfg().providers || {};
		const selection = resolveSelection();

		// When an explicit ordered list is configured, honour that order;
		// otherwise fall back to the canonical order.
		const order = selection.includes("all") || selection.includes("none")
			? ALL_PROVIDERS
			: [...selection.filter(id => ALL_PROVIDERS.includes(id)),
				...ALL_PROVIDERS.filter(id => !selection.includes(id))];

		return order
			.filter(isProviderReady)
			.map(id => ({ id, label: providers[id]?.label || id }));
	};

	const isEnabled = () => cfg().enabled !== false && availableProviders().length > 0;

	// ── SumUp REST helpers ───────────────────────────────────────────────────
	const sumupRequest = async (method, pathName, body) => {
		const res = await fetch(`${SUMUP_API_BASE}${pathName}`, {
			method,
			headers: {
				"Authorization": `Bearer ${sumupApiKey}`,
				"Content-Type": "application/json"
			},
			body: body ? JSON.stringify(body) : undefined
		});

		const text = await res.text();
		const data = text ? JSON.parse(text) : {};

		if (!res.ok) {
			throw new Error(`SumUp API ${method} ${pathName} failed (${res.status}): ${text}`);
		}

		return data;
	};

	const sumupGetCheckout = checkoutId => sumupRequest("GET", `/checkouts/${encodeURIComponent(checkoutId)}`);

	// ── PayPal REST helpers (Orders v2) ────────────────────────────────────────
	const paypalApiBase = () => (paypalMode === "live"
		? "https://api-m.paypal.com"
		: "https://api-m.sandbox.paypal.com");

	let paypalToken = { value: null, expiresAt: 0 };

	const paypalAccessToken = async () => {
		if (paypalToken.value && Date.now() < paypalToken.expiresAt) {
			return paypalToken.value;
		}

		const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
			method: "POST",
			headers: {
				"Authorization": `Basic ${Buffer.from(`${paypalClientId}:${paypalSecret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded"
			},
			body: "grant_type=client_credentials"
		});

		const data = await res.json();

		if (!res.ok) {
			throw new Error(`PayPal token request failed (${res.status}): ${JSON.stringify(data)}`);
		}

		paypalToken = {
			value: data.access_token,
			expiresAt: Date.now() + ((data.expires_in || 3000) - 60) * 1000
		};

		return paypalToken.value;
	};

	const paypalRequest = async (method, pathName, body) => {
		const token = await paypalAccessToken();

		const res = await fetch(`${paypalApiBase()}${pathName}`, {
			method,
			headers: {
				"Authorization": `Bearer ${token}`,
				"Content-Type": "application/json"
			},
			body: body ? JSON.stringify(body) : undefined
		});

		const text = await res.text();
		const data = text ? JSON.parse(text) : {};

		if (!res.ok) {
			throw new Error(`PayPal API ${method} ${pathName} failed (${res.status}): ${text}`);
		}

		return data;
	};

	const paypalGetOrder = orderId => paypalRequest("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
	const paypalCaptureOrder = orderId => paypalRequest("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
	const paypalGetCapture = captureId => paypalRequest("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);

	// ── Checkout creation ─────────────────────────────────────────────────────
	/**
	 * @param {{provider: string, pkg: object, tx: object, baseUrl: string}} opts
	 */
	const createCheckout = async ({ provider, pkg, tx, baseUrl }) => {
		const base = String(baseUrl || "").replace(/\/+$/, "");
		const currency = cfg().currency || "EUR";

		if (provider === "stripe") {
			if (!stripe) {
				throw new Error("Stripe provider is not available");
			}

			const session = await stripe.checkout.sessions.create({
				mode: "payment",
				payment_method_types: ["card"],
				line_items: [{
					price_data: {
						currency: currency.toLowerCase(),
						unit_amount: tx.get("amount"),
						product_data: {
							name: `${pkg.coins} coins${pkg.bonus ? ` (+${pkg.bonus} bonus)` : ""}`
						}
					},
					quantity: 1
				}],
				client_reference_id: String(tx.get("id")),
				metadata: {
					txId: String(tx.get("id")),
					accountDBID: String(tx.get("accountDBID")),
					provider: "stripe"
				},
				success_url: `${base}/shop/PaymentReturn?provider=stripe&tx=${tx.get("id")}&status=success`,
				cancel_url: `${base}/shop/PaymentReturn?provider=stripe&tx=${tx.get("id")}&status=cancel`
			});

			return { redirectUrl: session.url, providerRef: session.id };
		}

		if (provider === "sumup") {
			if (!isProviderReady("sumup")) {
				throw new Error("SumUp provider is not available");
			}

			const data = await sumupRequest("POST", "/checkouts", {
				checkout_reference: `tx-${tx.get("id")}`,
				amount: Number((tx.get("amount") / 100).toFixed(2)),
				currency,
				merchant_code: sumupMerchantCode,
				description: `${pkg.coins} coins${pkg.bonus ? ` (+${pkg.bonus} bonus)` : ""}`,
				redirect_url: `${base}/shop/PaymentReturn?provider=sumup&tx=${tx.get("id")}`,
				// Hosted Checkout: SumUp returns a `hosted_checkout_url` to send the
				// customer to. Without this flag the API only returns a checkout id
				// (status PENDING) and no payable URL, which is why the payment could
				// not be started. No webhook is needed: the return page re-fetches the
				// checkout status from the API (see PaymentReturnHtml / sumupGetCheckout).
				hosted_checkout: { enabled: true }
			});

			const redirectUrl = data.hosted_checkout_url;

			if (!redirectUrl) {
				throw new Error(`SumUp did not return a hosted_checkout_url: ${JSON.stringify(data)}`);
			}

			// Store the checkout id (not the reference) so GET /checkouts/{id} works
			// when the return page confirms the payment status.
			return {
				redirectUrl,
				providerRef: data.id
			};
		}

		if (provider === "paypal") {
			if (!isProviderReady("paypal")) {
				throw new Error("PayPal provider is not available");
			}

			const order = await paypalRequest("POST", "/v2/checkout/orders", {
				intent: "CAPTURE",
				purchase_units: [{
					reference_id: `tx-${tx.get("id")}`,
					custom_id: String(tx.get("id")),
					description: `${pkg.coins} coins${pkg.bonus ? ` (+${pkg.bonus} bonus)` : ""}`,
					amount: {
						currency_code: currency,
						value: (tx.get("amount") / 100).toFixed(2)
					}
				}],
				application_context: {
					brand_name: "TERA Shop",
					user_action: "PAY_NOW",
					return_url: `${base}/shop/PaymentReturn?provider=paypal&tx=${tx.get("id")}`,
					cancel_url: `${base}/shop/PaymentReturn?provider=paypal&tx=${tx.get("id")}&status=cancel`
				}
			});

			const approve = (order.links || []).find(link => link.rel === "approve");

			if (!approve) {
				throw new Error("PayPal did not return an approval link");
			}

			return { redirectUrl: approve.href, providerRef: order.id };
		}

		if (provider === "paymentwall") {
			if (!Paymentwall) {
				throw new Error("Paymentwall provider is not available");
			}

			const widget = new Paymentwall.Widget(
				String(tx.get("accountDBID")),
				paymentwallWidget,
				[
					new Paymentwall.Product(
						pkg.id,
						Number((tx.get("amount") / 100).toFixed(2)),
						currency,
						`${pkg.coins} coins${pkg.bonus ? ` (+${pkg.bonus} bonus)` : ""}`,
						Paymentwall.Product.TYPE_FIXED
					)
				],
				{
					// Echoed back in the pingback so we can match the transaction.
					tx: String(tx.get("id")),
					success_url: `${base}/shop/PaymentReturn?provider=paymentwall&tx=${tx.get("id")}`
				}
			);

			return { redirectUrl: widget.getUrl(), providerRef: `pw-${tx.get("id")}` };
		}

		throw new Error(`Unknown payment provider: ${provider}`);
	};

	const stripeRetrieveSession = sessionId => {
		if (!stripe) {
			throw new Error("Stripe provider is not available");
		}

		return stripe.checkout.sessions.retrieve(sessionId);
	};

	/**
	 * Validates a Paymentwall pingback (signature + IP whitelist) and reports
	 * what action it represents.
	 *
	 * @param {object} query parsed pingback GET parameters
	 * @param {string} ip remote address of the pingback request
	 * @returns {{valid: boolean, deliverable: boolean, cancelable: boolean, txId: string|null, error: string|null}}
	 */
	const paymentwallVerifyPingback = (query, ip) => {
		if (!Paymentwall) {
			return { valid: false, deliverable: false, cancelable: false, txId: null, error: "Paymentwall not available" };
		}

		const pingback = new Paymentwall.Pingback(query, ip);
		const valid = pingback.validate();

		return {
			valid,
			deliverable: valid && pingback.isDeliverable(),
			cancelable: valid && pingback.isCancelable(),
			txId: query.tx || null,
			error: valid ? null : pingback.getErrorSummary()
		};
	};

	const stripeConstructEvent = (rawBody, signature) => {
		if (!stripe) {
			throw new Error("Stripe provider is not available");
		}

		if (!stripeWebhookSecret) {
			throw new Error("PAYMENT_STRIPE_WEBHOOK_SECRET is not configured");
		}

		return stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
	};

	// ── Idempotent settlement ──────────────────────────────────────────────────
	/**
	 * Marks a transaction as paid (crediting the shop balance exactly once) or
	 * failed/canceled. Safe to call multiple times for the same transaction.
	 *
	 * @param {{txId?: number, provider?: string, providerRef?: string, paid: boolean, reason?: string}} opts
	 * @returns {Promise<object|null>} the updated transaction, or null if not found
	 */
	const settle = ({ txId, provider, providerRef, paid, reason }) =>
		modules.sequelize.transaction(async transaction => {
			const where = txId ? { id: txId } : { provider, providerRef };

			const tx = await modules.shopModel.payTransactions.findOne({
				where,
				lock: transaction.LOCK.UPDATE
			});

			if (tx === null) {
				logger.warn(`Settle: transaction not found (${JSON.stringify(where)})`);
				return null;
			}

			// Already finalized -> idempotent no-op.
			if (tx.get("status") !== "pending") {
				return tx;
			}

			if (!paid) {
				await tx.update({ status: reason === "canceled" ? "canceled" : "failed" });
				return tx;
			}

			let shopAccount = await modules.shopModel.accounts.findOne({
				where: { accountDBID: tx.get("accountDBID") },
				lock: transaction.LOCK.UPDATE
			});

			if (shopAccount === null) {
				shopAccount = await modules.shopModel.accounts.create({
					accountDBID: tx.get("accountDBID"),
					balance: 0,
					active: true
				});
			}

			const newBalance = shopAccount.get("balance") + tx.get("coins");

			const fund = await modules.reportModel.shopFund.create({
				accountDBID: tx.get("accountDBID"),
				amount: tx.get("coins"),
				balance: newBalance,
				description: `Topup,${tx.get("provider")},${tx.get("id")}`
			});

			await modules.shopModel.accounts.increment({
				balance: tx.get("coins")
			}, {
				where: { accountDBID: tx.get("accountDBID") }
			});

			await tx.update({
				status: "paid",
				fundId: fund.get("id"),
				paidAt: new Date()
			});

			logger.info(`Credited ${tx.get("coins")} coins to account ${tx.get("accountDBID")} (tx ${tx.get("id")}, ${tx.get("provider")}).`);

			return tx;
		});

	return {
		isEnabled,
		getConfig: cfg,
		getPackages,
		getPackage,
		availableProviders,
		createCheckout,
		stripeConstructEvent,
		stripeRetrieveSession,
		sumupGetCheckout,
		paypalGetOrder,
		paypalCaptureOrder,
		paypalGetCapture,
		paymentwallVerifyPingback,
		settle
	};
};

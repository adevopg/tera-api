"use strict";

/**
 * @typedef {import("express").RequestHandler} RequestHandler
 * @typedef {import("../app").modules} modules
 */

const env = require("../utils/env");
const { body } = require("express-validator");

const ApiError = require("../lib/apiError");

const {
	validationHandler,
	authSessionHandler,
	shopStatusHandler
} = require("../middlewares/portalShop.middlewares");


// ───────────────────────────────────────────────────────────────────────────
// Buy Coins page (partial loaded by the SPA shop)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.PartialBuyCoinsHtml = ({ i18n, logger, payment }) => [
	shopStatusHandler,
	authSessionHandler(logger),
	/**
	 * @type {RequestHandler}
	 */
	(req, res) => {
		res.render("partials/shopBuyCoins", {
			enabled: payment.isEnabled(),
			packages: payment.getPackages(),
			providers: payment.availableProviders(),
			currency: payment.getConfig().currency || "EUR"
		});
	}
];

// ───────────────────────────────────────────────────────────────────────────
// JSON: list packages / providers
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.GetCoinPackages = ({ logger, payment }) => [
	shopStatusHandler,
	authSessionHandler(logger),
	/**
	 * @type {RequestHandler}
	 */
	(req, res) => {
		res.json({
			Return: true,
			ReturnCode: 0,
			Msg: "success",
			enabled: payment.isEnabled(),
			currency: payment.getConfig().currency || "EUR",
			packages: payment.getPackages(),
			providers: payment.availableProviders()
		});
	}
];

// ───────────────────────────────────────────────────────────────────────────
// JSON: create a checkout and return the redirect URL
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.CreatePaymentAction = modules => [
	shopStatusHandler,
	authSessionHandler(modules.logger),
	[
		body("packageId").trim().notEmpty(),
		body("provider").trim().notEmpty()
	],
	validationHandler(modules.logger),
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		const { payment, shopModel, logger } = modules;
		const { packageId, provider } = req.body;

		if (!payment.isEnabled()) {
			throw new ApiError("Payments are currently disabled", 1000);
		}

		if (!payment.availableProviders().some(p => p.id === provider)) {
			throw new ApiError("Unknown or unavailable payment provider", 1000);
		}

		const pkg = payment.getPackage(packageId);

		if (!pkg) {
			throw new ApiError("Unknown coin package", 1000);
		}

		const config = payment.getConfig();

		if (pkg.price < (config.minPrice || 0) || pkg.price > (config.maxPrice || Infinity)) {
			throw new ApiError("Package price is out of allowed bounds", 1000);
		}

		// Create the pending transaction first so we have a stable id/reference.
		const tx = await shopModel.payTransactions.create({
			accountDBID: req.user.accountDBID,
			provider,
			packageId: pkg.id,
			coins: pkg.coins,
			amount: pkg.amount,
			currency: pkg.currency,
			status: "pending",
			ip: req.ip
		});

		try {
			const { redirectUrl, providerRef } = await payment.createCheckout({
				provider,
				pkg,
				tx
			});

			await tx.update({ providerRef });

			res.json({
				Return: true,
				ReturnCode: 0,
				Msg: "success",
				transactionId: tx.get("id"),
				redirectUrl
			});
		} catch (err) {
			logger.error(`CreatePayment failed: ${err.message}`);
			await tx.update({ status: "failed" });
			throw new ApiError("Could not start the payment. Please try again later.", 1);
		}
	}
];

// ───────────────────────────────────────────────────────────────────────────
// JSON: poll a transaction status (used by the return page)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.PaymentStatusAction = ({ logger, shopModel }) => [
	shopStatusHandler,
	authSessionHandler(logger),
	[
		body("transactionId").trim().notEmpty().isInt()
	],
	validationHandler(logger),
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		const tx = await shopModel.payTransactions.findOne({
			where: {
				id: req.body.transactionId,
				accountDBID: req.user.accountDBID
			}
		});

		if (tx === null) {
			throw new ApiError("Transaction not found", 1000);
		}

		const shopAccount = await shopModel.accounts.findOne({
			where: { accountDBID: req.user.accountDBID }
		});

		res.json({
			Return: true,
			ReturnCode: 0,
			Msg: "success",
			status: tx.get("status"),
			coins: tx.get("coins"),
			shopBalance: shopAccount !== null ? shopAccount.get("balance") : 0
		});
	}
];

// ───────────────────────────────────────────────────────────────────────────
// HTML: landing page after the provider redirect
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.PaymentReturnHtml = modules => [
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		const { payment, shopModel, logger } = modules;
		const { provider, tx: txId, status } = req.query;

		let finalStatus = "pending";

		try {
			const tx = txId ? await shopModel.payTransactions.findOne({ where: { id: txId } }) : null;

			if (tx === null) {
				finalStatus = "unknown";
			} else if (tx.get("status") !== "pending") {
				finalStatus = tx.get("status");
			} else if (status === "cancel") {
				await payment.settle({ txId: tx.get("id"), paid: false, reason: "canceled" });
				finalStatus = "canceled";
			} else {
				// Confirm with the provider (works even if webhooks aren't set up yet).
				let paid = false;

				if (provider === "stripe") {
					const session = await payment.stripeRetrieveSession(tx.get("providerRef"));
					paid = session?.payment_status === "paid";
				} else if (provider === "sumup") {
					const checkout = await payment.sumupGetCheckout(tx.get("providerRef"));
					paid = checkout?.status === "PAID";
				} else if (provider === "paypal") {
					// Capture the approved order; if it was already captured, just read it back.
					try {
						const capture = await payment.paypalCaptureOrder(tx.get("providerRef"));
						paid = capture?.status === "COMPLETED";
					} catch (captureErr) {
						logger.warn(`PayPal capture fallback: ${captureErr.message}`);
						const order = await payment.paypalGetOrder(tx.get("providerRef"));
						paid = order?.status === "COMPLETED";
					}
				} else if (provider === "paymentwall") {
					// Paymentwall confirms via server-to-server pingback; nothing to
					// confirm synchronously here. The return page will poll the status.
					paid = false;
				}

				if (paid) {
					await payment.settle({ txId: tx.get("id"), paid: true });
					finalStatus = "paid";
				}
			}
		} catch (err) {
			logger.error(`PaymentReturn error: ${err.message}`);
		}

		res.render("shopPaymentReturn", {
			transactionId: txId || "",
			status: finalStatus
		});
	}
];

// ───────────────────────────────────────────────────────────────────────────
// Webhook: Stripe (signature-verified, no session)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.StripeWebhook = ({ logger, payment }) =>
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		let event;

		try {
			event = payment.stripeConstructEvent(req.rawBody, req.headers["stripe-signature"]);
		} catch (err) {
			logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
			return res.status(400).send(`Webhook Error: ${err.message}`);
		}

		try {
			const session = event.data?.object || {};
			const txId = session.metadata?.txId;

			if (txId) {
				if (event.type === "checkout.session.completed" && session.payment_status === "paid") {
					await payment.settle({ txId, paid: true });
				} else if (event.type === "checkout.session.expired" ||
					event.type === "checkout.session.async_payment_failed") {
					await payment.settle({ txId, paid: false, reason: "failed" });
				}
			}
		} catch (err) {
			logger.error(`Stripe webhook handling error: ${err.message}`);
		}

		res.json({ received: true });
	}
;

// ───────────────────────────────────────────────────────────────────────────
// Webhook: SumUp (status re-fetched from the API, never trusted blindly)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */


// ───────────────────────────────────────────────────────────────────────────
// Webhook: PayPal (order/capture re-fetched from the API, never trusted blindly)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.PayPalWebhook = ({ logger, payment }) =>
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		try {
			const event = req.body || {};
			const resource = event.resource || {};

			if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && resource.id) {
				const capture = await payment.paypalGetCapture(resource.id);

				if (capture?.status === "COMPLETED" && capture.custom_id) {
					await payment.settle({ txId: capture.custom_id, paid: true });
				}
			} else if (event.event_type === "PAYMENT.CAPTURE.DENIED" && resource.custom_id) {
				await payment.settle({ txId: resource.custom_id, paid: false, reason: "failed" });
			} else if (event.event_type === "CHECKOUT.ORDER.APPROVED" && resource.id) {
				// Capture the order, then credit using the capture's custom_id.
				try {
					const order = await payment.paypalCaptureOrder(resource.id);
					const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];

					if (order?.status === "COMPLETED" && capture?.custom_id) {
						await payment.settle({ txId: capture.custom_id, paid: true });
					}
				} catch (captureErr) {
					logger.warn(`PayPal webhook capture failed: ${captureErr.message}`);
				}
			}
		} catch (err) {
			logger.error(`PayPal webhook handling error: ${err.message}`);
		}

		res.status(200).json({ received: true });
	}
;

// ───────────────────────────────────────────────────────────────────────────
// Pingback: Paymentwall (signature + IP validated by the SDK)
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {modules} modules
 */
module.exports.PaymentwallPingback = ({ logger, payment }) =>
	/**
	 * @type {RequestHandler}
	 */
	async (req, res) => {
		try {
			const result = payment.paymentwallVerifyPingback(req.query, req.ip);

			if (!result.valid) {
				logger.warn(`Paymentwall pingback rejected: ${result.error}`);
				return res.status(403).send(result.error || "Invalid pingback");
			}

			if (result.txId) {
				if (result.deliverable) {
					await payment.settle({ txId: result.txId, paid: true });
				} else if (result.cancelable) {
					await payment.settle({ txId: result.txId, paid: false, reason: "failed" });
				}
			}
		} catch (err) {
			logger.error(`Paymentwall pingback handling error: ${err.message}`);
			return res.status(500).send("Error");
		}

		// Paymentwall expects the literal "OK" body to mark the pingback handled.
		res.status(200).send("OK");
	}
;

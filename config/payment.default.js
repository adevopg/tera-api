"use strict";

// THE CHANGES MADE ARE APPLIED WITHOUT RESTARTING THE PROCESS.
//
// Online "Buy Coins" top-up configuration (Stripe + SumUp).
// Secret keys/tokens are read from environment variables (see .env.example),
// NOT from this file. Here you only configure packages, currency and behaviour.

module.exports = {
	// Master switch for the whole "Buy Coins" feature.
	enabled: true,

	// Which payment methods are offered. Accepts:
	//   "all"                       -> every configured provider (default)
	//   "none"                      -> disable all of them
	//   "stripe"                    -> only that single provider
	//   ["stripe", "paypal"]        -> only those providers, in this order
	// Valid ids: "stripe", "sumup", "paypal", "paymentwall".
	// The PAYMENT_PROVIDERS environment variable (comma-separated) overrides this.
	// A provider still needs its keys present and its `providers.<id>.enabled`
	// flag to be true to actually show up.
	active: "all",

	// ISO 4217 currency used for all packages and checkouts (e.g. "EUR", "USD").
	// For SumUp it MUST match your merchant account currency.
	currency: "EUR",

	// Coin packages shown on the "Buy Coins" page.
	//   id      - stable identifier (string), used as the order reference
	//   coins   - amount of shop balance credited on a successful payment
	//   price   - price in MAJOR currency units (e.g. 4.99 = 4 EUR 99 cents)
	//   bonus   - optional extra coins highlighted in the UI (already included in `coins`)
	//   popular - optional flag to highlight the package
	packages: [
		{ id: "coins_500", coins: 500, price: 4.99 },
		{ id: "coins_1100", coins: 1100, price: 9.99, bonus: 100, popular: true },
		{ id: "coins_2400", coins: 2400, price: 19.99, bonus: 400 },
		{ id: "coins_6500", coins: 6500, price: 49.99, bonus: 1500 }
	],

	// Payment providers. `enabled` here is an extra gate on top of the presence
	// of the corresponding secret keys in the environment.
	providers: {
		stripe: {
			enabled: true,
			label: "Card (Stripe)"
		},
		sumup: {
			enabled: true,
			label: "Card (SumUp)"
		},
		paypal: {
			enabled: true,
			label: "PayPal"
		},
		paymentwall: {
			enabled: true,
			label: "Paymentwall"
		}
	},

	// Minimum/maximum sanity bounds for a single top-up (in `currency`).
	minPrice: 1,
	maxPrice: 1000
};

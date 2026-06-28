"use strict";

/**
* @typedef {import("../shop.model").Sequelize} Sequelize
* @typedef {import("../shop.model").DataTypes} DataTypes
*/

/**
* Online top-up ("Buy Coins") transactions made through an external payment
* provider (Stripe, SumUp). One row per checkout attempt. The row is the single
* source of truth for idempotent crediting: balance is only added once, when the
* status transitions to "paid".
*
* @param {Sequelize} sequelize
* @param {DataTypes} DataTypes
*/
module.exports = (sequelize, DataTypes) =>
	sequelize.define("shop_pay_transactions", {
		id: {
			type: DataTypes.BIGINT(20),
			primaryKey: true,
			autoIncrement: true,
			allowNull: false
		},
		accountDBID: {
			type: DataTypes.BIGINT(20),
			allowNull: false
		},
		provider: {
			type: DataTypes.STRING(16),
			allowNull: false
		},
		// Provider-side identifier (Stripe Checkout Session id / SumUp checkout id).
		providerRef: {
			type: DataTypes.STRING(255),
			allowNull: true
		},
		packageId: {
			type: DataTypes.STRING(64),
			allowNull: false
		},
		// Coins credited to the shop balance on success.
		coins: {
			type: DataTypes.INTEGER(11),
			allowNull: false
		},
		// Charged price in MINOR currency units (e.g. cents) to avoid float drift.
		amount: {
			type: DataTypes.INTEGER(11),
			allowNull: false
		},
		currency: {
			type: DataTypes.STRING(3),
			allowNull: false
		},
		// pending | paid | failed | canceled
		status: {
			type: DataTypes.STRING(16),
			allowNull: false,
			defaultValue: "pending"
		},
		ip: {
			type: DataTypes.STRING(64),
			allowNull: true
		},
		// id of the report_shop_fund row created when the balance was credited.
		fundId: {
			type: DataTypes.BIGINT(20),
			allowNull: true
		},
		paidAt: {
			type: DataTypes.DATE,
			allowNull: true
		}
	}, {
		indexes: [
			{
				name: "accountDBID",
				unique: false,
				fields: ["accountDBID"]
			},
			{
				name: "providerRef",
				unique: false,
				fields: ["providerRef"]
			},
			{
				name: "status",
				unique: false,
				fields: ["status"]
			}
		],
		timestamps: true
	})
;

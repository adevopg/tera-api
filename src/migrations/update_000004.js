"use strict";

/**
 * @typedef {import("sequelize")} Sequelize
 * @typedef {import("sequelize").QueryInterface} QueryInterface
 */

module.exports = {
	VERSION: 4,

	/**
	 * Adds the `shop_pay_transactions` table used by the online "Buy Coins"
	 * top-up feature (Stripe / SumUp).
	 *
	 * @param {QueryInterface} queryInterface
	 * @param {Sequelize} Sequelize
	 */
	up: async (queryInterface, Sequelize) => {
		await queryInterface.createTable("shop_pay_transactions", {
			id: {
				type: Sequelize.DataTypes.BIGINT(20),
				primaryKey: true,
				autoIncrement: true,
				allowNull: false
			},
			accountDBID: {
				type: Sequelize.DataTypes.BIGINT(20),
				allowNull: false
			},
			provider: {
				type: Sequelize.DataTypes.STRING(16),
				allowNull: false
			},
			providerRef: {
				type: Sequelize.DataTypes.STRING(255),
				allowNull: true
			},
			packageId: {
				type: Sequelize.DataTypes.STRING(64),
				allowNull: false
			},
			coins: {
				type: Sequelize.DataTypes.INTEGER(11),
				allowNull: false
			},
			amount: {
				type: Sequelize.DataTypes.INTEGER(11),
				allowNull: false
			},
			currency: {
				type: Sequelize.DataTypes.STRING(3),
				allowNull: false
			},
			status: {
				type: Sequelize.DataTypes.STRING(16),
				allowNull: false,
				defaultValue: "pending"
			},
			ip: {
				type: Sequelize.DataTypes.STRING(64),
				allowNull: true
			},
			fundId: {
				type: Sequelize.DataTypes.BIGINT(20),
				allowNull: true
			},
			paidAt: {
				type: Sequelize.DataTypes.DATE,
				allowNull: true
			},
			createdAt: {
				type: Sequelize.DataTypes.DATE,
				allowNull: false
			},
			updatedAt: {
				type: Sequelize.DataTypes.DATE,
				allowNull: false
			}
		});

		await queryInterface.addIndex("shop_pay_transactions", ["accountDBID"], {
			unique: false,
			name: "accountDBID"
		});
		await queryInterface.addIndex("shop_pay_transactions", ["providerRef"], {
			unique: false,
			name: "providerRef"
		});
		await queryInterface.addIndex("shop_pay_transactions", ["status"], {
			unique: false,
			name: "status"
		});
	},

	/**
	 * @param {QueryInterface} queryInterface
	 * @param {Sequelize} Sequelize
	 */
	down: async queryInterface => {
		await queryInterface.dropTable("shop_pay_transactions");
	}
};

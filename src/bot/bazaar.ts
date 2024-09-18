import { BazaarUpdateData, Order, Product } from "../shared/types";
import logger from "../shared/logger";
import { jsoncSafe } from "jsonc/lib/jsonc.safe";
import { globals } from "../shared/globals";
import { existsSync } from "fs";
import { clean, findItem, getCleanLore, getNbt } from "./bot-utils";
import { wait } from "../shared/utils";
import assert from "assert";
import { ChatMessage } from "prismarine-chat";
import BotManager from "./bot-manager";

export default class Bazaar {
	static readonly DAILY_LIMIT = 15_000_000_000;

	usedDailyLimit = 0;
	limitResetTime = 0;
	products: Product[] = [];
	orders: Order[] = [];
	expectedOrders?: number;

	constructor(public manager: BotManager) {
		manager.bot.on(
			"message",
			(message: ChatMessage) => {
				if (
					message
						.toString()
						.startsWith(
							"[Bazaar] You reached the daily limit of coins you may spend on the Bazaar!"
						) ||
					message
						.toString()
						.startsWith(
							"[Bazaar] You reached the daily limit in items value that you may sell on the bazaar!"
						)
				) {
					logger.debug("Daily limit reached");
					this.usedDailyLimit = Bazaar.DAILY_LIMIT;
					this.checkLimit();
				} else if (
					message.toString().startsWith("You consumed a Booster Cookie!")
				) {
					logger.debug("Cookie consumed");
					manager.hasCookie = true;
				}
			},
			{ persistent: true }
		);
		this.loadLimits();
	}

	async updateLimit() {
		const currentDate = new Date();
		const nextUTCDay = new Date(currentDate);
		nextUTCDay.setUTCDate(currentDate.getUTCDate() + 1);
		nextUTCDay.setUTCHours(0, 0, 0, 0);

		if (this.limitResetTime <= currentDate.getTime()) {
			logger.debug("New day, resetting used daily limit back to zero");

			this.limitResetTime = nextUTCDay.getTime();
			this.usedDailyLimit = 0;
			this.sentNotification = false;
			await this.saveLimit();
			return true;
		}

		return false;
	}

	sentNotification = false;
	checkLimit() {
		if (this.usedDailyLimit >= Bazaar.DAILY_LIMIT) {
			logger.debug("Daily limit reached");
			this.usedDailyLimit = Bazaar.DAILY_LIMIT;
			this.sentNotification = true;
			this.manager.postNotification(
				"Daily limit reached",
				`The daily limit for ${this.manager.account.username} has been reached, no further Bazaar transactions can be made`,
				2
			);
		}
	}

	async saveLimit() {
		if (!this.manager.account.email) return;

		const data = {
			usedDailyLimit: this.usedDailyLimit,
			limitResetTime: this.limitResetTime,
		};

		const [error] = await jsoncSafe.write(
			globals.ACCOUNT_LIMIT_CACHE(this.manager.account.email),
			data,
			{
				space: "\t",
			}
		);
		if (error)
			logger.error(
				`Error saving limits for ${this.manager.account.username}: ${error.message}`
			);
		return this;
	}

	async loadLimits() {
		if (!this.manager.account.email) return;
		if (!existsSync(globals.ACCOUNT_LIMIT_CACHE(this.manager.account.email)))
			return;
		const [error, data] = await jsoncSafe.read(
			globals.ACCOUNT_LIMIT_CACHE(this.manager.account.email)
		);

		this.usedDailyLimit = data?.usedDailyLimit ?? 0;
		this.limitResetTime = data?.limitResetTime ?? 0;
		if (error) {
			await this.saveLimit();
			logger.error(
				`Error loading limits for ${this.manager.account.username}: ${error}`
			);
		}

		return this;
	}

	async openBz(search?: string) {
		const bot = this.manager.bot;

		logger.debug(`Opening Bazaar${search ? ` for '${search}'` : ""}`);
		if (this.manager.location !== "island") return;

		try {
			if (bot.currentWindow) {
				bot.closeWindow(bot.currentWindow);
				await wait(400);
			}
			await this.manager.sendChat(`/bz${search ? " " + search : ""}`);
			await this.manager.waitForBotEvent("windowOpen");
			this.manager.hasCookie = true;
			await wait(500);
		} catch (err) {
			throw new Error(`Failed to open Bazaar: ${err}`);
		}
	}

	async openManageOrders(retries = 5) {
		logger.debug("Opening Manage Orders");

		try {
			await this.openBz();
			while (
				this.manager.bot?.currentWindow &&
				!this.manager.bot.currentWindow.title.includes("Bazaar Orders")
			)
				await this.manager.clickItem("Manage Orders");

			this.updateOrders();
			if (
				this.expectedOrders &&
				((this.orders.length === 0 &&
					this.expectedOrders !== this.orders.length) ||
					Math.abs(this.orders.length - this.expectedOrders)) &&
				retries > 0
			) {
				if (this.manager.bot.currentWindow)
					this.manager.bot.closeWindow(this.manager.bot.currentWindow);
				logger.debug(
					`Expected ${this.expectedOrders} orders, found ${this.orders.length}`
				);
				await this.openManageOrders(retries - 1);
			} else {
				this.expectedOrders = this.orders.length;
				this.postUpdate(true);
			}
		} catch (err) {
			throw new Error(
				`Failed to open Manage Orders: ${err} (in window ${this.manager.bot.currentWindow?.title})`
			);
		}
	}

	postUpdate(validated?: boolean) {
		this.manager.postEvent("bazaar-update", this.serialize(validated));
	}

	lastValidated: BazaarUpdateData = {
		orders: [],
		spent: 0,
		ordersWorth: 0,
		inventoryWorth: 0,
		total: 0,
		usedDailyLimit: 0,
		purse: 0,
	};
	serialize(validated?: boolean): BazaarUpdateData {
		if (validated) {
			this.lastValidated = {
				orders: this.orders,
				spent: this.getSpent(),
				ordersWorth: this.getOrdersWorth(),
				inventoryWorth: this.getInvWorth(),
				total: this.getTotal(),
				usedDailyLimit: this.usedDailyLimit,
				purse: this.manager.getPurse(),
			};
		}
		return this.lastValidated;
	}

	async createOrder(order: Order): Promise<void> {
		const product = this.getProduct(order.productId);
		logger.debug(`Creating order ${JSON.stringify(order)}`);
		assert(product != null);

		const bot = this.manager.bot;

		try {
			await this.openBz(product.name);
			await this.manager.clickItem(product.name);
			await this.manager.clickItem(
				`Create ${order.type === "buy" ? "Buy Order" : "Sell Offer"}`
			);

			if (order.type === "buy") {
				let maxAmount = Number(
					/Buy up to ([\d,]+)x/
						.exec(getCleanLore(findItem("Custom Amount", bot.currentWindow)))
						?.at(1)
						?.replaceAll(",", "")
				);
				if (isNaN(maxAmount)) {
					maxAmount = 256;
					logger.debug(
						`Failed to find maximum amount for ${
							order.productId
						} ${JSON.stringify(
							findItem("Custom Amount", bot.currentWindow) ?? {}
						)}`
					);
				}
				await this.manager.clickItem(
					"Custom Amount",
					0,
					this.manager.writeToSign(
						String(Math.floor(Math.min(order.amount ?? 1, maxAmount)))
					)
				);
				await this.manager.waitForBotEvent("windowOpen");
				await wait(250);
			}
			const topPrice = Number(
				/Unit price: ([\d,]*\.?\d) coins/
					.exec(
						getCleanLore(
							findItem(
								order.type === "buy" ? "Top Order +0.1" : "Best Offer -0.1",
								bot.currentWindow
							)
						)
					)
					?.at(1)
					?.replaceAll(",", "")
			);
			if (isNaN(topPrice)) {
				logger.error(
					`Failed to top price for ${order.productId} ${JSON.stringify(
						findItem("Custom Amount", bot.currentWindow) ?? {}
					)}`
				);
			}

			if (topPrice > this.manager.config.options.filter.maxPrice) {
				await this.manager.clickItem(
					"Custom Price",
					0,
					this.manager.writeToSign(
						String(this.manager.config.options.filter.maxPrice)
					)
				);
			} else
				await this.manager.clickItem(
					order.type === "buy" ? "Top Order +0.1" : "Best Offer -0.1"
				);

			// Check for limits and cooldown
			const item =
				findItem(
					order.type === "buy" ? "Buy Order" : "Sell Offer",
					bot.currentWindow
				) ??
				findItem(
					order.type === "buy" ? "Confirm Buy Order" : "Confirm Sell Offer",
					bot.currentWindow
				);
			if (!item)
				throw new Error(
					`Failed to find ${
						order.type === "buy" ? "Buy Order" : "Sell Offer"
					} item`
				);
			const lore = getCleanLore(item);
			if (lore.includes("Placing orders is on cooldown!")) {
				logger.debug("On cooldown, trying again in 1 minute...");
				await wait(1000 * 60);
				return this.createOrder(order);
			} else if (lore.includes("Too many orders!")) {
				logger.debug("Order limit reached");
				if (this.orders.length) {
					this.manager.config.options.orders.maxOrders = this.orders.length;
					await this.manager.config.save();
				}
			} else if (lore.includes("You reached the daily limit")) {
				logger.debug("Daily limit reached");
				this.usedDailyLimit = Bazaar.DAILY_LIMIT;
				this.checkLimit();
			} else {
				let price = Number(
					/Price per unit: ([\d,]*\.?\d)/.exec(lore)?.at(1)?.replaceAll(",", "")
				);
				if (isNaN(price)) {
					price =
						(order.type === "buy" ? product.buyPrice : product.sellPrice) ?? 1;
					logger.debug(
						`Failed to find price for ${JSON.stringify(order)} ${lore}`
					);
				}

				let amount = Number(
					/(Selling|Order): ([\d,]+)x/.exec(lore)?.at(2)?.replaceAll(",", "")
				);
				if (isNaN(amount)) {
					amount = order.amount ?? 1;
					logger.debug(
						`Failed to find amount for ${JSON.stringify(order)} ${lore}`
					);
				}

				this.usedDailyLimit += amount * price;
				this.checkLimit();

				this.expectedOrders ??= 0;
				this.expectedOrders++;

				await this.manager.clickItem(
					order.type === "buy" ? "Buy Order" : "Sell Offer",
					0,
					this.manager.waitForBotEvent("windowClose")
				);
			}
		} catch (err) {
			throw new Error(
				`Failed to create order ${JSON.stringify(order)} in window: ${
					bot.currentWindow?.title ?? "untitled"
				} ${bot.currentWindow
					?.containerItems()
					.map((i) => i?.customName)
					.join(", ")}: ${err}`
			);
		}
	}

	async cancelOrder(order: Order) {
		const product = this.getProduct(order.productId);
		logger.debug(`Cancelling order ${JSON.stringify(order)}`);
		if (product == null) return;

		const bot = this.manager.bot;

		try {
			await this.openManageOrders();
			const slot = this.findOrderSlot(order);
			if (slot === -1) {
				logger.debug(`Failed to find order ${JSON.stringify(order)}`);
				return;
			}

			// Claim the filled items, stop when either inv is full or all items have been claimed
			while (
				this.findOrderSlot(order) === slot &&
				this.orders.length === this.updateOrders()?.length
			) {
				if (this.manager.isInventoryFull() && order.type === "buy") return;
				await this.manager.clickSlot(slot);
				if (bot.currentWindow?.title?.includes("Order options")) {
					await this.manager.clickItem("Cancel Order");
					if (this.expectedOrders) this.expectedOrders--;
					return;
				}
			}
		} catch (err) {
			throw new Error(
				`Failed to cancel order ${JSON.stringify(order)}: ${err}`
			);
		}
	}

	async claimOrder(order: Order) {
		const product = this.getProduct(order.productId);
		logger.debug(`Claiming order ${JSON.stringify(order)}`);
		if (product == null) return;
		try {
			await this.openManageOrders();
			const slot = this.findOrderSlot(order);
			if (slot === -1) {
				logger.debug(`Failed to find order ${JSON.stringify(order)}`);
				return;
			}

			// Claim the filled items, stop when either inv is full or all items have been claimed
			while (
				(!this.manager.isInventoryFull() || order.type === "sell") &&
				this.findOrderSlot(order) === slot &&
				this.orders.length === this.updateOrders()?.length
			) {
				await this.manager.clickSlot(slot);
			}
			if (this.findOrderSlot(order) !== slot && this.expectedOrders)
				this.expectedOrders--;
		} catch (err) {
			throw new Error(`Failed to claim order ${JSON.stringify(order)}: ${err}`);
		}
	}

	async flipOrder(order: Order) {
		const product = this.getProduct(order.productId);
		logger.debug(`Flipping order ${JSON.stringify(order)}`);
		if (product == null) return;
		const bot = this.manager.bot;

		try {
			await this.openManageOrders();
			const slot = this.findOrderSlot(order);
			if (slot === -1) {
				logger.debug(`Failed to find order ${JSON.stringify(order)}`);
				return;
			}

			await this.manager.clickSlot(slot, 1);

			const item = findItem("Flip Order", bot.currentWindow);

			let amount = Number(
				/for ([\d,]+)x/.exec(getCleanLore(item))?.at(1)?.replaceAll(",", "") ??
					undefined
			);
			if (isNaN(amount)) {
				amount = order.amount ?? 1;
				logger.debug(
					`Failed to find amount for ${JSON.stringify(order)} ${getCleanLore(
						item
					)}`
				);
			}

			let topPrice =
				Number(
					/- ([\d,]*\.?\d) coins each \| [\d,]+x from [\d,]+ offers?/
						.exec(getCleanLore(item))
						?.at(1)
						?.replaceAll(",", "") ?? undefined
				) - 0.1;

			if (isNaN(topPrice)) {
				topPrice = product.sellPrice;
				logger.debug(
					`Failed to find top price for ${JSON.stringify(order)} ${getCleanLore(
						item
					)}`
				);
			}

			await this.manager.clickItem(
				"Flip Order",
				0,
				this.manager.writeToSign(String(topPrice))
			);
			this.usedDailyLimit += amount * topPrice;
			this.checkLimit();
		} catch (err) {
			throw new Error(`Failed to flip order ${JSON.stringify(order)}: ${err}`);
		}
	}

	async instantBuy(product: Product, amount: number) {
		logger.debug(`Instant-buying ${amount}x ${product.id}`);
		try {
			const bot = this.manager.bot;
			await this.openBz(product.name);
			await this.manager.clickItem(product.name);
			await this.manager.clickItem("Buy Instantly");
			let maxAmount = Number(
				/Buy up to ([\d,]+)x/
					.exec(getCleanLore(findItem("Custom Amount", bot.currentWindow)))
					?.at(1)
					?.replaceAll(",", "")
			);
			if (isNaN(maxAmount)) {
				maxAmount = 256;
				logger.debug(
					`Failed to find maximum amount for ${product.id} ${JSON.stringify(
						findItem("Custom Amount", bot.currentWindow) ?? {}
					)}`
				);
			}
			await this.manager.clickItem(
				"Custom Amount",
				0,
				this.manager.writeToSign(
					String(Math.floor(Math.min(amount, maxAmount)))
				)
			);
			await this.manager.waitForBotEvent("windowOpen");
			await wait(250);
			await this.manager.clickItem("Custom Amount");
			this.usedDailyLimit += amount * product.instantBuyPrice;
			this.checkLimit();
		} catch (err) {
			throw new Error(
				`Error while instant-buying ${amount}x ${product.id}: ${err}`
			);
		}
	}

	async instantSell(product?: Product) {
		logger.debug(`Instant-selling ${product ? product.id : "INVENTORY"}`);
		try {
			if (product) {
				this.usedDailyLimit +=
					(this.getBazaarProductsFromInv().find((e) => e.product === product)
						?.amount ?? 0) * product.instantSellPrice;
				await this.openBz(product.name);
				await this.manager.clickItem(product.name);
				await this.manager.clickItem("Sell Instantly");
			} else {
				this.usedDailyLimit += this.getBazaarProductsFromInv().reduce(
					(sum, { product, amount }) => product.instantSellPrice * amount,
					0
				);
				await this.openBz();
				await this.manager.clickItem("Sell Inventory Now");
				await this.manager.clickItem("Selling whole inventory");
			}
		} catch (err) {
			throw new Error(
				`Error while instant-selling ${
					product ? product.id : "INVENTORY"
				}: ${err}`
			);
		}
		this.checkLimit();
	}

	getTotal() {
		return this.manager.getPurse() + this.getSpent();
	}

	getSpent() {
		return this.getOrdersWorth() + this.getInvWorth();
	}

	getOrdersWorth() {
		return this.orders.reduce((sum, order) => sum + this.getValue(order), 0);
	}

	getInvWorth() {
		return this.getBazaarProductsFromInv().reduce(
			(sum, { product, amount }) => product.instantSellPrice * amount,
			0
		);
	}

	getValue(order: Order) {
		if (!order.amount) return 0;
		return (
			order.amount *
			(order.type === "buy"
				? order.price ?? 0
				: this.getProduct(order.productId)?.instantSellPrice ?? 0)
		);
	}

	async updateProducts() {
		this.products = await this.manager.waitForReply<Product[], "get-products">(
			"get-products",
			null
		);
	}

	updateOrders() {
		const bot = this.manager.bot;
		if (!this.manager.bot.currentWindow?.title?.includes("Bazaar Orders")) {
			logger.debug(
				`Tried to update orders outside of the correct window: ${this.manager.bot?.currentWindow?.title}`
			);
			return;
		}

		const orders: Order[] = [];
		if (!bot.currentWindow) return;
		for (let slot = 0; slot < bot.currentWindow.inventoryStart; ++slot) {
			const item = bot.currentWindow.slots[slot];
			if (!item) continue;

			const name = clean(item?.customName ?? "");
			const match = name.match(/(BUY|SELL) (.+)/);
			if (!match) continue;

			const lore = getCleanLore(item);
			const product = this.products.find((e) => e.name === match[2]);
			if (!product) {
				logger.debug(
					`Failed to find product for item ${name} (${match[2]}) out of ${this.products.length} products`
				);
				continue;
			}

			orders.push({
				productId: product.id,
				amount: Number(
					lore
						.match(/(Order|Offer) amount: ([\d,]+)x/)
						?.at(2)
						?.replaceAll(",", "")
				),
				price: Number(
					lore
						.match(/Price per unit: ([\d,]*\.?\d) coins/)
						?.at(1)
						?.replaceAll(",", "")
				),
				type: match[1] === "BUY" ? "buy" : "sell",
				filled: lore.includes("100%!"),
			});
		}

		this.orders = orders;
		this.sortOrders();
		return orders;
	}
	sortOrders() {
		for (const order of this.orders) {
			order.undercutAmount = this.getUndercutAmount(order);
		}
		this.orders.sort((a, b) => {
			if (
				a.undercutAmount === undefined ||
				a.amount === undefined ||
				a.price === undefined
			)
				return 1;
			if (
				b.undercutAmount === undefined ||
				b.amount === undefined ||
				b.price === undefined
			)
				return -1;
			if (a.filled || b.filled) {
				if (a.filled && !b.filled) return -1;
				if (!a.filled) return 1;
				if (a.type === "sell" && b.type === "buy") return -1;
				if (a.type === "buy" && b.type === "sell") return 1;
				return b.amount * b.price - a.amount * a.price;
			}
			if (
				a.undercutAmount / a.amount <
				this.manager.config.options.orders.relistRatio
			)
				return 1;
			if (
				b.undercutAmount / b.amount <
				this.manager.config.options.orders.relistRatio
			)
				return -1;

			return b.undercutAmount / b.amount - a.undercutAmount / a.amount;
		});
	}

	getRemainingOrderSpace(type?: Order["type"]): number {
		if (!type)
			return this.manager.config.options.orders.maxOrders - this.orders.length;
		return Math.min(
			this.getRemainingOrderSpace(),
			this.manager.config.options.orders[
				`max${type === "buy" ? "Buy" : "Sell"}Orders`
			] - this.getOrders(type).length
		);
	}

	getOrders(type?: Order["type"]) {
		const orders = this.orders;
		return !type ? orders : orders.filter((order) => order.type === type);
	}

	fitsInv(order: Order): boolean {
		const product = this.getProduct(order.productId);
		if (!product) throw Error("Product not found for fitsInv");
		if (order.amount === undefined)
			throw Error("Order amount undefined for fitsInv");

		const bot = this.manager.bot;

		const freeSlots = 9 * 4 - bot.inventory.items().length;
		return freeSlots * product.maxStack - order.amount >= 0;
	}

	findOrderSlot(order: Order): number {
		const product = this.getProduct(order.productId);
		if (!product) throw Error("Product not found for findOrderSlot");
		const bot = this.manager.bot;

		if (!bot.currentWindow) return -1;
		for (let slot = 0; slot < bot.currentWindow.inventoryStart; ++slot) {
			const item = bot.currentWindow.slots[slot];
			if (!item) continue;

			const name = clean(item.customName ?? "");
			const lore = getCleanLore(item);

			if (!name.includes(product.name)) continue;
			if (!name.includes(order.type.toUpperCase())) continue;

			let amount;
			{
				const match = lore.match(/(Order|Offer) amount: ([\d,]+)x/);
				if (!match) {
					logger.debug(`Weird order lore: ${name} ${lore}`);
					continue;
				}
				amount = Number(match[2].replaceAll(",", ""));
			}
			if (amount !== order.amount) continue;

			let price;
			{
				const match = lore.match(/Price per unit: ([\d,]*\.?\d) coins/);
				if (!match) {
					logger.debug(`Weird order lore: ${lore}`);
					continue;
				}
				price = Number(match[1].replaceAll(",", ""));
			}
			if (price !== order.price) continue;

			if (!!order.filled !== lore.includes("100%!")) continue;

			logger.debug(`Found order ${JSON.stringify(order)} in slot ${slot}`);
			return slot;
		}
		logger.debug(`Failed to find order ${JSON.stringify(order)})`);
		return -1;
	}

	getUndercutAmount(order: Order): number {
		if (order.filled) return 0;

		const product = this.getProduct(order.productId);
		if (product == null)
			throw Error("Product not found for " + order.productId);
		if (order.amount === undefined)
			throw Error("Order amount undefined for " + JSON.stringify(order));
		if (order.price === undefined)
			throw Error("Order price undefined for " + JSON.stringify(order));

		const { price, productId } = order;

		const sameOrders = this.orders.filter(
			(o) =>
				o.productId === productId &&
				!o.filled &&
				o.type === order.type &&
				o.price === price
		);

		const competingOrders = (
			order.type === "buy"
				? product.buyOrders.filter(
						(o) => o.amount && o.price && o.price >= price
				  )
				: product.sellOrders.filter(
						(o) => o.amount && o.price && o.price <= price
				  )
		).filter(
			(a) =>
				!sameOrders.find((b) => a.amount === b.amount && a.price === b.price)
		);

		return competingOrders.reduce((sum, competingOrder) => {
			if (competingOrder.price === price) {
				const diff =
					competingOrder.amount! -
					sameOrders.reduce(
						(sum, o) =>
							o.price === competingOrder.price ? sum + o.amount! : sum,
						0
					);
				return sum + diff;
			} else return sum + competingOrder.amount!;
		}, 0);
	}

	getProduct(id: string): Product | undefined {
		return this.products.find((e) => e && e.id === id);
	}

	getBazaarProductsFromInv(): { product: Product; amount: number }[] {
		const bot = this.manager.bot;

		const products: { product: Product; amount: number }[] = [];

		bot?.inventory?.items()?.forEach((item) => {
			const id = getNbt(item, "ExtraAttributes", "id") as string;
			if (id == null) return;
			const product = this.getProduct(id);
			if (product == null) return;

			const index = products.findIndex((e) => e.product === product);

			if (index === -1) products.push({ product, amount: item.count });
			else products[index].amount += item.count;
		});

		return products;
	}

	isAtLimit(): boolean {
		return this.getRemainingLimit() <= 0;
	}

	getTrueLimit(): number {
		return (
			Bazaar.DAILY_LIMIT -
			(this.manager.config.options.general.coopFailsafe
				? this.manager.config.options.general.maxUsage * 5
				: 0)
		);
	}

	getRemainingLimit(): number {
		return this.getTrueLimit() - this.usedDailyLimit;
	}
}

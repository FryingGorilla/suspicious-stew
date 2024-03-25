import {Order, Product} from '../shared/types';
import logger from '../shared/logger';
import {jsoncSafe} from 'jsonc/lib/jsonc.safe';
import {globals} from '../shared/globals';
import {existsSync} from 'fs';
import {clean, findItem, getCleanLore, getNbt} from './bot-utils';
import {sleep} from '../shared/utils';
import {goals} from 'mineflayer-pathfinder';
import assert from 'assert';
import {ChatMessage} from 'prismarine-chat';
import BotManager from './bot-manager';

export default class Bazaar {
	usedBuyLimit = 0;
	usedSellLimit = 0;
	limitResetTime = 0;
	products: Product[] = [];
	orders: Order[] = [];
	expectedOrders = 0;
	npcMode = false;

	constructor(public manager: BotManager) {
		manager.bot.on(
			'message',
			(message: ChatMessage) => {
				if (
					message
						.toString()
						.startsWith('[Bazaar] You reached the daily limit in items value that you may sell on the bazaar!')
				) {
					logger.debug('Sell limit reached');
					this.usedSellLimit = this.manager.config.options.limits.sellLimit;
				}
				if (
					message
						.toString()
						.startsWith('[Bazaar] You reached the daily limit of coins you may create orders for on the Bazaar!')
				) {
					logger.debug('Buy limit reached');
					this.usedBuyLimit = this.manager.config.options.limits.buyLimit;
				}
			},
			{persistent: true}
		);
		this.loadLimits();
	}

	async updateLimits() {
		const currentDate = new Date();
		const nextUTCDay = new Date(currentDate);
		nextUTCDay.setUTCDate(currentDate.getUTCDate() + 1);
		nextUTCDay.setUTCHours(0, 0, 0, 0);

		if (this.limitResetTime <= currentDate.getTime()) {
			logger.debug('New day, resetting limits back to zero');

			this.limitResetTime = nextUTCDay.getTime();
			this.usedBuyLimit = 0;
			this.usedSellLimit = 0;
			await this.saveLimits();
			return true;
		}

		return false;
	}

	async saveLimits() {
		const data = {
			usedBuyLimit: this.usedBuyLimit,
			usedSellLimit: this.usedSellLimit,
			limitResetTime: this.limitResetTime,
		};

		const [error] = await jsoncSafe.write(globals.ACCOUNT_LIMIT_CACHE(this.manager.account.uuid), data, {
			space: '\t',
		});
		if (error) logger.error(`Error saving limits for ${this.manager.account.username}: ${error.message}`);
		return this;
	}

	async loadLimits() {
		if (!existsSync(globals.ACCOUNT_LIMIT_CACHE(this.manager.account.uuid))) return;
		const [error, data] = await jsoncSafe.read(globals.ACCOUNT_LIMIT_CACHE(this.manager.account.uuid));
		if (error) logger.error(`Error loading limits for ${this.manager.account.username}: ${error}`);

		const {usedBuyLimit, usedSellLimit, limitResetTime} = data;
		this.usedBuyLimit = usedBuyLimit ?? 0;
		this.usedSellLimit = usedSellLimit ?? 0;
		this.limitResetTime = limitResetTime ?? 0;

		return this;
	}

	async openBz(search?: string) {
		const bot = this.manager.bot;

		logger.debug(`Opening Bazaar${search ? ` for '${search}'` : ''}`);
		if (this.manager.location !== (this.npcMode ? 'hub' : 'island')) return;

		try {
			if (bot.currentWindow) {
				bot.closeWindow(bot.currentWindow);
				await sleep(400);
			}

			if (this.npcMode) {
				logger.debug('Going to Bazaar npc');
				await bot.waitForChunksToLoad();
				await bot.pathfinder.goto(new goals.GoalNearXZ(-32.5, -76.5, 3));
				logger.debug('Arrived near the Bazaar npc');

				const bazaar = bot.nearestEntity((e) => e.getCustomName()?.toString() === 'Bazaar');
				if (!bazaar) {
					logger.error('Failed to find the Bazaar npc, trying again...');
					await this.manager.sendChat('/is');
					await sleep(5000);
					await this.openBz(search);
					return;
				}

				await bot.activateEntity(bazaar);
				await this.manager.waitForBotEvent('windowOpen');
				if (search) {
					await this.manager.clickItem('Search', 0, this.manager.writeToSign(search));
					await this.manager.waitForBotEvent('windowOpen');
				}
			} else {
				await this.manager.sendChat(`/bz${search ? ' ' + search : ''}`);
				await this.manager.waitForBotEvent('windowOpen');
				this.manager.hasCookie = true;
			}
			await sleep(500);
		} catch (err) {
			throw new Error(`Failed to open Bazaar: ${err}`);
		}
	}

	async openManageOrders(retries = 5) {
		logger.debug('Opening Manage Orders');

		try {
			await this.openBz();
			while (this.manager.bot?.currentWindow && !this.manager.bot.currentWindow.title.includes('Bazaar Orders'))
				await this.manager.clickItem('Manage Orders');

			this.updateOrders();
			if (this.orders.length === 0 && this.expectedOrders !== this.orders.length && retries > 0) {
				if (this.manager.bot.currentWindow) this.manager.bot.closeWindow(this.manager.bot.currentWindow);
				logger.debug('Expected more than 0 orders');
				await this.openManageOrders(retries - 1);
			} else {
				this.expectedOrders = this.orders.length;
				if (this.manager.config.options.orders.maxOrders < this.orders.length) {
					this.manager.config.options.orders.maxOrders = this.orders.length;
					await this.manager.config.save();
				}
			}
		} catch (err) {
			throw new Error(`Failed to open Manage Orders: ${err} (in window ${this.manager.bot.currentWindow?.title})`);
		}
	}
	async changeNpcMode(npcMode: boolean) {
		if (this.npcMode === npcMode) return;

		this.manager.postNotification(`NPC mode`, `${npcMode ? 'Enabling' : 'Disabling'} NPC mode`, 2);
		logger.debug(`${npcMode ? 'Enabling' : 'Disabling'} NPC mode`);

		this.npcMode = npcMode;
		await this.manager.sendChat('/l');
	}

	async createOrder(order: Order): Promise<void> {
		const product = this.getProduct(order.productId);
		logger.debug(`Creating order ${JSON.stringify(order)}`);
		assert(product != null);

		const bot = this.manager.bot;

		try {
			await this.openBz(product.name);
			await this.manager.clickItem(product.name);
			await this.manager.clickItem(`Create ${order.type === 'buy' ? 'Buy Order' : 'Sell Offer'}`);

			if (order.type === 'buy') {
				let maxAmount = Number(
					/Buy up to ([\d,]+)x/
						.exec(getCleanLore(findItem('Custom Amount', bot.currentWindow)))
						?.at(1)
						?.replaceAll(',', '')
				);
				if (isNaN(maxAmount)) {
					maxAmount = 256;
					logger.error(
						`Failed to find maximum amount for ${order.productId} ${JSON.stringify(
							findItem('Custom Amount', bot.currentWindow) ?? {}
						)}`
					);
				}
				await this.manager.clickItem(
					'Custom Amount',
					0,
					this.manager.writeToSign(String(Math.floor(Math.min(order.amount ?? 1, maxAmount))))
				);
				await this.manager.waitForBotEvent('windowOpen');
				await sleep(250);
			}
			const topPrice = Number(
				/Unit price: ([\d,]*\.?\d) coins/
					.exec(getCleanLore(findItem(order.type === 'buy' ? 'Top Order +0.1' : 'Best Offer -0.1', bot.currentWindow)))
					?.at(1)
					?.replaceAll(',', '')
			);
			if (isNaN(topPrice)) {
				logger.error(
					`Failed to find maximum amount for ${order.productId} ${JSON.stringify(
						findItem('Custom Amount', bot.currentWindow) ?? {}
					)}`
				);
			}

			if (topPrice > this.manager.config.options.filter.maxPrice) {
				await this.manager.clickItem(
					'Custom Price',
					0,
					this.manager.writeToSign(String(this.manager.config.options.filter.maxPrice))
				);
			} else await this.manager.clickItem(order.type === 'buy' ? 'Top Order +0.1' : 'Best Offer -0.1');

			// Check for limits and cooldown
			const item = findItem(order.type === 'buy' ? 'Buy Order' : 'Sell Offer', bot.currentWindow);
			const lore = getCleanLore(item);
			if (lore.includes('Placing orders is on cooldown!')) {
				logger.debug('On cooldown, trying again in 1 minute...');
				await sleep(1000 * 60);
				return this.createOrder(order);
			} else if (lore.includes('Too many orders!')) {
				logger.debug('Order limit reached');
				if (this.orders.length) {
					this.manager.config.options.orders.maxOrders = this.orders.length;
					await this.manager.config.save();
				}
			} else if (lore.includes('You reached the daily limit of coins you may create orders for on the Bazaar!')) {
				logger.debug('Buy limit reached');
				this.usedBuyLimit = this.manager.config.options.limits.buyLimit;
			} else if (lore.includes('You reached the daily limit in items value that you may sell on the bazaar!')) {
				logger.debug('Sell limit reached');
				this.usedBuyLimit = this.manager.config.options.limits.sellLimit;
			} else {
				let price = Number(/Price per unit: ([\d,]*\.?\d)/.exec(lore)?.at(1)?.replaceAll(',', ''));
				if (isNaN(price)) {
					price = (order.type === 'buy' ? product.buyPrice : product.sellPrice) ?? 1;
					logger.error(`Failed to find price for ${JSON.stringify(order)} ${lore}`);
				}

				let amount = Number(/(Selling|Order): ([\d,]+)x/.exec(lore)?.at(2)?.replaceAll(',', ''));
				if (isNaN(amount)) {
					amount = order.amount ?? 1;
					logger.error(`Failed to find amount for ${JSON.stringify(order)} ${lore}`);
				}

				if (order.type === 'buy') this.usedBuyLimit += amount * price;
				else this.usedSellLimit += amount * price;

				this.expectedOrders++;
				await this.manager.clickItem(
					order.type === 'buy' ? 'Buy Order' : 'Sell Offer',
					0,
					this.manager.waitForBotEvent('windowClose')
				);
			}
		} catch (err) {
			logger.error(`Failed to create order ${JSON.stringify(order)}: ${err}`);
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
			while (this.findOrderSlot(order) === slot) {
				if (this.manager.isInventoryFull() && order.type === 'buy') return;
				await this.manager.clickSlot(slot);
				if (bot.currentWindow?.title?.includes('Order options')) {
					await this.manager.clickItem('Cancel Order');
					this.expectedOrders--;
					return;
				}
			}
		} catch (err) {
			logger.error(`Failed to cancel order ${JSON.stringify(order)}: ${err}`);
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
			while ((!this.manager.isInventoryFull() || order.type === 'sell') && this.findOrderSlot(order) === slot) {
				await this.manager.clickSlot(slot);
			}
			if (this.findOrderSlot(order) !== slot) this.expectedOrders--;
		} catch (err) {
			logger.error(`Failed to claim order ${JSON.stringify(order)}: ${err}`);
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

			const item = findItem('Flip Order', bot.currentWindow);

			let amount = Number(/for ([\d,]+)x/.exec(getCleanLore(item))?.at(1)?.replaceAll(',', '') ?? undefined);
			if (isNaN(amount)) {
				amount = order.amount ?? 1;
				logger.error(`Failed to find amount for ${JSON.stringify(order)} ${getCleanLore(item)}`);
			}

			let topPrice =
				Number(
					/- ([\d,]*\.?\d) coins each \| [\d,]+x from [\d,]+ offers?/
						.exec(getCleanLore(item))
						?.at(1)
						?.replaceAll(',', '') ?? undefined
				) - 0.1;

			if (isNaN(topPrice)) {
				topPrice = product.sellPrice;
				logger.error(`Failed to find top price for ${JSON.stringify(order)} ${getCleanLore(item)}`);
			}

			await this.manager.clickItem('Flip Order', 0, this.manager.writeToSign(String(topPrice)));
			this.usedSellLimit += amount * topPrice;
		} catch (err) {
			logger.error(`Failed to flip order ${JSON.stringify(order)}: ${err}`);
		}
	}

	async instantBuy(product: Product, amount: number) {
		logger.debug(`Instant-buying ${amount}x ${product.id}`);
		try {
			const bot = this.manager.bot;
			await this.openBz(product.name);
			await this.manager.clickItem(product.name);
			await this.manager.clickItem('Buy Instantly');
			let maxAmount = Number(
				/Buy up to ([\d,]+)x/
					.exec(getCleanLore(findItem('Custom Amount', bot.currentWindow)))
					?.at(1)
					?.replaceAll(',', '')
			);
			if (isNaN(maxAmount)) {
				maxAmount = 256;
				logger.error(
					`Failed to find maximum amount for ${product.id} ${JSON.stringify(
						findItem('Custom Amount', bot.currentWindow) ?? {}
					)}`
				);
			}
			await this.manager.clickItem(
				'Custom Amount',
				0,
				this.manager.writeToSign(String(Math.floor(Math.min(amount, maxAmount))))
			);
			await this.manager.waitForBotEvent('windowOpen');
			await sleep(250);
			await this.manager.clickItem('Custom Amount');
			this.usedBuyLimit += amount * product.instantBuyPrice;
		} catch (err) {
			logger.error(`Error while instant-buying ${amount}x ${product.id}: ${err}`);
		}
	}

	async instantSell(product?: Product) {
		logger.debug(`Instant-selling ${product ? product.id : 'INVENTORY'}`);
		try {
			if (product) {
				this.usedSellLimit +=
					(this.getBazaarProductsFromInv().find((e) => e.product === product)?.amount ?? 0) * product.instantSellPrice;
				await this.openBz(product.name);
				await this.manager.clickItem(product.name);
				await this.manager.clickItem('Sell Instantly');
			} else {
				this.usedSellLimit += this.getBazaarProductsFromInv().reduce(
					(sum, {product, amount}) => product.instantSellPrice * amount,
					0
				);
				await this.openBz();
				await this.manager.clickItem('Sell Inventory Now');
				await this.manager.clickItem('Selling whole inventory');
			}
		} catch (err) {
			logger.error(`Error while instant-selling ${product ? product.id : 'INVENTORY'}: ${err}`);
		}
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
		return this.getBazaarProductsFromInv().reduce((sum, {product, amount}) => product.instantSellPrice * amount, 0);
	}

	getValue(order: Order) {
		if (!order.amount) return 0;
		return (
			order.amount * (order.type === 'buy' ? order.price ?? 0 : this.getProduct(order.productId)?.instantSellPrice ?? 0)
		);
	}

	async updateProducts() {
		this.products = await this.manager.waitForReply<Product[], 'get-products'>('get-products', null);
	}

	updateOrders() {
		const bot = this.manager.bot;
		if (!this.manager.bot.currentWindow?.title?.includes('Bazaar Orders')) {
			logger.debug(`Tried to update orders outside of the correct window: ${this.manager.bot?.currentWindow?.title}`);
			return;
		}

		this.orders = [];
		if (!bot.currentWindow) return;
		for (let slot = 0; slot < bot.currentWindow.inventoryStart; ++slot) {
			const item = bot.currentWindow.slots[slot];
			if (!item) continue;

			const name = clean(item?.customName ?? '');
			const match = name.match(/(BUY|SELL) (.+)/);
			if (!match) continue;

			const lore = getCleanLore(item);
			const product = this.products.find((e) => e.name === match[2]);
			if (!product) {
				logger.error(`Failed to find product for item ${name} (${match[2]}) out of ${this.products.length} products`);
				continue;
			}

			this.orders.push({
				productId: product.id,
				amount: Number(
					lore
						.match(/(Order|Offer) amount: ([\d,]+)x/)
						?.at(2)
						?.replaceAll(',', '')
				),
				price: Number(
					lore
						.match(/Price per unit: ([\d,]*\.?\d) coins/)
						?.at(1)
						?.replaceAll(',', '')
				),
				type: match[1] === 'BUY' ? 'buy' : 'sell',
				filled: lore.includes('100%!'),
			});
		}

		this.sortOrders();
		return this.orders;
	}
	sortOrders() {
		for (const order of this.orders) order.undercutAmount = this.getUndercutAmount(order);
		this.orders.sort((a, b) => {
			if (a.undercutAmount === undefined || a.amount === undefined || a.price === undefined) return 1;
			if (b.undercutAmount === undefined || b.amount === undefined || b.price === undefined) return -1;
			if (a.filled || b.filled) {
				if (a.filled && !b.filled) return -1;
				if (!a.filled) return 1;
				if (a.type === 'sell' && b.type === 'buy') return -1;
				if (a.type === 'buy' && b.type === 'sell') return 1;
				return b.amount * b.price - a.amount * a.price;
			}
			if (a.undercutAmount / a.amount < this.manager.config.options.orders.relistRatio) return 1;
			if (b.undercutAmount / b.amount < this.manager.config.options.orders.relistRatio) return -1;

			return b.undercutAmount / b.amount - a.undercutAmount / a.amount;
		});
	}

	getRemainingOrderSpace(type?: Order['type']): number {
		if (!type) return this.manager.config.options.orders.maxOrders - this.orders.length;
		return Math.min(
			this.getRemainingOrderSpace(),
			this.manager.config.options.orders[`max${type === 'buy' ? 'Buy' : 'Sell'}Orders`] - this.getOrders(type).length
		);
	}

	getOrders(type?: Order['type']) {
		const orders = this.orders;
		return !type ? orders : orders.filter((order) => order.type === type);
	}

	fitsInv(order: Order): boolean {
		const product = this.getProduct(order.productId);
		if (!product) throw Error('Product not found for fitsInv');
		if (order.amount === undefined) throw Error('Order amount undefined for fitsInv');

		const bot = this.manager.bot;

		const freeSlots = 9 * 4 - bot.inventory.items().length;
		return freeSlots * product.maxStack - order.amount >= 0;
	}

	findOrderSlot(order: Order): number {
		const product = this.getProduct(order.productId);
		if (!product) throw Error('Product not found for findOrderSlot');
		const bot = this.manager.bot;

		if (!bot.currentWindow) return -1;
		for (let slot = 0; slot < bot.currentWindow.inventoryStart; ++slot) {
			const item = bot.currentWindow.slots[slot];
			if (!item) continue;

			const name = clean(item.customName ?? '');
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
				amount = Number(match[2].replaceAll(',', ''));
			}
			if (amount !== order.amount) continue;

			let price;
			{
				const match = lore.match(/Price per unit: ([\d,]*\.?\d) coins/);
				if (!match) {
					logger.debug(`Weird order lore: ${lore}`);
					continue;
				}
				price = Number(match[1].replaceAll(',', ''));
			}
			if (price !== order.price) continue;

			if (!!order.filled !== lore.includes('100%!')) continue;

			logger.debug(`Found order ${JSON.stringify(order)} in slot ${slot}`);
			return slot;
		}
		logger.debug(`Failed to find order ${JSON.stringify(order)})`);
		return -1;
	}

	getUndercutAmount(order: Order): number {
		if (order.filled) return 0;

		const product = this.getProduct(order.productId);
		if (product == null) throw Error('Product not found for getUndercutAmount');
		if (order.amount === undefined) throw Error('Order amount undefined for getUndercutAmount');
		if (order.price === undefined) throw Error('Order price undefined for getUndercutAmount');

		let amount = 0;
		const orders = this.orders;

		for (const order1 of order.type === 'buy' ? product.buyOrders : product.sellOrders) {
			if (order1.amount === undefined || order1.price === undefined) continue;
			if (order.type === 'buy' && order.price > order1.price) break;
			if (order.type === 'sell' && order.price < order1.price) break;

			if (order.price === order1.price) {
				if (order.amount === order1.amount) continue;
				const diff =
					order1.amount -
					orders.reduce((prev, e) => {
						if (e.productId === order.productId && !e.filled && e.price === order.price && e.type === order.type)
							return prev + (e.amount ?? 0);
						return prev;
					}, 0);
				amount += diff;
			} else {
				if (
					orders.find(
						(e) =>
							e.productId === order.productId &&
							!e.filled &&
							e.amount === order1.amount &&
							e.price === order1.price &&
							e.type === order1.type
					) !== undefined
				)
					continue;

				amount += order1.amount;
			}
		}

		return amount;
	}

	getProduct(id: string): Product | undefined {
		return this.products.find((e) => e && e.id === id);
	}

	getBazaarProductsFromInv(): {product: Product; amount: number}[] {
		const bot = this.manager.bot;

		const products: {product: Product; amount: number}[] = [];

		bot?.inventory?.items()?.forEach((item) => {
			const id = getNbt(item, 'ExtraAttributes', 'id') as string;
			if (id == null) return;
			const product = this.getProduct(id);
			if (product == null) return;

			const index = products.findIndex((e) => e.product === product);

			if (index === -1) products.push({product, amount: item.count});
			else products[index].amount += item.count;
		});

		return products;
	}

	isAtLimit(type: 'buy' | 'sell'): boolean {
		return this.getRemainingLimit(type) <= 0;
	}

	getTrueLimit(type: 'buy' | 'sell'): number {
		if (type === 'buy') return this.manager.config.options.limits.buyLimit;
		return (
			this.manager.config.options.limits.sellLimit -
			(this.manager.config.options.failsafe.coopFailsafe ? this.manager.config.options.general.maxUsage * 5 : 0)
		);
	}

	getRemainingLimit(type: 'buy' | 'sell'): number {
		return this.getTrueLimit(type) - (type === 'buy' ? this.usedBuyLimit : this.usedSellLimit);
	}
}

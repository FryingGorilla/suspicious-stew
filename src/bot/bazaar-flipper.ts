import logger from '../shared/logger';
import {formatDuration, formatNumber, getHours, wait, waitForEvent} from '../shared/utils';
import {FlipperState, FlipperUpdateData, Order} from '../shared/types';
import {ChatMessage} from 'prismarine-chat';
import BotManager from './bot-manager';
import {clean, findItem, findItemSlot, getCleanLore} from './bot-utils';
import Bazaar from './bazaar';

export default class BazaarFlipper {
	onlineMembers: string[] = [];

	startingTotal?: number;
	startingDailyLimit?: number;
	totalWaitTime = 0;
	cycles = 0;

	timer: Timer = new Timer();
	state: FlipperState = 'stopped';
	activeActivity: string = 'default';

	isInTimeout = false;
	timeoutStartTime = 0;
	totalTimeout = 0;
	runId = 0;

	async changeActivity(activity: string, func: () => unknown) {
		try {
			if (activity === this.activeActivity) return;
			const prev = this.activeActivity;
			this.activeActivity = activity;
			await func();

			this.activeActivity = prev;
		} catch (err) {
			logger.error(`${activity} failed: ${err}`);
		}
	}

	start(): void {
		if (this.state === 'running') return;
		logger.debug(this.state === 'stopped' ? 'Starting up...' : 'Resuming...');
		this.state = 'running';

		this.runId++;
		this.startMain();
		this.timer.start();
		this.postUpdate();
		this.manager.connect();
	}

	async startMain() {
		const interval = setInterval(() => {
			if (this.state !== 'running') clearInterval(interval);
			else this.postMetrics();
		}, 3 * 60 * 1000);

		const runId = this.runId;
		while (this.state === 'running' && this.runId === runId) {
			try {
				if (this.isScheduled()) {
					if (this.isInTimeout) {
						this.totalTimeout += Date.now() - this.timeoutStartTime;
						this.manager.postNotification('Timeout ended', 'Scheduled timeout has ended, logging back in', 2);
						this.isInTimeout = false;
						this.manager.connect();
						this.postUpdate();
					}
				} else if (!this.isInTimeout) {
					this.timeoutStartTime = Date.now();
					this.manager.postNotification('Timeout', 'Scheduled timeout has started, disconnecting', 2);
					this.isInTimeout = true;
					if (this.manager.onlineStatus === 'connecting') await this.manager.waitForBotEvent('spawn');
					this.manager.disconnect();
					this.postUpdate();
				}
				if (!this.isInTimeout) this.main && (await this.main());
				await wait(1000);
			} catch (err) {
				logger.error(`An error occurred in the main function: ${err}`);
			}
		}
	}

	isScheduled(): boolean {
		let isScheduled = true;
		const hours = getHours();

		for (const {start, end} of this.manager.config.options.general.timeouts) {
			if (start <= hours && hours <= end) {
				isScheduled = false;
				break;
			}
		}
		logger.debug(`utc hours ${hours}, scheduled: ${isScheduled}`);

		return isScheduled;
	}

	getRemainingTime(): number {
		const hours = getHours();
		let remainingTime = (24 - hours) * 60 * 60 * 1000;

		for (const {start, end} of this.manager.config.options.general.timeouts) {
			if (end < hours) continue;
			if (start < hours) {
				remainingTime -= (end - hours) * 60 * 60 * 1000;
			} else {
				remainingTime -= (end - start) * 60 * 60 * 1000;
			}
		}

		return remainingTime;
	}

	pause(): void {
		if (this.state === 'paused') return;
		logger.debug('Pausing...');
		this.state = 'paused';

		this.timer.pause();
		this.postUpdate();

		this.manager.connect();
	}

	stop(): void {
		if (this.state === 'stopped') return;
		logger.debug('Stopping...');
		this.state = 'stopped';
		this.activeActivity = 'default';

		this.timer.stop();
		this.postUpdate();

		this.manager.disconnect();

		this.startingTotal = undefined;
		this.startingDailyLimit = undefined;
		this.cycles = 0;
		this.totalWaitTime = 0;
		this.cycles = 0;
	}

	postUpdate(): void {
		this.manager.postEvent('flipper-update', this.serialize());
	}

	postMetrics() {
		this.manager.postEvent('flipper-metrics', {
			...this.serialize(),
			...this.manager.serialize(),
			...this.manager.bazaar.serialize(),
		});
	}

	constructor(public manager: BotManager) {
		this.manager.bot.on(
			'spawn',
			async () => {
				if (this.state !== 'running') return;
				if (this.activeActivity !== 'default') return;
				if (manager.location !== 'island') return;

				if (manager.config.options.general.coopFailsafe) {
					await this.coopFailsafe();
				}
			},
			{persistent: true}
		);
		manager.bot.on(
			'message',
			async (chatMessage: ChatMessage, position: string) => {
				if (!chatMessage) return;
				if (position !== 'chat') return;
				if (this.state !== 'running') return;

				const message = chatMessage.toString().trimStart();

				if (message.startsWith('This server is too laggy to use the Bazaar, sorry!')) {
					await this.manager.sendChat('/l');
					return;
				}

				const joinedName = /^([a-zA-Z0-9_]+) joined SkyBlock./.exec(message.toString())?.at(1);
				const leftName = /^([a-zA-Z0-9_]+) left SkyBlock./.exec(message.toString())?.at(1);

				if (joinedName) this.onlineMembers.push(joinedName);
				if (leftName) {
					const index = this.onlineMembers.findIndex((name) => name === leftName);
					if (index !== -1) this.onlineMembers.splice(index, 1);
				}

				if (this.manager.config.options.general.coopFailsafe) {
					await this.coopFailsafe();
				}
			},
			{persistent: true}
		);
	}

	async main() {
		const manager = this.manager;

		if (manager.onlineStatus !== 'online' || this.manager.spawnDelay) return;

		await manager.updateLocation();
		if (this.manager.location !== 'island') {
			return await this.changeActivity('failsafe', async () => {
				this.manager.postNotification(`Failsafe activated`, `Current location: ${this.manager.location}`, 2);
				logger.debug(`Failsafe activated: Current location: ${this.manager.location}`);
				if (this.manager.location === 'skyblock' || this.manager.location === 'hub') await this.manager.sendChat('/is');
				else if (this.manager.location === 'limbo') await this.manager.sendChat('/l');
				else if (this.manager.location === 'lobby') await this.manager.sendChat('/skyblock');
			});
		}

		const isNewDay = await manager.bazaar.updateLimit();
		await manager.bazaar.saveLimit();
		if (isNewDay) {
			this.cycles = 0;
			this.startingDailyLimit = 0;
		} else if (manager.bazaar.isAtLimit()) return;

		await manager.bazaar.updateProducts();

		// TODO: Auto cookie
		if (!manager.hasCookie) {
			logger.error('Stopping flipper: no cookie');
			manager.postNotification(
				'No Cookie Buff',
				`Detected no cookie buff for ${manager.account.username}, stopping now. If you wish to continue, please purchase and consume a booster cookie manually.`,
				3
			);
			this.stop();
			return;
		} else if ((await this.getCookieBuffTime()) < 24 * 60 * 60 * 1000 && manager.config.options.general.autoCookie) {
			logger.debug('Less than 2 days left of cookie buff');
			const cookie = this.manager.bazaar.getProduct('BOOSTER_COOKIE');
			if (!cookie) return logger.debug('Failed to get BOOSTER_COOKIE bazaar products');
			if (cookie.instantBuyPrice * 2 > this.manager.getPurse())
				return logger.debug('Not buying a cookie: not enough money');
			await this.buyCookie();
			return;
		}

		await manager.bazaar.openManageOrders();
		const total = manager.bazaar.getTotal();

		this.postUpdate();

		if (this.startingTotal === undefined) this.startingTotal = total;
		if (this.startingDailyLimit === undefined) this.startingDailyLimit = manager.bazaar.usedDailyLimit;

		logger.debug([
			`Found ${manager.bazaar.orders.length} orders worth ${formatNumber(
				manager.bazaar.getOrdersWorth()
			)} coins in total: ${JSON.stringify(manager.bazaar.orders)}`,
			`Purse: ${formatNumber(this.manager.getPurse())}`,
			`Inventory (${formatNumber(
				manager.bazaar.getInvWorth()
			)}) (${manager.getEmptyInventorySpace()} empty slots): ${JSON.stringify(
				manager.bazaar.getBazaarProductsFromInv().map(({product, amount}) => ({id: product.id, amount}))
			)}`,
			`Spent: ${formatNumber(manager.bazaar.getSpent())}`,
			`Total: ${formatNumber(total)}`,
			`Starting total: ${formatNumber(this.startingTotal)}`,
			`Profit: ${formatNumber(total - this.startingTotal)}`,
			`Elapsed: ${formatDuration(this.timer.getElapsedTime())}`,
			`Profit / h: ${formatNumber((total - this.startingTotal) / (this.timer.getElapsedTime() / 1000 / 60 / 60))}`,

			`Daily limit: ${formatNumber(manager.bazaar.usedDailyLimit)} / ${formatNumber(manager.bazaar.getTrueLimit())}`,
			`Cycles: ${this.cycles}`,
		]);
		const inv = manager.bazaar.getBazaarProductsFromInv();
		const last = inv[0]?.product;

		await (async () => {
			if (manager.bazaar.getRemainingOrderSpace('sell') > 0) {
				if (manager.isInventoryFull()) return this.sellInvAndStash();

				const order = manager.bazaar.orders.find(
					(e) => !last || e.productId === last.id || (e.filled && e.type === 'sell')
				);

				if (order) {
					if (order.undercutAmount === undefined || order.amount === undefined) throw Error('Weird order');
					if (order.filled) {
						if (order.type === 'sell') return manager.bazaar.claimOrder(order);
						else {
							if (manager.bazaar.fitsInv(order)) return manager.bazaar.claimOrder(order);
							else if (manager.bazaar.getRemainingOrderSpace('sell') > 0) return manager.bazaar.flipOrder(order);
						}
					}
					if (order.undercutAmount / order.amount > manager.config.options.orders.relistRatio)
						return manager.bazaar.cancelOrder(order);
				}
				if (manager.bazaar.getRemainingOrderSpace('sell') > 0) {
					if (inv.length === 1)
						return this.manager.bazaar.createOrder({
							productId: inv[0].product.id,
							type: 'sell',
						});
					else if (inv.length > 1) return this.sellInvAndStash();
				}
			} else {
				logger.debug('0 remaining space for sell offers');
				const sellOffers = manager.bazaar.orders
					.filter((order) => order.type === 'sell')
					.sort((a, b) => {
						if (last) {
							if (a.productId === last.id && b.productId !== last.id) return -1;
							if (a.productId !== last.id && b.productId === last.id) return 1;
						}
						const countDupes = (order: Order): number =>
							manager.bazaar.orders.reduce(
								(prev, order1) =>
									order.type === order1.type && order.productId === order1.productId ? prev + 1 : prev,
								0
							);

						return countDupes(b) - countDupes(a);
					});
				const order = sellOffers.at(0);
				if (!order) return;

				if (order.filled) return manager.bazaar.claimOrder(order);
				return manager.bazaar.cancelOrder(order);
			}
			// Create buy orders and wait
			{
				const remainingTime = this.getRemainingTime();

				const budget = Math.min(
					manager.getPurse(),
					manager.config.options.general.maxUsage - manager.bazaar.getSpent(),
					manager.bazaar.getRemainingLimit()
				);
				if (manager.bazaar.getRemainingOrderSpace('buy') > 0 && budget > 0) {
					const orders = await this.getOptimalOrders(
						budget,
						manager.bazaar.getRemainingOrderSpace('buy'),
						manager.bazaar.getRemainingLimit(),
						remainingTime / 60 / 60 / 1000,
						manager.bazaar.orders,
						this.timer.getElapsedTime(),
						this.cycles
					);
					logger.debug([
						`Creating buy orders...`,
						`Budget: ${formatNumber(budget)}`,
						`Max usage: ${formatNumber(manager.config.options.general.maxUsage)}`,
						`Spent: ${formatNumber(manager.bazaar.getSpent())}`,
						`Remaining space: ${manager.bazaar.getRemainingOrderSpace('buy')}`,
						`Orders: ${JSON.stringify(orders)}`,
					]);
					for (const order of orders) await manager.bazaar.createOrder(order);
				} else {
					logger.debug([
						`Not creating any more buy orders`,
						`Remaining space: ${manager.bazaar.getRemainingOrderSpace('buy')}`,
						`Budget: ${formatNumber(budget)}`,
						`Purse: ${formatNumber(manager.getPurse())}`,
						`Remaining daily limit: ${formatNumber(manager.bazaar.getRemainingLimit())}`,
						`Remaining usage: ${formatNumber(manager.config.options.general.maxUsage - manager.bazaar.getSpent())}`,
					]);
				}

				this.cycles++;

				const avgUsage = (manager.bazaar.usedDailyLimit - (this.startingDailyLimit ?? 0)) / this.cycles;
				const avgDuration = (this.timer.getElapsedTime() - this.totalWaitTime - this.totalTimeout) / this.cycles;

				const remainingCycles = manager.bazaar.getRemainingLimit() / avgUsage;

				const delay = (remainingTime - remainingCycles * avgDuration) / (remainingCycles - 1);

				logger.debug([
					`Daily limit: ${formatNumber(manager.bazaar.usedDailyLimit)} / ${formatNumber(
						manager.bazaar.getTrueLimit()
					)} (starting: ${formatNumber(this.startingDailyLimit ?? 0)})`,
					`Cycles: ${formatNumber(this.cycles)}`,
					`Elapsed time: ${formatDuration(this.timer.getElapsedTime())}`,
					`Total wait time: ${formatDuration(this.totalWaitTime)}`,
					`Total timeout: ${formatDuration(this.totalTimeout)}`,
					`elapsedTime - totalWaitTime - totalScheduledTimeout: ${formatDuration(
						this.timer.getElapsedTime() - this.totalWaitTime - this.totalTimeout
					)}`,
					`Avg. limit usage: ${formatNumber(avgUsage)}`,
					`Avg. duration: ${formatDuration(avgDuration)}`,
					`Remaining time: ${formatDuration(remainingTime)}`,
					`Remaining cycles: ${formatNumber(remainingCycles)}`,
					`Delay: ${formatDuration(delay)}`,
				]);

				if (!isNaN(delay) && delay > 0) {
					logger.debug(`Waiting for ${formatDuration(delay)}...`);
					this.totalWaitTime += delay;
					await wait(delay);
				}
			}
		})();
	}

	async getOptimalOrders(
		budget: number,
		orderCount: number,
		remainingDailyLimit: number,
		goalTime: number,
		orders: Order[],
		elapsedTime: number,
		cycleCount: number
	): Promise<Order[]> {
		try {
			const response = await this.manager.waitForReply('solve', {
				budget,
				orderCount,
				remainingDailyLimit,
				goalTime,
				orders,
				elapsedTime,
				cycleCount,
				filter: this.manager.config.options.filter,
				maxOrderSize: this.manager.config.options.orders.maxOrderSize,
			});
			if (!response) throw new Error('No response');
			if (typeof response !== 'object') throw new Error('Invalid response');
			if (!('newOrders' in response)) throw new Error('Invalid response');
			const {newOrders} = response;
			if (!Array.isArray(newOrders)) throw new Error('Invalid response');
			return newOrders;
		} catch (err) {
			logger.error(`Failed to get orders: ${err}`);
			return [];
		}
	}

	async sellInvAndStash(instantSell?: boolean) {
		const bot = this.manager.bot;

		logger.debug('Selling inventory and stash');

		const MAX_FAILS = 10;
		let fails = 0;
		while (
			this.state === 'running' &&
			this.manager.onlineStatus === 'online' &&
			this.manager.location === 'island' &&
			(instantSell || this.manager.bazaar.getRemainingOrderSpace('sell') > 0) &&
			Bazaar.DAILY_LIMIT - this.manager.bazaar.usedDailyLimit > 0
		) {
			try {
				await this.manager.bazaar.openManageOrders();
				await wait(2000);

				let isEmpty = false;

				logger.debug('Picking up stash');
				if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
				await this.manager.sendChat('/pickupstash');
				const message = await this.manager.waitForMessage([/stash/], true);
				if (message.includes('all') || message.includes("isn't holding any")) isEmpty = true;

				if (instantSell) await this.manager.bazaar.instantSell();
				else {
					const items = this.manager.bazaar.getBazaarProductsFromInv();
					if (items.length === 0) break;

					const product = items[0].product;
					await this.manager.bazaar.createOrder({productId: product.id, type: 'sell'});
				}

				if (isEmpty && this.manager.bazaar.getBazaarProductsFromInv().length === 0) break;
				fails--;
			} catch (err) {
				logger.error(`Error while selling inv: ${err}`);
				if (fails++ > MAX_FAILS) break;
			}
		}
		logger.debug('Finished selling inventory and stash');
	}

	async checkForOnlineMembers(): Promise<boolean> {
		const {manager: account} = this;
		const {bot} = account;
		try {
			bot.setQuickBarSlot(8); // Skyblock menu
			bot.activateItem();
			bot.deactivateItem();

			await account.waitForBotEvent('windowOpen');
			await account.clickItem('Profile Management');
			if (!bot.currentWindow) throw new Error('Failed to open profile management');
			const selected = bot.currentWindow
				?.containerItems()
				.findIndex((item) => getCleanLore(item).includes('You are playing on this profile!'));

			if (selected === -1) {
				throw new Error('Failed to find selected profile');
			}

			await account.clickSlot(selected, 1);

			this.onlineMembers = bot.currentWindow
				.containerItems()
				.map((item) => {
					const name = clean(item.customName ?? '')
						.match(/(?:\[[a-zA-Z+]+\]\s+)?([a-zA-Z0-9_]+)/)
						?.at(1);
					if (!name) return;
					const status = getCleanLore(item)
						.match(/Status:\s+(Playing SkyBlock!|Not playing SkyBlock|Offline)/)
						?.at(1);
					if (!status) return;
					if (name === bot.username) return;
					if (status !== 'Playing SkyBlock!') return;

					return name;
				})
				.filter((e) => (e === undefined ? false : true)) as string[];
			return this.onlineMembers.length > 0;
		} catch (err) {
			logger.error(`Failed to check coop's online status: ${err}`);
			return true;
		}
	}

	coopFailsafe() {
		return this.changeActivity('coopFailsafe', async () => {
			if (!this.onlineMembers.length) return;
			this.manager.postNotification(
				'Co-op failsafe',
				`Some Co-op members are online (${this.onlineMembers.join(', ')}), attempting to instant-sell everything...`,
				3
			);
			await this.manager.sendChat(`/cc hellooo ${this.onlineMembers.join(', ')}! pls don't touch my orders!!!!`);

			logger.debug('Liquidating');
			while (this.state === 'running' && Bazaar.DAILY_LIMIT - this.manager.bazaar.usedDailyLimit > 0) {
				await this.manager.bazaar.openManageOrders();
				if (!this.manager.bazaar.orders) break;

				this.manager.bazaar.orders.sort((a, b) => (b.amount ?? 0) * (b.price ?? 0) - (a.amount ?? 0) * (a.price ?? 0));
				const order = this.manager.bazaar.orders[0];

				if (this.manager.isInventoryFull()) await this.sellInvAndStash(true);
				if (order?.filled) await this.manager.bazaar.claimOrder(order);
				else await this.manager.bazaar.cancelOrder(order);
			}
			logger.debug('Finished liquidating');

			// Routine checks every 10 minutes
			while (this.state === 'running') {
				await wait(10 * 60 * 1000);
				if (this.manager.onlineStatus !== 'online' || this.manager.location !== 'island') return;
				if (!(await this.checkForOnlineMembers())) break;
			}
		});
	}

	buyCookie() {
		return this.changeActivity('buyingCookie', async () => {
			logger.debug('Attempting to buy cookie');
			try {
				const bot = this.manager.bot;
				const boosterCookie = this.manager.bazaar.getProduct('BOOSTER_COOKIE');
				if (!boosterCookie) {
					logger.error(`Failed to get the booster cookie product`);
					return;
				}

				this.manager.postNotification('Auto Cookie', 'Attempting to buy a new Booster Cookie', 3);

				if (findItemSlot(boosterCookie.name, bot.inventory, true) === -1) {
					if (this.manager.isInventoryFull()) {
						await this.manager.bazaar.instantSell(this.manager.bazaar.getBazaarProductsFromInv()[0]?.product);
					}
					await this.manager.bazaar.instantBuy(boosterCookie, 1);
				}
				if (bot.currentWindow) bot.closeWindow(bot.currentWindow);

				await wait(1000);
				const slot = findItemSlot(boosterCookie.name, bot?.inventory, true);
				if (slot === -1) {
					logger.error(
						`Failed to find cookie (${boosterCookie.name}) from inventory [${bot?.inventory
							?.items()
							?.map((e) => clean(e?.customName ?? 'empty'))
							?.join(', ')}]`
					);
					return;
				}

				logger.debug('Consuming cookie...');
				bot.setQuickBarSlot(0);
				if (slot !== bot.quickBarSlot) await bot.moveSlotItem(slot, bot.inventory.hotbarStart + bot.quickBarSlot);
				await wait(250);
				bot.activateItem();
				bot.deactivateItem();
				await this.manager.waitForBotEvent('windowOpen');
				await this.manager.clickItem('Consume Cookie', 0, waitForEvent(bot._client, 'window_items'));
			} catch (err) {
				logger.error(`Auto cookie failed: ${err}`);
			}
		});
	}

	checkTime = 0;
	cookieBuffTime = 0;
	async getCookieBuffTime() {
		if (this.cookieBuffTime) return this.cookieBuffTime - (Date.now() - this.checkTime);

		const {bot} = this.manager;
		bot.setQuickBarSlot(8);
		bot.activateItem();
		bot.deactivateItem();
		await this.manager.waitForBotEvent('windowOpen');
		const cookieBuffItem = findItem('Booster Cookie', bot.currentWindow);
		if (!cookieBuffItem) return 0;
		const matches = getCleanLore(cookieBuffItem).match(
			/Duration:(?:\s+(\d+)y)?(?:\s+(\d+)d)?(?:\s+(\d+)h)?(?:\s+(\d+)m)?(?:\s+(\d+)s)?/
		);
		if (!matches) return 0;
		if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
		this.cookieBuffTime =
			((Number(matches[1]) || 0) * 60 * 60 * 24 * 365 +
				(Number(matches[2]) || 0) * 60 * 60 * 24 +
				(Number(matches[3]) || 0) * 60 * 60 +
				(Number(matches[4]) || 0) * 60 +
				(Number(matches[5]) || 0)) *
			1000;
		this.checkTime = Date.now();

		return this.cookieBuffTime;
	}

	serialize(): FlipperUpdateData {
		return {
			isInTimeout: this.isInTimeout,
			state: this.state,
			activeActivity: this.activeActivity,
			elapsedTime: this.timer.getElapsedTime(),
			cycles: this.cycles,
			totalWaitTime: this.totalWaitTime,
			totalTimeout: this.totalTimeout,
			startingTotal: this.startingTotal,
			startingDailyLimit: this.startingDailyLimit,
			profit: this.startingTotal ? this.manager.bazaar.lastValidated.total - this.startingTotal : undefined,
			cookieBuffTime: this.cookieBuffTime ? this.cookieBuffTime - (Date.now() - this.checkTime) : 0,
			onlineMembers: this.onlineMembers,
		};
	}
}

class Timer {
	startTime?: number;
	pauseTime?: number;
	elapsedTime = 0;
	isRunning = false;

	start() {
		if (!this.isRunning) {
			this.isRunning = true;
			if (this.startTime === undefined) this.startTime = Date.now() - this.elapsedTime;
			else {
				if (this.pauseTime !== undefined) {
					const pausedDuration = Date.now() - this.pauseTime;
					this.startTime += pausedDuration;
				}
			}
			this.isRunning = true;
		}
	}

	pause() {
		if (this.isRunning) {
			this.pauseTime = Date.now();
			this.isRunning = false;
		}
	}

	stop() {
		if (this.isRunning || this.startTime !== undefined) {
			this.startTime = undefined;
			this.elapsedTime = 0;
			this.isRunning = false;
		}
	}

	getElapsedTime() {
		if (this.startTime !== null) {
			if (this.startTime !== undefined && this.isRunning) {
				this.elapsedTime = Date.now() - this.startTime;
			}
			return this.elapsedTime;
		}
		return 0;
	}
}

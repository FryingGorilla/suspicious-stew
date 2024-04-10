import axios from 'axios';
import Config from '../main-config';
import logger from '../../shared/logger';
import {globals} from '../../shared/globals';
import {BazaarApiArgs, HypixelAPIResponse, HypixelProducts, Order, Product} from '../../shared/types';
import {AppDataSource} from './data-source';
import {Hour} from './entity/bazaar/Hour';
import {LessThan} from 'typeorm';
import {Day} from './entity/bazaar/Day';

export function bazaarApi() {
	type Cache = {
		products: {time: number; data: HypixelProducts; maxAge: number};
		knownItems: {
			time: number;
			data: {
				id: string;
				name: string;
				isReal: boolean;
				maxStack: number;
			}[];
			maxAge: number;
		};
	};
	const cache: Cache = {
		products: {
			time: 0,
			data: {},
			maxAge: 1000,
		},
		knownItems: {
			time: 0,
			data: [],
			maxAge: 1000 * 60 * 5,
		},
	};
	const fetchProducts = async (): Promise<HypixelProducts> => {
		if (Date.now() - cache.products.time > cache.products.maxAge) {
			try {
				const {
					data: {products},
				} = await axios<HypixelAPIResponse>('https://api.hypixel.net/v2/skyblock/bazaar');
				if (products) {
					cache.products.data = products;
					cache.products.time = Date.now();
				}
			} catch (err) {
				logger.error(`Failed to fetch products: ${err}`);
			}
		}
		return cache.products.data;
	};
	const fetchKnownItems = async (): Promise<Cache['knownItems']['data']> => {
		if (Date.now() - cache.knownItems.time > cache.knownItems.maxAge) {
			try {
				const res = await axios(new URL('/api/skyblock/items', globals.API_URL).toString(), {
					headers: {Authorization: Config.option('apiToken')},
				});
				if (res.status >= 200 && res.status < 300) {
					cache.knownItems.data = res.data;
					cache.knownItems.time = Date.now();
				}
			} catch (err) {
				logger.error(`Failed to fetch known items: ${err}`);
			}
		}
		return cache.knownItems.data;
	};

	const updateHour = async () => {
		try {
			const products = await fetchProducts();
			const hourAgo = Date.now() - 60 * 60 * 1000;
			const data = (await fetchKnownItems())
				.filter(({isReal}) => isReal)
				.map(({id}) => {
					const product = products[id];
					return {
						item_id: id,
						buy_price: product?.sell_summary.at(0)?.pricePerUnit ?? 0,
						sell_price: product?.buy_summary.at(0)?.pricePerUnit ?? 0,
						time: Date.now(),
					};
				});
			await AppDataSource.manager.delete(Hour, {time: LessThan(hourAgo)});
			await AppDataSource.manager.createQueryBuilder().insert().into(Hour).values(data).execute();
		} catch (err) {
			logger.error(`Failed to update hour data: ${err}`);
		}
	};
	const updateDay = async () => {
		try {
			const products = await fetchProducts();
			const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
			const data = (await fetchKnownItems())
				.filter(({isReal}) => isReal)
				.map(({id}) => {
					const product = products[id];
					return {
						item_id: id,
						buy_price: product?.sell_summary.at(0)?.pricePerUnit ?? 0,
						sell_price: product?.buy_summary.at(0)?.pricePerUnit ?? 0,
						time: Date.now(),
					};
				});
			await AppDataSource.manager.delete(Day, {time: LessThan(dayAgo)});
			await AppDataSource.manager.createQueryBuilder().insert().into(Day).values(data).execute();
		} catch (err) {
			logger.error(`Failed to update hour data: ${err}`);
		}
	};

	return {
		solve: async ({
			filter,
			budget,
			orderCount,
			remainingDailyLimit,
			goalTime,
			orders,
			elapsedTime,
			cycleCount,
			maxOrderSize,
		}: BazaarApiArgs): Promise<{maxHourlyProfit: number; newOrders: Order[]}> => {
			const getItems = async () => {
				const [day, hour, products, knownItems] = await Promise.all([
					AppDataSource.manager
						.find(Day, {
							order: {
								time: 'ASC',
							},
						})
						.then((rows) => {
							const val: Record<string, Day[]> = {};
							rows.forEach((row) => {
								if (!(row.item_id in val)) val[row.item_id] = [];
								val[row.item_id].push(row);
							});
							return val;
						}),
					AppDataSource.manager
						.find(Hour, {
							order: {
								time: 'ASC',
							},
						})
						.then((rows) => {
							const val: Record<string, Hour[]> = {};
							rows.forEach((row) => {
								if (!(row.item_id in val)) val[row.item_id] = [];
								val[row.item_id].push(row);
							});
							return val;
						}),
					fetchProducts(),
					fetchKnownItems(),
				]);
				return knownItems
					?.filter((item) => {
						if (!item.isReal) {
							return false;
						}
						if (orders.some(({productId, type}) => productId === item.id && type === 'buy')) {
							return false;
						}
						if (filter.blacklist.some((pattern) => new RegExp(pattern).test(item.id))) {
							return false;
						}
						if (filter.whitelist.length && !filter.whitelist.some((pattern) => new RegExp(pattern).test(item.id))) {
							return false;
						}
						return true;
					})
					?.map(({id, name, maxStack}) => {
						const product = products[id];
						let buyUndercuts = 0,
							sellUndercuts = 0,
							buyPriceSum = 0,
							sellPriceSum = 0;

						day[id]?.forEach(({buy_price, sell_price}) => {
							buyPriceSum += buy_price;
							sellPriceSum += sell_price;
						});
						hour[id]?.forEach((current, index) => {
							const prev = hour[id][index - 1];
							if (!prev) return;
							if (prev.sell_price > current.sell_price) sellUndercuts++;
							if (prev.buy_price < current.buy_price) buyUndercuts++;
						});
						const hours = ((hour[id]?.at(-1)?.time ?? 0) - (hour[id]?.at(0)?.time ?? 0)) / 1000 / 60 / 60;

						const buyPrice = product?.sell_summary[0]?.pricePerUnit ? product?.sell_summary[0]?.pricePerUnit + 0.1 : 0;
						const sellPrice = product?.buy_summary[0]?.pricePerUnit ? product?.buy_summary[0]?.pricePerUnit - 0.1 : 0;
						const hourlyBuyMovement = (product?.quick_status?.buyMovingWeek ?? 0) / 7 / 24;
						const hourlySellMovement = (product?.quick_status?.sellMovingWeek ?? 0) / 7 / 24;
						const hourlyBuyUndercuts = buyUndercuts / hours;
						const hourlySellUndercuts = sellUndercuts / hours;

						const usage = orders.reduce(
							(prev, cur) => prev + (cur.productId === id ? (cur.amount ?? 0) * (cur.price ?? 0) : 0),
							0
						);
						const usageLeft = Math.min(
							filter?.maxUsageProduct ? filter.maxUsageProduct - usage : Infinity,
							budget / orderCount
						);

						const avgCycleTime = (cycleCount ? elapsedTime / cycleCount : 1) / (60 * 60 * 1000);
						const margin = sellPrice * 0.99 - buyPrice;
						const amount = Math.floor(Math.min(usageLeft / buyPrice, maxOrderSize, 71_680));
						const buyUsage = amount * buyPrice * Math.min(1 / avgCycleTime, hourlyBuyUndercuts);
						const sellUsage = amount * sellPrice * Math.min(1 / avgCycleTime, hourlySellUndercuts);

						// For buy orders
						// Sell offers are always going to have more uptime than buy offers
						const avgUndercutTime = 1 / Math.max(1, hourlyBuyUndercuts);
						const uptime = Math.max(avgCycleTime, avgCycleTime - avgUndercutTime) / avgCycleTime;

						const profitability = margin * Math.min(hourlyBuyMovement, hourlySellMovement) * uptime;

						return {
							id,
							name,
							maxStack,
							margin,
							buyPrice,
							sellPrice,
							amount,
							buyUsage,
							sellUsage,
							profitability,
							hourlyBuyMovement,
							hourlySellMovement,
							hourlyBuyUndercuts,
							hourlySellUndercuts,
							avgBuyPrice: buyPriceSum / day[id]?.length,
							avgSellPrice: sellPriceSum / day[id]?.length,
							uptime,
						};
					})
					.filter((item) => {
						if (item.profitability == null || item.profitability < 0) return false;
						if (item.amount < 1) return false;

						if (filter.maxHourlyUndercuts < Math.max(item.hourlyBuyUndercuts, item.hourlySellUndercuts)) return false;

						if (Math.min(item.hourlyBuyMovement, item.hourlySellMovement) < filter.minMovement) return false;

						if (item.buyPrice < (filter?.minPrice ?? 0.1)) return false;
						if (item.buyPrice > filter.maxPrice) return false;

						if (Math.abs(item.avgSellPrice - item.sellPrice) > item.sellPrice * filter.maxDiffDay) return false;
						if (Math.abs(item.avgBuyPrice - item.buyPrice) > item.buyPrice * filter.maxDiffDay) return false;

						if (item.sellPrice / item.buyPrice < filter.minMargin) return false;
						if (item.sellPrice / item.buyPrice > filter.maxMargin) return false;

						return true;
					});
			};

			type Item<T> = {weight: number; value: number} & T;
			const solve = <T>(
				items: Item<T>[],
				limit: number,
				itemCount: number
			): {maxValue: number; selectedIndices: number[]} => {
				const n = items.length;
				const dp = new Array(itemCount + 1).fill(null).map(() => new Array(limit + 1).fill(0));
				const selectedItems: number[][][] = new Array(itemCount + 1)
					.fill(null)
					.map(() => new Array(limit + 1).fill([]));

				for (let i = 1; i <= n; i++) {
					const currentItem = items[i - 1];
					const currentWeight = currentItem.weight;
					const currentValue = currentItem.value;

					for (let w = limit; w >= currentWeight; w--) {
						for (let j = itemCount; j > 0; j--) {
							if (j > 0 && w >= currentWeight) {
								const option1 = dp[j][w];
								const option2 = dp[j - 1][w - currentWeight] + currentValue;

								if (option2 >= option1) {
									dp[j][w] = option2;
									selectedItems[j][w] = [...selectedItems[j - 1][w - currentWeight], i];
								}
							}
						}
					}
				}

				return {
					maxValue: dp[itemCount][limit],
					selectedIndices: selectedItems[itemCount][limit].map((itemIndex) => itemIndex - 1),
				};
			};
			const items = await getItems();
			const divider = remainingDailyLimit / 1000;
			const {maxValue, selectedIndices} = solve(
				items?.map((item) => ({
					id: item.id,
					value: item.profitability,
					weight: Math.round((item.buyUsage + item.sellUsage) / divider),
				})) ?? [],
				Math.round(remainingDailyLimit / goalTime / divider),
				orderCount
			);
			return {
				maxHourlyProfit: maxValue,
				newOrders: selectedIndices.map((index) => {
					return {
						...items[index],
						type: 'buy',
						productId: items[index].id,
					};
				}),
			};
		},
		getProducts: async (): Promise<Product[]> => {
			const [knownItems, products] = await Promise.all([fetchKnownItems(), fetchProducts()]);

			return knownItems
				.filter(({isReal}) => isReal)
				.map(({id, maxStack, name}) => {
					const product = products[id];
					if (!product) return null;
					const buyPrice = product?.sell_summary[0]?.pricePerUnit ? product?.sell_summary[0]?.pricePerUnit + 0.1 : 0;
					const sellPrice = product?.buy_summary[0]?.pricePerUnit ? product?.buy_summary[0]?.pricePerUnit - 0.1 : 0;
					const hourlyBuyMovement = (product?.quick_status?.buyMovingWeek ?? 0) / 7 / 24;
					const hourlySellMovement = (product?.quick_status?.sellMovingWeek ?? 0) / 7 / 24;
					const margin = sellPrice * 0.99 - buyPrice;

					const profitability = margin * Math.min(hourlyBuyMovement, hourlySellMovement);

					return {
						id,
						name,
						maxStack,
						hourlyBuyMovement,
						hourlySellMovement,
						buyPrice,
						sellPrice,
						profitability,
						margin,
						buyOrders: product.sell_summary.map(({amount, pricePerUnit}) => {
							return {
								productId: id,
								type: 'buy',
								amount,
								price: pricePerUnit,
							};
						}),
						sellOrders: product.buy_summary.map(({amount, pricePerUnit}) => {
							return {
								productId: id,
								type: 'sell',
								amount,
								price: pricePerUnit,
							};
						}),
						// TODO: Fix
						instantBuyPrice: product.quick_status.buyPrice,
						instantSellPrice: product.quick_status.sellPrice,
					};
				})
				.filter((val) => val !== null) as Product[];
		},
		start: async () => {
			setInterval(updateHour, (60 / 100) * (60 * 1000)); // 100x / 60min
			setInterval(updateDay, (60 / 5) * (60 * 1000)); // 5x / 60min
		},
	};
}

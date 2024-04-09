import {rm} from 'fs/promises';
import {jsonc} from 'jsonc';
import logger from './logger';
import {existsSync} from 'fs';
import {globals} from './globals';

type Options = {
	filter: {
		whitelist: string[];
		blacklist: string[];
		maxDiffDay: number;
		minPrice: number;
		maxPrice: number;
		minMargin: number;
		maxMargin: number;
		minMovement: number;
		maxUsageProduct: number;
		maxHourlyUndercuts: number;
	};
	orders: {
		maxOrders: number;
		maxBuyOrders: number;
		maxSellOrders: number;
		relistRatio: number;
		maxOrderSize: number;
	};
	general: {
		maxUsage: number;
		timeouts: {start: number; end: number}[];
	};
	failsafe: {
		coopFailsafe: boolean;
		autoCookie: boolean;
		antiAfk: boolean;
		npcMode: boolean;
	};
};
export default class BotConfig {
	name = 'default';
	options: Options = {
		filter: {
			whitelist: [],
			blacklist: ['ESSENCE_[a-zA-Z]+'],
			maxDiffDay: 15 / 100,
			minPrice: 10000,
			maxPrice: 20_000_000,
			minMargin: 1 / 100,
			maxMargin: 150 / 100,
			minMovement: 150,
			maxUsageProduct: 15_000_000,
			maxHourlyUndercuts: 60,
		},
		orders: {
			maxOrders: 14,
			maxBuyOrders: 7,
			maxSellOrders: 14,
			relistRatio: 10 / 100,
			maxOrderSize: 5000,
		},
		general: {
			maxUsage: 40_000_000,
			timeouts: [{start: 12, end: 16}],
		},
		failsafe: {
			coopFailsafe: false,
			autoCookie: false,
			antiAfk: false,
			npcMode: false,
		},
	};

	constructor(public filepath: string = globals.DEFAULT_CONFIG_FILE) {}

	serialize() {
		return {name: this.name, filepath: this.filepath, options: this.options};
	}

	async save() {
		try {
			await jsonc.write(this.filepath, this.serialize(), {space: '\t'});
			return this;
		} catch (err) {
			throw new Error(`Error saving config ${this.filepath}: ${err}`);
		}
	}

	async delete() {
		if (!existsSync(this.filepath)) {
			logger.debug(`Config file '${this.filepath}' is not present, failed to delete`);
			return null;
		}
		try {
			await rm(this.filepath);
			return this;
		} catch (err) {
			throw new Error(`Error deleting config ${this.filepath}: ${err}`);
		}
	}

	loadFromObject(o: unknown): BotConfig {
		if (typeof o !== 'object' || o == null) throw new Error(`Invalid config: config is not an object`);
		if (!('name' in o) || typeof o.name !== 'string') {
			throw new Error(`Invalid config ${jsonc.stringify(o, {space: 4})}: config does not contain a name`);
		}
		if (!('options' in o) || typeof o.options !== 'object' || o.options == null) {
			throw new Error(`Invalid config ${jsonc.stringify(o, {space: 4})}: config does not contain options`);
		}

		this.name = o.name;

		try {
			for (const [categoryName, category] of Object.entries(o.options)) {
				for (const [optionName, optionValue] of Object.entries(category)) {
					if (
						categoryName in this.options &&
						// @ts-expect-error: category is valid
						optionName in this.options[categoryName] &&
						// @ts-expect-error: category is valid and so is the option
						this.areTypesEqual(optionValue, categoryName, optionName)
					) {
						// @ts-expect-error: category is valid and so is the option
						this.options[categoryName][optionName] = optionValue;
					}
				}
			}
			return this;
		} catch (err) {
			throw new Error(`Failed to load config from ${jsonc.stringify(o, {space: 4})}: ${err}`);
		}
	}

	private areTypesEqual<Category extends keyof Options>(
		value: unknown,
		category: Category,
		option: keyof Options[Category]
	): boolean {
		if (value == null) return false;
		const optionValue = this.options[category][option];
		if (Array.isArray(optionValue)) return Array.isArray(value);
		if (typeof optionValue === 'number' && typeof value === 'number') return true;
		if (typeof optionValue === 'string' && typeof value === 'string') return true;
		if (typeof optionValue === 'boolean' && typeof value === 'boolean') return true;
		return false;
	}

	async load() {
		if (!existsSync(this.filepath)) {
			logger.debug(`Config file '${this.filepath}' is not present, can't load`);
			return null;
		}

		try {
			const data = await jsonc.read(this.filepath);
			return this.loadFromObject(data);
		} catch (err) {
			throw new Error(`Error loading config ${this.filepath}: ${err}`);
		}
	}
}

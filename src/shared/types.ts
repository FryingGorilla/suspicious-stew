export type HypixelProduct<T extends string> = {
	product_id: T;
	sell_summary: {amount: number; pricePerUnit: number; orders: number}[];
	buy_summary: {amount: number; pricePerUnit: number; orders: number}[];
	quick_status: {
		productId: T;
		sellPrice: number;
		sellVolume: number;
		sellMovingWeek: number;
		sellOrders: number;
		buyPrice: number;
		buyVolume: number;
		buyMovingWeek: number;
		buyOrders: number;
	};
};
export type HypixelProducts = {
	[key: string]: HypixelProduct<string> | undefined;
};

export type HypixelAPIResponse = {
	success: boolean;
	cause?: string;
	lastUpdated?: number;
	products?: HypixelProducts;
};

export type Product = {
	id: string;
	name: string;
	maxStack: number;
	hourlyBuyMovement: number;
	hourlySellMovement: number;
	sellPrice: number;
	buyPrice: number;
	instantSellPrice: number;
	instantBuyPrice: number;
	sellOrders: Order[];
	buyOrders: Order[];
	margin: number;
	// @Deprecated
	profitability: number;
};

export type Order = {
	type: 'buy' | 'sell';
	amount?: number;
	price?: number;
	productId: string;
	filled?: boolean;
	undercutAmount?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenericFunction = (...args: any[]) => any;
export type Persistent<T extends object> = AddParameter<T, [persistence?: {persistent: boolean}]>;
export type AddParameter<T, P extends unknown[]> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: [...A, ...P]) => R : T[K];
};

export type BazaarApiArgs = {
	filter: BotConfigOptions['filter'];
	budget: number;
	orderCount: number;
	remainingDailyLimit: number;
	goalTime: number;
	orders: Order[];
	elapsedTime: number;
	cycleCount: number;
	maxOrderSize: number;
};

export type ChildEvents =
	| 'get-products'
	| 'bazaar-update'
	| 'flipper-metrics'
	| 'flipper-update'
	| 'manager-update'
	| 'notification'
	| 'chat'
	| 'solve';
export type ChildData = {
	notification: {
		level: number;
		title: string;
		message: string;
	};
	chat: {
		message: string;
	};
	solve: BazaarApiArgs;
	'get-products': null;
	'manager-update': ManagerUpdateData;
	'bazaar-update': BazaarUpdateData;
	'flipper-update': FlipperUpdateData;
	'flipper-metrics': ManagerUpdateData & FlipperUpdateData & BazaarUpdateData;
};

export type FlipperState = 'running' | 'stopped' | 'paused';
export type OnlineStatus = 'online' | 'offline' | 'connecting';
export type Location = 'limbo' | 'lobby' | 'hub' | 'island' | 'skyblock';

export type FlipperUpdateData = {
	readonly isInTimeout: boolean;
	readonly state: FlipperState;
	readonly activeActivity: string;
	readonly elapsedTime: number;
	readonly cycles: number;
	readonly totalWaitTime: number;
	readonly totalTimeout: number;
	readonly onlineMembers: string[];
	readonly cookieBuffTime: number;

	readonly startingTotal?: number;
	readonly startingDailyLimit?: number;

	readonly profit?: number;
};

export type ManagerUpdateData = {
	readonly email?: string;
	readonly uuid: string;
	readonly username?: string;
	readonly configPath?: string;

	readonly hasCookie: boolean;
	readonly onlineStatus: OnlineStatus;
	readonly location: Location;
};

export type BazaarUpdateData = {
	readonly orders: Order[];
	readonly ordersWorth: number;
	readonly inventoryWorth: number;
	readonly spent: number;
	readonly total: number;
	readonly usedDailyLimit: number;
	readonly purse: number;
};

export type ChildToMain<T extends ChildEvents> = {
	event: T;
	data: ChildData[T];
	time: number;
	id: number;
};

export type MainToChild = {
	event: string;
	data: Record<string, unknown>;
	time: number;
	id: number;
};

export type BotConfigOptions = {
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
	limits: {
		sellLimit: number;
		buyLimit: number;
	};
	general: {
		maxUsage: number;
		schedule: {start: number; end: number}[];
	};
	failsafe: {
		coopFailsafe: boolean;
		autoCookie: boolean;
		antiAfk: boolean;
		npcMode: boolean;
	};
};

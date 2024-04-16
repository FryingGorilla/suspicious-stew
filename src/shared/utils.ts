import path from 'path';
import BotConfig from './bot-config';
import {PROMISE_TIMEOUT, globals} from './globals';
import fs from 'fs';
import {GenericFunction, Persistent} from './types';
import logger from './logger';
import EventEmitter, {once} from 'events';
import net from 'net';

export function getArgValue(argName: string | string[], defaultValue?: string) {
	const args = process.argv.slice(2);
	const index = args.findIndex((arg) => {
		arg = arg.replace(/^[-]+/, '');
		if (typeof argName === 'string') {
			return arg === argName;
		}
		return argName.includes(arg);
	});
	if (index === -1) return undefined;
	const next = index + 1;
	if (next >= args.length || args[next].startsWith('-')) {
		return defaultValue;
	}

	return args[next];
}
export async function getConfigs(): Promise<BotConfig[]> {
	const configs: BotConfig[] | PromiseLike<BotConfig[]> = [];
	await Promise.all(
		fs.readdirSync(globals.CONFIGS_DIR).map(async (filename) => {
			const filepath = path.join(globals.CONFIGS_DIR, filename);
			const config = new BotConfig(filepath);
			await config.load();
			configs.push(config);
		})
	);
	return configs;
}

export const safe = <T, A>(fn: (...args: A[]) => T, ...args: A[]): [T, null] | [null, unknown] => {
	try {
		return [fn(...args), null];
	} catch (error) {
		return [null, error];
	}
};
export const safeAsync = async <T, A>(
	fn: (...args: A[]) => Promise<T>,
	...args: A[]
): Promise<[T, null] | [null, unknown]> => {
	try {
		const result = await fn(...args);
		return [result, null];
	} catch (error) {
		return [null, error];
	}
};
export async function wait(ms: number) {
	if (ms <= 0) return;

	return new Promise((resolve) => setTimeout(resolve, ms));
}
export function getBoundFunction<T extends GenericFunction>(func: T, context: unknown): T {
	return func.bind(context) as T;
}
export function persistentActions() {
	const actions: {key: string; args: unknown[]}[] = [];

	function apply<T extends object>(target: T): Persistent<T> & T {
		logger.debug('Applying ' + actions.length + ' actions to ' + target.constructor.name);
		for (const {key, args} of actions) {
			// @ts-expect-error: key is a key of target
			if (!(key in target) || typeof target[key] !== 'function') continue;
			// @ts-expect-error: property is checked to be a function
			target[key](...args);
		}
		for (const key in target) {
			if (typeof target[key] !== 'function') continue;
			// @ts-expect-error: property is checked to be a function
			const originalFunc = getBoundFunction(target[key], target);

			// @ts-expect-error: property is checked to be a function
			target[key] = function (...args: unknown[]) {
				const last = args.at(-1);
				if (last && typeof last === 'object' && 'persistent' in last && last.persistent) {
					actions.push({key, args});
				}
				return originalFunc(...args);
			};
		}

		return target as Persistent<T> & T;
	}
	return {
		apply,
		actions,
	};
}
export const disableConsoleLog = (func: GenericFunction) => {
	/* eslint-disable no-console */
	const consoleLog = console.log;
	console.log = (...args) => {
		logger.debug(`${func.name || 'Unknown'} tried to console.log ${args}`);
	};
	func();
	console.log = consoleLog;
	/* eslint-enable no-console */
};

export function withTimeout<T>(promise: Promise<T>, timeout?: number): Promise<T> {
	return Promise.race([
		promise,
		wait(timeout ?? PROMISE_TIMEOUT).then(() => {
			throw new Error(`Promise timed out after ${timeout ?? PROMISE_TIMEOUT}ms.`);
		}),
	]);
}

export function waitForEvent<T extends EventEmitter>(emitter: T, eventName: string, timeout?: number) {
	const ac = new AbortController();
	if (timeout !== -1) {
		setTimeout(() => ac.abort(), timeout ?? PROMISE_TIMEOUT);
	}

	return once(emitter, eventName, {signal: ac.signal}).catch((err) => {
		throw new Error(`Error while listening for event ${eventName}: ${err}`);
	});
}
export function getHours(): number {
	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0);
	const millis = Date.now() - dayStart.getTime();
	return millis / 1000 / 60 / 60;
}
export const formatNumber = (number: number) => {
	const isNegative = number < 0;
	const absoluteValue = Math.abs(number);

	const formattedAbsoluteValue = Math.round(absoluteValue)
		.toString()
		.replace(/(.)(?=(\d{3})+$)/g, '$1,');

	return isNegative ? '-' + formattedAbsoluteValue : formattedAbsoluteValue;
};

export function formatDuration(duration: number) {
	const milliseconds = duration % 1000;
	const seconds = Math.floor((duration / 1000) % 60);
	const minutes = Math.floor((duration / (1000 * 60)) % 60);
	const hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
	const days = Math.floor(duration / (1000 * 60 * 60 * 24));

	const parts = [];

	if (days > 0) {
		parts.push(`${days} day${days > 1 ? 's' : ''}`);
	}
	if (hours > 0) {
		parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
	}
	if (minutes > 0) {
		parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
	}
	if (seconds > 0) {
		parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
	}

	if (parts.length === 0) {
		parts.push(`${milliseconds} second${milliseconds > 1 || milliseconds === 0 ? 's' : ''}`);
	}

	return parts.join(', ');
}
export const getFreePort = async (): Promise<number> => {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, () => {
			const address = srv.address();
			if (!address) return srv.close(() => reject('Failed to get free port'));
			const {port} = typeof address === 'string' ? (JSON.parse(address) as net.AddressInfo) : address;
			srv.close(() => resolve(port));
		});
	});
};

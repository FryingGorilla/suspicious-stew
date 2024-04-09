import logger from '../shared/logger';
import {getHours, sleep} from '../shared/utils';
import {BehaviorState, BehaviorUpdateData} from '../shared/types';
import BotManager from './bot-manager';

export interface Behavior {
	onStart?(): void;
	onPause?(): void;
	onStop?(): void;
	main?(): void | Promise<void>;
}

export abstract class Behavior {
	timer: Timer = new Timer();
	state: BehaviorState = 'stopped';
	activeActivity: string = 'default';

	isInTimeout = false;
	timeoutStartTime = 0;
	totalScheduledTimeout = 0;
	runId = 0;

	constructor(public manager: BotManager) {}

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

		this.onStart && this.onStart();
	}

	async startMain() {
		const interval = setInterval(() => {
			if (this.state !== 'running') clearInterval(interval);
			this.postTrackingData();
		}, 3 * 60 * 1000);

		const runId = this.runId;
		while (this.state === 'running' && this.runId === runId) {
			try {
				if (this.isScheduled()) {
					if (this.isInTimeout) {
						this.totalScheduledTimeout += Date.now() - this.timeoutStartTime;
						this.manager.postNotification('Timeout ended', 'Scheduled timeout has ended, logging back in', 1);
						this.isInTimeout = false;
						this.manager.connect();
					}
				} else if (!this.isInTimeout) {
					this.timeoutStartTime = Date.now();
					this.manager.postNotification('Timeout', 'Scheduled timeout has started, disconnecting', 1);
					this.isInTimeout = true;
					if (this.manager.onlineStatus === 'connecting') await this.manager.waitForBotEvent('spawn');
					this.manager.disconnect();
				}
				if (this.isInTimeout) continue;
				this.main && (await this.main());
				await sleep(1000);
			} catch (err) {
				logger.error(`An error occurred within the main function of ${this.getName()}: ${err}`);
			}
		}
	}

	isScheduled(): boolean {
		let isScheduled = true;
		const hours = getHours();

		for (const {start, end} of this.manager.config.options.general.timeouts) {
			if (start >= hours && hours <= end) {
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
		this.onPause && this.onPause();
	}

	stop(): void {
		if (this.state === 'stopped') return;
		logger.debug('Stopping...');
		this.state = 'stopped';
		this.activeActivity = 'default';

		this.timer.stop();
		this.postUpdate();

		this.manager.disconnect();

		this.onStop && this.onStop();
	}

	postUpdate(): void {
		this.manager.postEvent('behavior-update', this.serialize());
	}

	postTrackingData() {
		this.manager.postEvent('behavior-metrics', {
			...this.serialize(),
			manager: this.manager.serialize(),
		});
	}

	abstract getName(): string;
	abstract serialize(): BehaviorUpdateData;
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

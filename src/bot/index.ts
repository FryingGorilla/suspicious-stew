import path from 'path';
import logger from '../shared/logger';
import {getArgValue} from '../shared/utils';
import BotManager from './bot-manager';
import Account from '../shared/account';
import BazaarFlipper from './bazaar-flipper';
import EventEmitter from 'events';
import {rmSync} from 'fs';
import {globals} from '../shared/globals';

let lastEx: Error;
let lastExTime = 0;
process.on('uncaughtException', (ex) => {
	if (lastEx === ex && Date.now() - lastExTime < 1000) return;
	lastEx = ex;
	lastExTime = Date.now();

	logger.error([
		`Uncaught exception from ${uuid}: ${ex.message}`,
		`Caused by: ${ex.cause ?? 'none'}`,
		`Stack: ${ex.stack ?? 'none'}`,
	]);
});
const uuid = getArgValue(['uuid', 'u']);
main();

async function main() {
	if (!uuid) {
		logger.error('No uuid provided');
		process.exit(1);
	}
	logger.setDir(path.join('accounts', uuid));
	logger.debug('Starting bot');

	const account = new Account(uuid);
	await account.load();
	const botManager = new BotManager(account);
	await botManager.config.load();
	const flipper = new BazaarFlipper(botManager);

	const wrapper = new EventEmitter();
	process.on('message', ({event, ...args}) => {
		if (!event) {
			return logger.debug('Received invalid message from parent');
		}
		logger.debug(`Received message from parent: ${event}, ${JSON.stringify(args).slice(0, 100)}`);
		wrapper.emit(event, args);
	});

	wrapper.on('get', () => {
		botManager.postUpdate();
		flipper.postUpdate();
		botManager.bazaar.postUpdate();
	});
	wrapper.on('behavior::start', () => flipper.start());
	wrapper.on('behavior::pause', () => flipper.pause());
	wrapper.on('behavior::stop', () => flipper.stop());
	wrapper.on('botManager::sendChat', ({message}) => botManager.sendChat(message));
	wrapper.on('botManager::clickSlot', ({slot}) => botManager.clickSlot(slot));
	wrapper.on('botManager::updateOrders', () => {
		botManager.bazaar
			.updateProducts()
			.then(() => botManager.bazaar.openManageOrders())
			.then(() => {
				botManager.postUpdate();
				flipper.postUpdate();
			});
	});
	wrapper.on('botManager::connect', () => botManager.connect());
	wrapper.on('botManager::disconnect', () => botManager.disconnect());
	wrapper.on('botManager::useItem', () => {
		botManager.bot.activateItem();
		botManager.bot.deactivateItem();
	});
	wrapper.on('botManager::config::load', () => botManager.config.load());
	wrapper.on('botManager::config::set', async ({file}) => {
		botManager.config.filepath = file;
		await botManager.config.load();
		botManager.postUpdate();
	});
	wrapper.on('cache::clear', () => {
		flipper.stop();
		try {
			rmSync(globals.ACCOUNT_CACHE_DIR(account.email ?? ''), {force: true, recursive: true});
		} catch (err) {
			logger.error(String(err));
		}
	});
}

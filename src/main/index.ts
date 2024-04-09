import logger from '../shared/logger';
import {globals} from '../shared/globals';
import Config from './main-config';
import axios from 'axios';
import ngrok, {Ngrok} from 'ngrok';
import path from 'path';
import fs from 'fs';
import {execSync} from 'child_process';
import os from 'os';
import ip from 'ip';
import Server from './server';
import {AppDataSource} from './db/data-source';
import BotConfig from '../shared/bot-config';

process.on('uncaughtException', (err) => {
	logger.error(`uncaughtException: ${err}`);
});

const config = Config.get();
let id: number;

export const shutdown = async (code?: number) => {
	logger.info('Shutting down...');
	try {
		await axios({
			method: 'post',
			url: new URL('/api/hosts/remove', globals.API_URL).toString(),
			data: {
				id,
			},
			headers: {
				Authorization: config.options.apiToken,
			},
		});
	} catch (err) {
		logger.error(`Error posting to API: ${err}`);
	}
	process.exit(code ?? 0);
};

const events = ['beforeExit', 'SIGHUP', 'SIGINT', 'SIGTERM'];
events.forEach((event) => {
	process.on(event, () => {
		shutdown();
	});
});

async function main() {
	if (globals.IS_IN_DEV) logger.info('Running in development mode');

	await config.prompt();
	config.save();

	let url: string;
	if (config.options.host === 'localhost') {
		url = `http://localhost:${config.options.port}`;
	} else if (config.options.host === 'LAN') {
		url = `http://${ip.address()}:${config.options.port}`;
	} else if (config.options.host === 'WAN') {
		url = String((await axios.get('https://ipinfo.io/ip')).data);
	} else if (config.options.host === 'ngrok' && config.options.ngrokToken) {
		const options: Ngrok.Options = {authtoken: config.options.ngrokToken, addr: config.options.port};
		if (!globals.IS_IN_DEV) {
			// Copy virtual files to temp directory
			const virtualDir = path.join(__dirname, '../../node_modules/ngrok/bin');
			const targetDir = await fs.promises.mkdtemp(`${os.tmpdir()}${path.sep}`);

			logger.debug(`Copying files from ${virtualDir} to ${targetDir}`);
			try {
				const files = await fs.promises.readdir(virtualDir);

				for (const file of files) {
					const sourceFilePath = path.join(virtualDir, file);
					const targetFilePath = path.join(targetDir, file);

					await fs.promises.copyFile(sourceFilePath, targetFilePath);
					if (globals.IS_WINDOWS) execSync(`chmod +x ${targetFilePath}`);
					logger.debug(`Copied ${sourceFilePath} to ${targetFilePath}`);
				}

				logger.debug('All files copied successfully.');
			} catch (error) {
				logger.error(`Error occurred while copying files: ${error}`);
			}

			options.binPath = () => targetDir;
		}
		url = await ngrok.connect(options);
		logger.info(`Ngrok ready at ${url}`);
	} else process.exit(1); // Won't happen

	try {
		const {data} = await axios({
			method: 'post',
			url: new URL('/api/hosts/add', globals.API_URL).toString(),
			data: {
				url,
				name: config.options.name,
			},
			headers: {
				Authorization: config.options.apiToken,
			},
		});
		id = data.id;
	} catch (err) {
		logger.error(`Error validating key: ${err}`);
		process.exit(1);
	}

	// Start the server
	Server.get();

	// Create the default config
	if (!fs.existsSync(globals.DEFAULT_CONFIG_FILE)) {
		const defaultConfig = new BotConfig(globals.DEFAULT_CONFIG_FILE);
		await defaultConfig.save();
	}

	// Load existing accounts
	const files = (await fs.promises.readdir(globals.ACCOUNTS_DIR, {withFileTypes: true})).filter((d) => d.isFile());
	for (const file of files) {
		await Server.get().addAccount(file.name);
	}

	await AppDataSource.initialize();
	await AppDataSource.runMigrations();
}

main();

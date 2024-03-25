import inquirer from 'inquirer';
import {getArgValue} from '../shared/utils';
import fs from 'fs';
import {globals} from '../shared/globals';
import logger from '../shared/logger';
import net from 'net';
import {shutdown} from '.';

type ConfigOptions = {
	name: string;
	apiToken: string;
	port: number;
	password: string;
	host: 'ngrok' | 'localhost' | 'public_ip' | 'LAN';
	ngrokToken?: string;
};

export default class Config {
	private static instance: Config;

	public static get() {
		if (!Config.instance) {
			Config.instance = new Config();
		}
		return Config.instance;
	}

	public static option<T extends keyof ConfigOptions>(option: T): ConfigOptions[T] {
		return Config.get().options[option];
	}

	options: ConfigOptions;

	private constructor() {
		const options = {
			apiToken: getArgValue(['apiToken', 'token']),
			port: Number(getArgValue(['port', 'p'])) || undefined,
			password: getArgValue(['password', 'pass', 'auth']),
			host: getArgValue(['host', 'h']),
			name: getArgValue(['name', 'n']),
			ngrokToken: getArgValue(['ngrokToken', 'ngrok']),
		};

		// Load from file
		if (fs.existsSync(globals.MAIN_CONFIG_FILE)) {
			try {
				const file = fs.readFileSync(globals.MAIN_CONFIG_FILE);
				const json = JSON.parse(file.toString());

				options.apiToken ??= json.apiToken;
				options.port ??= Number(json.port);
				options.password ??= json.password;
				options.host ??= json.host;
				options.ngrokToken ??= json.ngrokToken;
				options.name ??= json.name;
			} catch (e) {
				logger.error(`Error loading main config file: ${e}`);
			}
		}
		this.options = options as ConfigOptions;
	}

	public async prompt() {
		const dontQuery = getArgValue(['dontQuery', 'q', 'noQuery', 'nq'], 'true');
		if (!dontQuery) {
			await inquirer
				.prompt([
					{
						type: 'input',
						name: 'apiToken',
						message: 'Enter your API token',
						default: this.options.apiToken,
					},
					{
						type: 'input',
						name: 'port',
						message: 'Choose a port',
						default: this.options.port || 3000,
						validate: async (input) => {
							const number = Number(input);
							if (!input || isNaN(number) || 0 > number || number > 65536) return 'Port numbers range from 0 to 65536';
							const isInUse = await isPortInUse(number);
							if (isInUse) return 'Port is already in use';
							return true;
						},
					},
					{
						type: 'list',
						name: 'host',
						message: 'Choose one of the following',
						choices: [
							{
								name: 'Use Ngrok tunnelling',
								value: 'ngrok',
							},
							{
								name: 'Localhost',
								value: 'localhost',
							},
							{
								name: 'LAN',
								value: 'LAN',
							},
							{
								name: 'Use public IP (needs port forwarding)',
								value: 'public_ip',
							},
						],
						default: this.options.host,
					},
					{
						type: 'input',
						name: 'ngrok',
						message: 'Enter your Ngrok Token',
						when: (answers) => answers.host === 'ngrok',
						suffix: ' (https://dashboard.ngrok.com/get-started/your-authtoken)',
						default: this.options.ngrokToken,
					},
					{
						type: 'password',
						mask: '*',
						name: 'password',
						message: 'Enter a password to restrict access',
						validate: (input: string) => {
							if (input.length < 8) return 'Password must be at least 8 characters long';
							return true;
						},
						default: this.options.password,
					},
					{
						type: 'input',
						mask: '*',
						name: 'name',
						message: 'Enter a name to identify this instance',
						default: this.options.name,
					},
				])
				.then((answers) => {
					this.options.apiToken = answers.apiToken;
					this.options.port = Number(answers.port);
					this.options.host = answers.host;
					this.options.ngrokToken = answers.ngrok;
					this.options.password = answers.password;
					this.options.name = answers.name;
				});
		}

		let isValid = true;
		const required = ['apiToken', 'port', 'password', 'host', 'name'] as const;
		required.forEach((key) => {
			if (this.options[key] === undefined) {
				logger.error(`${key} is required but missing`);
				isValid = false;
			}
		});

		if (isNaN(this.options.port)) {
			logger.error('Port must be a number');
			isValid = false;
		}

		if (this.options.port < 0 || this.options.port >= 65536) {
			logger.error('Port numbers range from 0 to 65536');
			isValid = false;
		}

		if (this.options.host === 'ngrok' && !this.options.ngrokToken) {
			logger.error(`Failed to load main config`);
			isValid = false;
		}

		if (!isValid) await shutdown(1);
	}

	public static save() {
		Config.get().save();
	}
	public save() {
		fs.writeFileSync(globals.MAIN_CONFIG_FILE, JSON.stringify(this.options));
	}
	public static setPassword(password: string) {
		Config.get().options.password = password;
		Config.save();
	}

	public static setApiKey(apiKey: string) {
		Config.get().options.apiToken = apiKey;
		Config.save();
	}
}
const isPortInUse = (port: number) =>
	new Promise((resolve) => {
		const server = net
			.createServer()
			.once('error', () => resolve(true))
			.once('listening', () => {
				server.once('close', () => resolve(false)).close();
			})

			.listen(port);
	});

import inquirer from "inquirer";
import { getArgValue, getFreePort } from "../shared/utils";
import fs from "fs";
import { globals } from "../shared/globals";
import logger from "../shared/logger";
import net from "net";
import { shutdown } from ".";

type ConfigOptions = {
	botPath: string;
	name: string;
	apiToken: string;
	port: number;
	password: string;
	host: "ngrok" | "localhost" | "WAN" | "LAN";
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

	public static option<T extends keyof ConfigOptions>(
		option: T
	): ConfigOptions[T] {
		return Config.get().options[option];
	}

	options: ConfigOptions;

	private constructor() {
		const options = {
			apiToken: getArgValue([
				"apiToken",
				"token",
				"api-token",
				"apiKey",
				"key",
				"api-key",
			]),
			port: Number(getArgValue(["port", "p"])) || undefined,
			password: getArgValue(["password", "pass", "auth", "pw"]),
			host: getArgValue(["host", "h"]),
			name: getArgValue(["name", "n"]),
			ngrokToken: getArgValue(["ngrokToken", "ngrok", "ngrok-token"]),
			botPath: getArgValue(["bot", "b"]),
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
		const dontQuery = getArgValue(["dontQuery", "q", "noQuery", "nq"], "true");
		if (!dontQuery) {
			await inquirer
				.prompt([
					{
						type: "input",
						name: "apiToken",
						message: "Enter your API token",
						default: this.options.apiToken,
					},
					{
						type: "input",
						name: "port",
						message: "Choose a port",
						default: this.options.port || 3000,
						validate: async (input) => {
							const number = Number(input);
							if (!input || isNaN(number) || 0 > number || number > 65536)
								return "Port numbers range from 0 to 65536";
							const isInUse = await isPortInUse(number);
							if (isInUse) return "Port is already in use";
							return true;
						},
					},
					{
						type: "input",
						name: "botPath",
						message: "Enter the path to the bot binary",
						validate: (input: string) => {
							return fs.existsSync(input) || "Invalid path";
						},
						default: this.options.botPath,
					},
					{
						type: "list",
						name: "host",
						message: "Choose one of the following",
						choices: [
							{
								name: "Use Ngrok tunnelling",
								value: "ngrok",
							},
							{
								name: "Localhost",
								value: "localhost",
							},
							{
								name: "Use local IP (available on LAN only)",
								value: "LAN",
							},
							{
								name: "Use public IP (needs port forwarding)",
								value: "WAN",
							},
						],
						default: this.options.host,
					},
					{
						type: "input",
						name: "ngrok",
						message: "Enter your Ngrok Token",
						when: (answers) => answers.host === "ngrok",
						suffix: " (https://dashboard.ngrok.com/get-started/your-authtoken)",
						default: this.options.ngrokToken,
					},
					{
						type: "password",
						mask: "*",
						name: "password",
						message: "Enter a password to restrict access",
						validate: (input: string) => {
							return (
								input.length < 8 ||
								"Password must be at least 8 characters long"
							);
						},
						default: this.options.password,
					},
					{
						type: "input",
						mask: "*",
						name: "name",
						message: "Enter a name to identify this instance",
						default: this.options.name,
					},
				])
				.then((answers) => {
					this.options = {
						botPath: answers.botPath,
						apiToken: answers.apiToken,
						port: Number(answers.port),
						host: answers.host,
						ngrokToken: answers.ngrok,
						password: answers.password,
						name: answers.name,
					};
				});
		}

		let isValid = true;
		const required = ["apiToken", "password", "host", "name"] as const;
		required.forEach((key) => {
			if (this.options[key] === undefined) {
				logger.error(`'${key}' is required but missing`);
				isValid = false;
			}
		});

		if (this.options.port === undefined) {
			this.options.port = await getFreePort();
		} else if (isNaN(this.options.port)) {
			logger.error("Port must be a number");
			isValid = false;
		}

		if (!globals.IS_IN_DEV) {
			if (this.options["botPath"] === undefined) {
				logger.error(`'botPath' is required but missing`);
				isValid = false;
			} else if (!fs.existsSync(this.options.botPath)) {
				logger.error("Provided bot binary does not exist");
				isValid = false;
			}
		}

		if (this.options.port < 0 || this.options.port >= 65536) {
			logger.error("Port numbers range from 0 to 65536");
			isValid = false;
		}

		if (this.options.host === "ngrok" && !this.options.ngrokToken) {
			logger.error(`'ngrokToken' is required when host is 'ngrok'`);
			isValid = false;
		}

		const validHosts = ["ngrok", "WAN", "LAN", "localhost"];
		if (!validHosts.includes(this.options.host)) {
			logger.error(
				`'host' must be one of ${validHosts.map((s) => `'${s}'`).join(", ")}`
			);
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
			.once("error", () => resolve(true))
			.once("listening", () => {
				server.once("close", () => resolve(false)).close();
			})

			.listen(port);
	});

import logger from "./logger";
import { DEFAULT_CONFIG_FILE, globals } from "./globals";
import { Authflow, Titles, ServerDeviceCodeResponse } from "prismarine-auth";
import { jsonc } from "jsonc";
import { ProxyConfig } from "./types";

export default class Account {
	email?: string;
	username?: string;
	config = DEFAULT_CONFIG_FILE;
	proxyConfig?: ProxyConfig;

	static async createAccount(
		email: string,
		config: string,
		codeCallback: (code: ServerDeviceCodeResponse) => void,
		proxyConfig?: ProxyConfig
	): Promise<string | null> {
		try {
			const authFlow = new Authflow(
				email,
				globals.ACCOUNT_CACHE_DIR(email),
				{
					authTitle: Titles.MinecraftNintendoSwitch,
					deviceType: "Nintendo",
					flow: "live",
				},
				codeCallback
			);
			const { profile } = await authFlow.getMinecraftJavaToken({
				fetchProfile: true,
			});
			if (!profile) throw new Error(`Logging in timed out for ${email}`);

			const data = {
				email,
				username: profile.name,
				config,
				uuid: profile.id,
				proxyConfig,
			};
			await jsonc.write(globals.ACCOUNT_FILE(profile.id), data, {
				space: "\t",
			});

			return profile.id;
		} catch (err) {
			logger.error(`Error creating account for ${email}: ${err}`);
		}
		return null;
	}

	constructor(public uuid: string) {}

	serialize() {
		return {
			uuid: this.uuid,
			email: this.email,
			username: this.username,
			config: this.config,
			proxyConfig: this.proxyConfig,
		};
	}

	async save() {
		try {
			await jsonc.write(globals.ACCOUNT_FILE(this.uuid), this.serialize(), {
				space: "\t",
			});
		} catch (err) {
			logger.error(`Error saving account ${this.username}: ${err}`);
		}
		return this;
	}

	async load() {
		try {
			const data = await jsonc.read(globals.ACCOUNT_FILE(this.uuid));
			this.email = data.email;
			this.username = data.username;
			this.config = data.config ?? globals.DEFAULT_CONFIG_FILE;
			this.proxyConfig = data.proxyConfig;
		} catch (err) {
			logger.error(`Error loading account ${this.uuid}: ${err}`);
		}
		return this;
	}
}

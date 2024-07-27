import { mkdir } from "fs";
import path from "path";
import logger from "./logger";
import { randomUUID } from "crypto";
import * as allGlobals from "./globals";
import getAppDataPath from "appdata-path";
import { getArgValue } from "./utils";
import { type } from "os";

declare global {
	namespace NodeJS {
		interface Process {
			pkg?: unknown;
		}
	}
}

export const RELEASES_URL =
	"https://api.github.com/repos/FryingGorilla/suspicious-stew/releases/";
export const LATEST_RELEASE_URL = RELEASES_URL + "latest";
export const IS_WINDOWS = type() === "Windows_NT";
export const IS_IN_DEV =
	process.pkg === undefined && process.env.NODE_ENV !== "production";
export const API_URL =
	(IS_IN_DEV && getArgValue("api", "http://localhost:8080")) ||
	"https://stew-api.vercel.app";

export const BASE_DIR = getAppDataPath("suspicious-stew");
export const CONFIGS_DIR = path.join(BASE_DIR, "configs");
export const CACHE_DIR = path.join(BASE_DIR, "cache");
export const LOGS_DIR = path.join(BASE_DIR, "logs");
export const ACCOUNTS_DIR = path.join(BASE_DIR, "accounts");
export const BIN_DIR = path.resolve(BASE_DIR, "bin");

export const createFolders = () =>
	[BASE_DIR, CONFIGS_DIR, CACHE_DIR, LOGS_DIR, ACCOUNTS_DIR, BIN_DIR].forEach(
		(dir) => {
			mkdir(dir, { recursive: true }, (err) => {
				if (err) logger.error(`Error creating directory: ${dir} ${err}`);
			});
		}
	);

export const DB_FILE = path.join(BASE_DIR, "database.sqlite");
export const MAIN_CONFIG_FILE = path.join(BASE_DIR, "config.json");

export const ACCOUNT_CACHE_DIR = (uuid: string) => path.join(CACHE_DIR, uuid);
export const ACCOUNT_LIMIT_CACHE = (uuid: string) =>
	path.join(ACCOUNT_CACHE_DIR(uuid), "limits.json");

export const ACCOUNT_FILE = (uuid: string) => path.join(ACCOUNTS_DIR, uuid);
export const DEFAULT_CONFIG_FILE = path.join(CONFIGS_DIR, "default");
export const CONFIG_FILE = (name: string) => {
	let sanitized = name.replace(/[^\w\d\-_.]/g, "_");

	if (!sanitized.trim()) {
		sanitized = "untitled";
	}

	sanitized += "_" + randomUUID();

	return path.join(CONFIGS_DIR, sanitized);
};

export const PROMISE_TIMEOUT = 5_000;

export const globals = allGlobals;

import axios from "axios";
import path from "path";
import fs from "fs";
import { BIN_DIR, RELEASES_URL, globals } from "../shared/globals";
import logger from "../shared/logger";
import EventEmitter from "events";
import { execSync, spawn } from "child_process";
import crypto from "crypto";
import { execArgv } from "process";
import { shutdown } from ".";

export const getBotBinaryPath = () => botBinaryPath;
let botBinaryPath = "";
const getSuffix = () => {
	if (process.platform === "win32") return "win.exe";
	if (process.platform === "darwin") return "macos";
	return "linux";
};

export async function checkForUpdates() {
	const { path: mainPath, existing } = await downloadLatest(
		new RegExp(`^suspicious-stew-\\d+.\\d+.\\d+-${getSuffix()}$`)
	);
	if (!existing) {
		logger.info("Starting newer version...");
		const process = spawn(mainPath, execArgv, {
			detached: true,
			stdio: "inherit",
		});
		await shutdown();
	}
}

async function downloadBotBinary(forceDownload?: boolean) {
	botBinaryPath = (
		await downloadLatest(
			new RegExp(`^bot-\\d+.\\d+.\\d+-${getSuffix()}$`),
			forceDownload
		)
	).path;
}

async function downloadMain() {
	return await downloadLatest(
		new RegExp(`^suspicious-stew-\\d+.\\d+.\\d+-${getSuffix()}$`)
	);
}

function calculateSHA256(filePath: string) {
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath);

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

const downloads: Record<string, { download: Promise<string>; url: string }> =
	{};
const downloadExecutable = async (url: string, filename: string) => {
	if (downloads[filename]) return downloads[filename].download;
	logger.info(`Downloading ${filename} from ${url}`);

	const emitter = new EventEmitter();
	downloads[filename] = {
		download: new Promise((resolve, reject) => {
			const downloadedListener = (fullPath: string) => {
				emitter.removeListener("error", errorListener);
				resolve(fullPath);
			};
			const errorListener = (err: unknown) => {
				emitter.removeListener("downloaded", downloadedListener);
				reject(err);
			};
			emitter.once("downloaded", downloadedListener);
			emitter.once("error", errorListener);
		}),
		url,
	};

	let writer: fs.WriteStream | undefined = undefined;
	try {
		const response = await axios({ url, responseType: "stream" });
		const fullPath = path.join(BIN_DIR, filename);
		await fs.promises.mkdir(BIN_DIR, { recursive: true });

		writer = fs.createWriteStream(fullPath);
		response.data.pipe(writer);

		await new Promise((resolve, reject) => {
			writer?.on("finish", resolve);
			writer?.on("error", reject);
		});
		if (!globals.IS_WINDOWS) {
			execSync(`chmod +x ${fullPath}`);
		}
		emitter.emit("downloaded", fullPath);
		return fullPath;
	} catch (err) {
		emitter.emit("error", new Error(`Download from ${url} failed: ${err}`));
		throw new Error(`Download from ${url} failed: ${err}`);
	} finally {
		logger.info("Download finished");
		if (writer && !writer.closed) writer.close();
		delete downloads[filename];
	}
};

const downloadLatest = async (
	nameRegex: RegExp,
	forceDownload?: boolean
): Promise<{ path: string; existing: boolean }> => {
	logger.debug("Finding latest asset matching " + nameRegex);

	let asset, sumAsset;
	try {
		const { data } = await axios({ url: RELEASES_URL, responseType: "json" });
		asset = data?.assets?.find((a: { name: string }) => nameRegex.test(a.name));
		sumAsset = data?.assets.find(
			({ name }: { name: string }) => name === "sha256sum.txt"
		);
	} catch (err) {
		throw new Error(`Failed to get latest release: ${err}`);
	}
	if (!asset) throw new Error(`No matching asset found for ${nameRegex}`);

	await fs.promises.mkdir(BIN_DIR, { recursive: true });
	if (!forceDownload) {
		if (!sumAsset) throw new Error(`No matching asset found for sha256sum.txt`);
		const sha256sum = JSON.parse(sumAsset);
		if (!(asset.name in sha256sum))
			throw new Error(`No sha256 sum found for ${asset.name}`);
		const files = await fs.promises.readdir(BIN_DIR, {
			withFileTypes: true,
		});
		const current = files
			.filter((dirent) => dirent.isFile())
			.find((f) => f.name === asset.name);
		if (current?.name) {
			try {
				const currentPath = path.join(BIN_DIR, current.name);
				if ((await calculateSHA256(currentPath)) === sha256sum[asset.name])
					return { path: currentPath, existing: true };
			} catch (err) {
				logger.error(`Failed to read ${current.name}.id: ${err}`);
			}
		} else {
			const possibleDev = files
				.map((f) => ({ file: f, ver: Number(f.name.replaceAll(/[^\d]/g, "")) }))
				.sort((a, b) => {
					if (!a.ver) return 1;
					if (!b.ver) return -1;

					return b.ver - a.ver;
				})[0];
			if (
				possibleDev.ver &&
				possibleDev.ver > Number(asset.name.replaceAll(/[^\d]/g, ""))
			) {
				logger.info("We are in the future!");
				return {
					path: path.join(BIN_DIR, possibleDev.file.name),
					existing: true,
				};
			}
		}
	}
	return {
		path: await downloadExecutable(asset.browser_download_url, asset.name),
		existing: false,
	};
};

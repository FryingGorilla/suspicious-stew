import axios from "axios";
import logger from "../shared/logger";
import crypto from "crypto";
import fs from "fs";
import {
	BIN_DIR,
	globals,
	LATEST_RELEASE_URL,
	RELEASES_URL,
} from "../shared/globals";
import { Stream } from "stream";
import { getArgValue } from "../shared/utils";
import path from "path";
import { execSync, spawn } from "child_process";

type Asset = {
	name: string;
	browser_download_url: string;
};

async function main() {
	// Use [--tag tag] <app args>

	// Get latest release hash
	// Compare hashes
	// Download latest release if necessary
	// Launch latest release

	logger.setDir("launcher");
	globals.createFolders();

	const tag = getArgValue("tag");

	const { data } = await axios<{ assets: Asset[] }>({
		url: tag ? RELEASES_URL + "tags/" + tag : LATEST_RELEASE_URL,
		responseType: "json",
	}).catch((err) => {
		logger.error(`Failed to get release data for ${tag ?? "latest"} release`);
		process.exit(1);
	});

	const mainRegex = new RegExp(
		`^suspicious-stew-\\d+.\\d+.\\d+-${getSuffix()}$`
	);
	const botRegex = new RegExp(`^bot-\\d+.\\d+.\\d+-${getSuffix()}$`);

	const mainAsset = data.assets.find(({ name }) => mainRegex.test(name));
	const botAsset = data.assets.find(({ name }) => botRegex.test(name));
	const hashesAsset = data.assets.find(({ name }) => name === "sha256sum.json");

	if (!mainAsset || !botAsset) {
		logger.error("Latest release does not contain all necessary assets");
		process.exit(1);
	}

	const hashes: Record<string, string> | null = hashesAsset
		? JSON.parse(
				await streamToString(
					(
						await axios<Stream>({
							url: hashesAsset.browser_download_url,
							responseType: "stream",
						})
					).data
				)
		  )
		: null;

	const mainPath =
		(hashes &&
			(await findAssetPath(BIN_DIR, mainAsset.name, hashes[mainAsset.name]))) ??
		(await downloadExecutable(
			mainAsset.browser_download_url,
			mainAsset.name,
			hashes && hashes[mainAsset.name],
			BIN_DIR
		));
	const botPath =
		(hashes &&
			(await findAssetPath(BIN_DIR, botAsset.name, hashes[botAsset.name]))) ??
		(await downloadExecutable(
			botAsset.browser_download_url,
			botAsset.name,
			hashes && hashes[botAsset.name],
			BIN_DIR
		));

	const args = [...process.argv.slice(tag ? 3 : 2), "--bot", botPath];
	const child = spawn(mainPath, args, {
		stdio: "inherit",
	});
	child.on("exit", (code) => logger.info(`Process exited with code ${code}`));
}

const downloadExecutable = async (
	url: string,
	filename: string,
	hash: string | null,
	directory: string
) => {
	logger.info(`Downloading ${filename} from ${url}`);
	let writer: fs.WriteStream | undefined = undefined;
	try {
		const response = await axios({ url, responseType: "stream" });
		const fullPath = path.join(directory, filename);
		await fs.promises.mkdir(directory, { recursive: true });

		writer = fs.createWriteStream(fullPath);
		response.data.pipe(writer);

		await new Promise((resolve, reject) => {
			writer?.on("finish", resolve);
			writer?.on("error", reject);
		});
		if (!globals.IS_WINDOWS) {
			execSync(`chmod +x ${fullPath}`);
		}
		await new Promise<void>((res, rej) =>
			writer?.close((err) => (err ? rej(err) : res()))
		);

		if (
			hash &&
			(await calculateSHA256(path.join(directory, filename))) !== hash
		) {
			logger.error("Download got corrupted, redownloading...");
			await downloadExecutable(url, filename, hash, directory);
		} else logger.info("Download finished");
		return fullPath;
	} catch (err) {
		throw new Error(`Download from ${url} failed: ${err}`);
	} finally {
		if (writer && !writer.closed) writer.close();
	}
};

const getSuffix = () => {
	if (process.platform === "win32") return "win.exe";
	if (process.platform === "darwin") return "macos";
	return "linux";
};

async function findAssetPath(dir: string, name: string, hash: string) {
	const files = await fs.promises.readdir(dir, { withFileTypes: true });

	for (const file of files) {
		if (file.name !== name || !file.isFile()) continue;
		const fullPath = path.join(dir, file.name);
		if (hash === (await calculateSHA256(fullPath))) return fullPath;
	}
}

function streamToString(stream: Stream) {
	const chunks: Buffer[] = [];
	return new Promise<string>((resolve, reject) => {
		stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		stream.on("error", (err) => reject(err));
		stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

function calculateSHA256(filePath: string) {
	logger.debug("Calculating sha255 for " + filePath);
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath);

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

main();

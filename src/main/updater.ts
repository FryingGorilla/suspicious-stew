import axios from "axios";
import path from "path";
import fs from "fs";
import { BIN_DIR, IS_IN_DEV, RELEASES_URL, globals } from "../shared/globals";
import logger from "../shared/logger";
import { execSync, spawn } from "child_process";
import crypto from "crypto";
import { shutdown } from ".";
import { Stream } from "stream";

export const getBotBinaryPath = () => botBinaryPath;
let botBinaryPath = "";
const getSuffix = () => {
	if (process.platform === "win32") return "win.exe";
	if (process.platform === "darwin") return "macos";
	return "linux";
};

export async function checkForUpdates() {
	const { path: mainPath, existing } = await downloadLatest(
		new RegExp(`^suspicious-stew-\\d+.\\d+.\\d+-${getSuffix()}(.\\d+)?$`),
		false,
		IS_IN_DEV ? BIN_DIR : path.parse(process.execPath).dir
	);
	if (!existing) {
		logger.info("Starting newer version...");
		const p = spawn(mainPath, process.argv.slice(2), {
			detached: true,
			stdio: "inherit",
		});
		p.unref();
		if (!IS_IN_DEV) fs.rmSync(process.execPath);
		await shutdown();
	}
	botBinaryPath = (
		await downloadLatest(
			new RegExp(`^bot-\\d+.\\d+.\\d+-${getSuffix()}(.\\d+)?$`)
		)
	).path;
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

const downloadExecutable = async (
	url: string,
	filename: string,
	sha256: string,
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

		logger.info("Download finished");
		if ((await calculateSHA256(path.join(directory, filename))) !== sha256) {
			logger.error("Download got corrupted, redownloading...");
			await downloadExecutable(url, filename, sha256, directory);
		}
		return fullPath;
	} catch (err) {
		throw new Error(`Download from ${url} failed: ${err}`);
	} finally {
		if (writer && !writer.closed) writer.close();
	}
};

function streamToString(stream: Stream) {
	const chunks: Buffer[] = [];
	return new Promise<string>((resolve, reject) => {
		stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		stream.on("error", (err) => reject(err));
		stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

type Asset = {
	name: string;
	browser_download_url: string;
};
const downloadLatest = async (
	nameRegex: RegExp,
	forceDownload?: boolean,
	directory = BIN_DIR
): Promise<{ path: string; existing: boolean }> => {
	logger.debug("Finding latest asset matching " + nameRegex);

	let asset: Asset | undefined, sumAsset: Asset | undefined;
	try {
		const { data } = await axios<{ assets: Asset[] }>({
			url: RELEASES_URL,
			responseType: "json",
		});
		asset = data?.assets?.find((a) => nameRegex.test(a.name));
		sumAsset = data?.assets.find(({ name }) => name === "sha256sum.txt");
	} catch (err) {
		throw new Error(`Failed to get latest release: ${err}`);
	}
	if (!asset) throw new Error(`No matching asset found for ${nameRegex}`);
	if (!sumAsset) throw new Error(`No matching asset found for sha256sum.txt`);
	const sha256sum = JSON.parse(
		await streamToString(
			(
				await axios<Stream>({
					url: sumAsset.browser_download_url,
					responseType: "stream",
				})
			).data
		)
	);
	if (!(asset.name in sha256sum))
		throw new Error(`No sha256 sum found for ${asset.name}`);

	const getVer = (file: string) =>
		Number(
			// remove suffix
			(file.match(/(\.\d+)$/)
				? file.split(".").slice(0, -1).join(".")
				: file
			).replaceAll(/[^\d]/g, "")
		);
	const getSuffix = (file: string) => Number(file.match(/-(\d+)$/)?.[1]) || 0;

	if (!forceDownload) {
		const files = await fs.promises.readdir(directory, {
			withFileTypes: true,
		});
		const current = files
			.filter((dirent) => dirent.isFile())
			.filter((f) => new RegExp(`^${asset?.name}(-\\d+)?$`).test(f.name))
			.sort((a, b) => getSuffix(b.name) - getSuffix(a.name))
			.at(0);
		if (current?.name) {
			const currentPath = path.join(directory, current.name);
			if ((await calculateSHA256(currentPath)) === sha256sum[asset?.name])
				return { path: currentPath, existing: true };
			else {
				return {
					path: await downloadExecutable(
						asset?.browser_download_url,
						asset?.name + "-" + (getSuffix(current.name) + 1),
						sha256sum[asset?.name],
						directory
					),
					existing: false,
				};
			}
		} else {
			const possibleDev = files
				.map((f) => ({ file: f, ver: getVer(f.name) }))
				.sort((a, b) => {
					if (!a.ver) return 1;
					if (!b.ver) return -1;
					return b.ver - a.ver;
				})
				.at(0);
			if (possibleDev?.ver && possibleDev.ver > getVer(asset?.name)) {
				logger.info("We are in the future! (" + possibleDev.ver + ")");
				return {
					path: path.join(directory, possibleDev.file.name),
					existing: true,
				};
			}
		}
	}
	return {
		path: await downloadExecutable(
			asset.browser_download_url,
			asset.name,
			sha256sum[asset?.name],
			directory
		),
		existing: false,
	};
};

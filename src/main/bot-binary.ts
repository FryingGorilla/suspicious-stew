import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {BIN_DIR, RELEASES_URL} from '../shared/globals';
import logger from '../shared/logger';

export async function getBotBinary(): Promise<string> {
	const getSuffix = () => {
		if (process.platform === 'win32') return 'win.exe';
		if (process.platform === 'darwin') return 'macos';
		return 'linux';
	};
	return downloadLatest(new RegExp(`bot-\\d+.\\d+.\\d+-${getSuffix()}`));
}

const downloadExecutable = async (url: string, filename: string) => {
	logger.info(`Downloading ${filename} from ${url}`);
	try {
		const response = await axios({url, responseType: 'stream'});
		const fullPath = path.join(BIN_DIR, filename);
		await fs.promises.mkdir(BIN_DIR, {recursive: true});

		const writer = fs.createWriteStream(fullPath);
		response.data.pipe(writer);

		await new Promise((resolve, reject) => {
			writer.on('finish', resolve);
			writer.on('error', reject);
		});
		return fullPath;
	} catch (err) {
		throw new Error(`Download from ${url} failed: ${err}`);
	}
};

const downloadLatest = async (nameRegex: RegExp) => {
	logger.debug('Downloading latest asset matching ' + nameRegex);

	let asset;
	try {
		const {data} = await axios({url: RELEASES_URL, responseType: 'json'});
		asset = data?.assets?.find((a: {name: string}) => nameRegex.test(a.name));
	} catch (err) {
		throw new Error(`Failed to get latest release: ${err}`);
	}

	await fs.promises.mkdir(BIN_DIR, {recursive: true});
	const current = (
		await fs.promises.readdir(BIN_DIR, {
			withFileTypes: true,
		})
	)
		.filter((dirent) => dirent.isFile())
		.find((dirent) => nameRegex.test(dirent.name));

	if (!current && !asset) throw new Error(`No matching asset found for ${nameRegex}`);
	if (current && current.name === asset.name) return path.join(BIN_DIR, current.name);
	return downloadExecutable(asset.browser_download_url, asset.name);
};

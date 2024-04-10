import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {BIN_DIR, RELEASES_URL} from '../shared/globals';
import logger from '../shared/logger';
import EventEmitter from 'events';

export async function getBotBinary(forceDownload?: boolean): Promise<string> {
	const getSuffix = () => {
		if (process.platform === 'win32') return 'win.exe';
		if (process.platform === 'darwin') return 'macos';
		return 'linux';
	};
	return downloadLatest(new RegExp(`^bot-\\d+.\\d+.\\d+-${getSuffix()}$`), forceDownload);
}

const downloads: Record<string, {download: Promise<string>; url: string}> = {};
const downloadExecutable = async (url: string, filename: string) => {
	if (downloads[filename]) return downloads[filename].download;
	logger.info(`Downloading ${filename} from ${url}`);

	const emitter = new EventEmitter();
	downloads[filename] = {
		download: new Promise((resolve, reject) => {
			const downloadedListener = (fullPath: string) => {
				emitter.removeListener('error', errorListener);
				resolve(fullPath);
			};
			const errorListener = (err: unknown) => {
				emitter.removeListener('downloaded', downloadedListener);
				reject(err);
			};
			emitter.once('downloaded', downloadedListener);
			emitter.once('error', errorListener);
		}),
		url,
	};

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
		emitter.emit('downloaded', fullPath);
		return fullPath;
	} catch (err) {
		emitter.emit('error', new Error(`Download from ${url} failed: ${err}`));
		throw new Error(`Download from ${url} failed: ${err}`);
	} finally {
		logger.info('Download finished');
		delete downloads[filename];
	}
};

const downloadLatest = async (nameRegex: RegExp, forceDownload?: boolean) => {
	logger.debug('Downloading latest asset matching ' + nameRegex);

	let asset;
	try {
		const {data} = await axios({url: RELEASES_URL, responseType: 'json'});
		asset = data?.assets?.find((a: {name: string}) => nameRegex.test(a.name));
	} catch (err) {
		throw new Error(`Failed to get latest release: ${err}`);
	}

	if (!forceDownload) {
		await fs.promises.mkdir(BIN_DIR, {recursive: true});
		const current = (
			await fs.promises.readdir(BIN_DIR, {
				withFileTypes: true,
			})
		)
			.filter((dirent) => dirent.isFile())
			.find((dirent) => nameRegex.test(dirent.name));
		if (!current && !asset) throw new Error(`No matching asset found for ${nameRegex}`);
		if (current?.name) {
			try {
				const idPath = path.join(BIN_DIR, current.name + '.id');
				const currentId = await fs.promises.readFile(idPath, 'utf8');
				if (Number(currentId) === asset.id) return path.join(BIN_DIR, current.name);
			} catch (err) {
				logger.error(`Failed to read ${current.name}.id: ${err}`);
			}
		}
	}
	try {
		await fs.promises.writeFile(path.join(BIN_DIR, asset.name + '.id'), asset.id.toString());
	} catch (err) {
		logger.error(`Failed to write ${asset.name}.id: ${err}`);
	}
	return downloadExecutable(asset.browser_download_url, asset.name);
};

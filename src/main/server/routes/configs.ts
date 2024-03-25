import {Router} from 'express';
import {getConfigs} from '../../../shared/utils';
import BotConfig from '../../../shared/bot-config';
import fs from 'fs';
import {globals} from '../../../shared/globals';
import Server from '..';

const router = Router();

router.get('/', async (req, res) => {
	const configs = await getConfigs();
	res.json({message: 'OK', configs: configs.map((c) => c.serialize())});
});

router.get('/default', (req, res) => {
	res.json({message: 'OK', defaultConfig: new BotConfig().serialize()});
});

router.post('/save', async (req, res) => {
	const configObject = req.body;
	if (!configObject) {
		return res.status(400).json({error: 'No config provided'});
	}
	const {filepath} = configObject;
	if (!filepath) return res.status(400).json({error: 'No filepath provided'});
	if (typeof filepath !== 'string') return res.status(400).json({error: 'Filepath must be a string'});
	if (!filepath.includes(globals.CONFIGS_DIR))
		return res.status(400).json({error: 'Filepath must be in the configs directory'});
	try {
		const config = new BotConfig(filepath).loadFromObject(configObject);
		await config.save();

		Server.get()
			.getAccounts()
			.forEach(({account: {config}, process}) => {
				if (config === filepath || (!config && filepath === globals.DEFAULT_CONFIG_FILE)) {
					process.send({event: 'botManager::config::load'});
				}
			});

		return res.json({message: 'OK', config: config.serialize()});
	} catch (err) {
		return res.status(400).json({error: err});
	}
});

router.post('/delete', async (req, res) => {
	const {filepath} = req.body;
	if (!filepath) return res.status(400).json({error: 'No filepath provided'});
	if (typeof filepath !== 'string') return res.status(400).json({error: 'Filepath must be a string'});
	if (!filepath.includes(globals.CONFIGS_DIR))
		return res.status(400).json({error: 'Filepath must be in the configs directory'});
	if (!fs.existsSync(filepath)) return res.status(404).json({error: `File does not exist`});
	await new BotConfig(filepath).delete();
	return res.json({message: 'OK'});
});

export default router;

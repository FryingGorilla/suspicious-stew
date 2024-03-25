import express from 'express';
import Config from '../../main-config';
import {shutdown} from '../..';
import dbRouter from './db';
import configsRouter from './configs';
import accountsRouter from './accounts';

const router = express.Router();

router.get('/ping', (req, res) => {
	res.send('Pong');
});
router.post('/stop', (req, res) => {
	res.send('Shutting down...');
	shutdown();
});
router.post('/set_password', (req, res) => {
	if (!req.body.password) {
		return res.status(400).json({error: 'No password provided'});
	}
	if (req.body.password.length < 8) {
		return res.status(400).json({error: 'Password must be at least 8 characters long'});
	}

	Config.setPassword(req.body.password);
	res.json({message: 'OK'});
});
router.post('/set_api_key', (req, res) => {
	if (!req.body.api_key) {
		return res.status(400).json({error: 'No API key provided'});
	}
	if (!/^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(req.body.api_key)) {
		return res.status(400).json({error: 'Invalid API key'});
	}

	Config.setApiKey(req.body.api_key);
	res.json({message: 'OK'});
});

router.use('/db', dbRouter);
router.use('/configs', configsRouter);
router.use('/accounts', accountsRouter);

export default router;

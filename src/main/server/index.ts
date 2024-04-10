import express, {Request, Response} from 'express';
import socketIO, {Socket} from 'socket.io';
import logger from '../../shared/logger';
import path from 'path';
import cors from 'cors';
import router from './routes';
import compression from 'compression';
import {ChildEvents, ChildToMain} from '../../shared/types';
import {ExtendedError} from 'socket.io/dist/namespace';
import http from 'http';
import {IS_IN_DEV, globals} from '../../shared/globals';
import {ChildProcess, spawn} from 'child_process';
import {getBotBinary} from '../bot-binary';
import Config from '../main-config';
import {bazaarApi} from '../db/bazaar-api';
import Account from '../../shared/account';
import {AppDataSource} from '../db/data-source';
import {Notification} from '../db/entity/Notification';
import {ChatLog} from '../db/entity/ChatLog';
import fs from 'fs';
import {BotBehaviorMetrics} from '../db/entity/BotBehaviorMetrics';

export default class Server {
	private static instance: Server;

	static get() {
		if (!Server.instance) {
			Server.instance = new Server();
			Server.instance.start();
		}
		return Server.instance;
	}

	private accounts: {
		account: {email?: string; uuid: string; config?: string; username?: string};
		process: ChildProcess;
	}[] = [];
	private io: socketIO.Server;
	private httpServer: http.Server;
	private constructor() {
		const app = express();
		this.httpServer = http.createServer(app);

		this.io = new socketIO.Server(this.httpServer, {
			cors: {
				origin: '*',
			},
		});
		this.io.use(socketMiddleware(Config.option('password')));
		this.io.on('connection', (socket) => {
			logger.debug(`Socket ${socket.id} connected to main`);
			this.accounts.forEach(({process, account: {uuid}}) => {
				const listener = ({event, ...args}: {event: string}) => {
					socket.emit(event, {...args, uuid});
				};
				process.on('message', listener);
				socket.on('disconnect', () => {
					process.off('message', listener);
				});
				socket.onAny((event, ...args) => {
					this.accounts.forEach(({process}) => process.send({event, ...args[0]}));
				});
			});
		});

		app.use(cors());
		app.use(express.json());
		app.use(compression());

		app.use('/', (req, res, next) => {
			if (req.headers.authorization === Config.get().options.password) return next();
			return res.status(403).json({error: 'Invalid password'});
		});

		app.use('/api', router);

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		app.use((err: Error, req: Request, res: Response, _next: () => void): void => {
			logger.error(`An error occurred: ${err.stack}`);
			res.status(500).send('Something broke!');
		});
	}
	private bazaar = bazaarApi();
	private async start() {
		if (this.httpServer.listening) return;

		return Promise.all([
			new Promise<void>((resolve) => {
				this.httpServer.listen(Config.get().options.port, () => {
					logger.info(`HTTP server listening on http://localhost:${Config.get().options.port}`);
					resolve();
				});
			}),
			this.bazaar.start(),
		]);
	}

	public getAccounts() {
		return this.accounts;
	}

	public async addAccount(uuid: string) {
		const {io, accounts} = this;
		const command = IS_IN_DEV ? 'node' : await getBotBinary();
		if (!command) return;

		const args = ['--uuid', uuid];
		if (IS_IN_DEV)
			args.unshift(
				'--require',
				'ts-node/register',
				// '--expose-gc',
				// `--inspect=0.0.0.0:0`,
				path.join(__dirname, '../../bot/index.ts')
			);

		logger.debug(`Spawning process for ${uuid}: ${command} ${args.join(' ')}`);

		let child: ChildProcess;
		try {
			child = spawn(command, args, {stdio: ['inherit', 'inherit', 'inherit', 'ipc']});
		} catch (err) {
			logger.error(`Failed to spawn process for ${uuid}: ${err}`);
			if (IS_IN_DEV) return;
			child = spawn(await getBotBinary(true), args, {stdio: ['inherit', 'inherit', 'inherit', 'ipc']});
		}

		child.setMaxListeners(50);
		child.on('spawn', () => logger.debug(`Process for ${uuid} online`));
		child.on('exit', (err) => logger.debug(`Process for ${uuid} exited with code ${err}`));
		child.on('error', (err) => logger.error(`Process for ${uuid} errored: ${err}`));
		child.on('message', (mes) => {
			if (typeof mes !== 'object' || !('event' in mes) || typeof mes.event !== 'string') return;
			try {
				switch (mes.event as ChildEvents) {
					case 'manager-update': {
						const {data} = mes as ChildToMain<'manager-update'>;
						const {account} = accounts[index];
						account.config = data.configPath;
						account.username = data.username;
						account.email = data.email;
						break;
					}
					case 'behavior-metrics': {
						const {data, time} = mes as ChildToMain<'behavior-metrics'>;
						AppDataSource.manager.insert(BotBehaviorMetrics, {
							account_uuid: uuid,
							time,
							...data,
						});
						break;
					}
					case 'notification': {
						const {data, time} = mes as ChildToMain<'notification'>;
						const {level, title, message} = data;
						AppDataSource.manager.insert(Notification, {account_uuid: uuid, level, title, message, time});
						break;
					}
					case 'chat': {
						const {data, time} = mes as ChildToMain<'chat'>;
						const {message} = data;
						AppDataSource.manager.insert(ChatLog, {account_uuid: uuid, message, time});
						break;
					}
					case 'solve': {
						const {data, id} = mes as ChildToMain<'solve'>;
						this.bazaar.solve(data).then((val) => {
							child.send({event: 'solve', data: val, id});
						});
						break;
					}
					case 'get-products': {
						const {id} = mes as ChildToMain<'get-products'>;
						this.bazaar.getProducts().then((val) => {
							child.send({event: 'get-products', data: val, id});
						});
						break;
					}
				}
			} catch (err) {
				logger.error(String(err));
			}
		});

		const account = await new Account(uuid).load();
		const index = accounts.length;
		accounts.push({
			process: child,
			account: account.serialize(),
		});

		const namespace = io.of(uuid);
		namespace.use(socketMiddleware(Config.get().options.password));

		namespace.on('connection', (socket) => {
			logger.debug(`Socket ${socket.id} connected to ${uuid}`);

			socket.onAny((event, ...args) => {
				child.send({event, ...args[0]});
			});

			const listener = ({event, ...args}: {event: string}) => {
				socket.emit(event, args);
			};
			child.on('message', listener);

			socket.on('disconnect', () => {
				child.off('message', listener);
			});
		});
	}

	public async removeAccount(uuid: string) {
		const index = this.accounts.findIndex(({account}) => account.uuid === uuid);
		if (index === -1) return false;
		const {process} = this.accounts[index];
		process.kill();
		this.accounts.splice(index, 1);
		await fs.promises.rm(globals.ACCOUNT_FILE(uuid), {recursive: true});
		logger.debug(`Removed account ${uuid}`);
		return true;
	}
}

const socketMiddleware = (password: string) => (socket: Socket, next: (err?: ExtendedError | undefined) => void) => {
	socket.on('connection', () => {
		logger.debug(`Socket ${socket.id} connected`);
	});
	if (socket.handshake.auth.password === password) {
		next();
	} else {
		logger.debug('Connection failed: Unauthorized');
		next(new Error('Unauthorized'));
	}
};

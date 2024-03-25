import path from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import {globals} from './globals';

const logFormat = winston.format.printf(({level, message, timestamp}) => {
	return `[${timestamp}] ${level}: ${message}`;
});

const initializeLogger = (dir?: string) =>
	winston.createLogger({
		exitOnError: false,
		transports: [
			new winston.transports.Console({
				level: 'info',
				format: winston.format.combine(winston.format.cli()),
			}),
			new DailyRotateFile({
				format: winston.format.combine(
					winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
					logFormat,
					winston.format.uncolorize()
				),
				dirname: path.join(globals.LOGS_DIR, dir ?? 'main'),
				filename: '%DATE%.log',
				datePattern: 'YYYY-MM-DD',
				zippedArchive: true,
				maxSize: '20m',
				level: 'debug',
				maxFiles: '14d',
			}),
		],
	});

let winstonLogger = initializeLogger();

const logger = {
	setDir: (dir: string) => {
		winstonLogger = initializeLogger(dir);
		return winstonLogger;
	},
	log: (message?: string | string[], level?: string) => {
		if (Array.isArray(message)) {
			logger.log(undefined, level);
			message.forEach((e) => logger.log(e, level));
			logger.log(undefined, level);
		} else winstonLogger.log(level ?? 'debug', message ?? '==================================================');
	},
	info: (message?: string | string[]) => logger.log(message, 'info'),
	error: (message?: string | string[]) => logger.log(message, 'error'),
	debug: (message?: string | string[]) => {
		logger.log(message, 'debug');
	},
};

export default logger;

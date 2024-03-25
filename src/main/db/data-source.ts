import {DataSource} from 'typeorm';
import {globals} from '../../shared/globals';

export const AppDataSource = new DataSource({
	type: 'sqlite',
	database: globals.DB_FILE,
	entities: [__dirname + '/entity/**/*.{js,ts}'],
	logging: false,
	synchronize: true,
});

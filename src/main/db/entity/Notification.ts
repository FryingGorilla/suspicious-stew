import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity({name: 'notifications'})
export class Notification {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column()
	message!: string;

	@Column()
	level!: number;

	@Column()
	title!: string;

	@Column()
	time!: number;

	@Column()
	account_uuid!: string;
}

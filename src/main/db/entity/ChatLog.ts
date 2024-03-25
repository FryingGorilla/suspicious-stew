import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity({name: 'chat_logs'})
export class ChatLog {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column()
	time!: number;

	@Column()
	message!: string;

	@Column()
	account_uuid!: string;
}

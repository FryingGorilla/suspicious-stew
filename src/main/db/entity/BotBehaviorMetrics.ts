import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity('bot_behavior_metrics')
export class BotBehaviorMetrics {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column()
	time!: number;

	@Column()
	account_uuid!: string;

	@Column()
	config!: string;

	@Column()
	behavior_name!: string;

	@Column()
	behavior_state!: string;

	@Column()
	behavior_data!: string;
}

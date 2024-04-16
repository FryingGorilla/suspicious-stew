import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity('flipper_metrics')
export class Metrics {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column()
	time!: number;

	@Column()
	isInTimeout!: boolean;
	@Column()
	state!: string;
	@Column()
	activeActivity!: string;
	@Column()
	elapsedTime!: number;
	@Column()
	cycles!: number;
	@Column()
	totalWaitTime!: number;
	@Column()
	totalTimeout!: number;
	@Column()
	onlineMembers!: string;
	@Column()
	cookieBuffTime!: number;
	@Column({nullable: true})
	startingTotal!: number;
	@Column({nullable: true})
	startingUsedDailyLimit!: number;
	@Column({nullable: true})
	profit!: number;
	@Column({nullable: true})
	email!: string;
	@Column()
	uuid!: string;
	@Column({nullable: true})
	username!: string;
	@Column()
	configPath!: string;
	@Column()
	hasCookie!: boolean;
	@Column()
	onlineStatus!: string;
	@Column()
	location!: string;
	@Column()
	orders!: string;
	@Column()
	ordersWorth!: number;
	@Column()
	inventoryWorth!: number;
	@Column()
	spent!: number;
	@Column()
	total!: number;
	@Column()
	usedDailyLimit!: number;
}

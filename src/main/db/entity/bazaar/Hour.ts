import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity()
export class Hour {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column()
	item_id!: string;

	@Column('double')
	buy_price!: number;

	@Column('double')
	sell_price!: number;

	@Column()
	time!: number;
}

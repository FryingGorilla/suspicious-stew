import {Router} from 'express';
import {AppDataSource} from '../../db/data-source';
import {Notification} from '../../db/entity/Notification';
import {ChatLog} from '../../db/entity/ChatLog';

const router = Router();

router.get('/notifications', async (req, res) => {
	const {account_uuid} = req.query;
	if (!account_uuid) return res.status(400).json({error: 'No account_uuid provided'});
	const result = await AppDataSource.getRepository(Notification)
		.createQueryBuilder('notification')
		.where('notification.account_uuid = :account_uuid', {account_uuid})
		.orderBy('notification.time', 'DESC')
		.getMany();
	return res.json({message: 'OK', result});
});

router.post('/notifications/delete', async (req, res) => {
	const {ids} = req.body;
	if (!ids) return res.status(400).json({error: 'No ids provided'});
	const result = await AppDataSource.createQueryBuilder().delete().from(Notification).whereInIds(ids).execute();
	return res.json({message: 'OK', result});
});

router.get('/chat_logs', async (req, res) => {
	const {account_uuid, limit, offset} = req.query;
	if (!account_uuid) return res.status(400).json({error: 'No account_uuid provided'});
	const query = AppDataSource.getRepository(ChatLog)
		.createQueryBuilder('chat')
		.where('chat.account_uuid = :account_uuid', {account_uuid})
		.orderBy('chat.time', 'DESC');
	if (offset !== undefined) query.offset(Number(offset.toString()));
	if (limit !== undefined) query.limit(Number(limit.toString()));

	const result = await query.getMany();
	return res.json({message: 'OK', result});
});

router.post('/chat_logs/delete', async (req, res) => {
	const {ids} = req.body;
	if (!ids) return res.status(400).json({error: 'No ids provided'});
	const result = await AppDataSource.createQueryBuilder().delete().from(ChatLog).whereInIds(ids).execute();
	return res.json({message: 'OK', result});
});

export default router;

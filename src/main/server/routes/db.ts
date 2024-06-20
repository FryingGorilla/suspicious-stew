import { Router } from "express";
import { AppDataSource } from "../../db/data-source";
import { Notification } from "../../db/entity/Notification";
import { ChatLog } from "../../db/entity/ChatLog";
import { Metrics } from "../../db/entity/Metrics";

const router = Router();

router.get("/metrics", async (req, res) => {
	const { account_uuid, time_lb, time_ub } = req.query;

	const query = AppDataSource.getRepository(Metrics)
		.createQueryBuilder("data")
		.where("data.uuid = :account_uuid", { account_uuid })
		.orderBy("data.time", "DESC");
	if (time_lb !== undefined)
		query.andWhere("data.time >= :time_lb", { time_lb: Number(time_lb) });
	if (time_ub !== undefined)
		query.andWhere("data.time <= :time_ub", { time_ub: Number(time_ub) });

	const result = await query.getMany();

	return res.json({ message: "OK", result });
});

router.get("/notifications", async (req, res) => {
	const { account_uuid, limit, offset, sort } = req.query;
	if (!account_uuid)
		return res.status(400).json({ error: "No account_uuid provided" });

	const query = AppDataSource.getRepository(Notification)
		.createQueryBuilder("notification")
		.where("notification.account_uuid = :account_uuid", { account_uuid })
		.orderBy(
			sort?.toString().startsWith("level")
				? "notification.level"
				: "notification.time",
			sort?.toString().endsWith("asc") ? "ASC" : "DESC"
		);
	if (offset !== undefined) query.offset(Number(offset.toString()));
	if (limit !== undefined) query.limit(Number(limit.toString()));
	const result = await query.getMany();
	return res.json({ message: "OK", result });
});

router.post("/notifications/delete", async (req, res) => {
	const { ids } = req.body;
	if (!ids) return res.status(400).json({ error: "No ids provided" });
	const result = await AppDataSource.createQueryBuilder()
		.delete()
		.from(Notification)
		.whereInIds(ids)
		.execute();
	return res.json({ message: "OK", result });
});

router.get("/chat_logs", async (req, res) => {
	const { account_uuid, limit, offset } = req.query;
	if (!account_uuid)
		return res.status(400).json({ error: "No account_uuid provided" });
	const query = AppDataSource.getRepository(ChatLog)
		.createQueryBuilder("chat")
		.where("chat.account_uuid = :account_uuid", { account_uuid })
		.orderBy("chat.time", "DESC");
	if (offset !== undefined) query.offset(Number(offset.toString()));
	if (limit !== undefined) query.limit(Number(limit.toString()));

	const result = await query.getMany();
	return res.json({ message: "OK", result });
});

router.post("/chat_logs/delete", async (req, res) => {
	const { ids } = req.body;
	if (!ids) return res.status(400).json({ error: "No ids provided" });
	const result = await AppDataSource.createQueryBuilder()
		.delete()
		.from(ChatLog)
		.whereInIds(ids)
		.execute();
	return res.json({ message: "OK", result });
});

export default router;

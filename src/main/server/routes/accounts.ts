import { Router } from "express";
import Server from "..";
import Account from "../../../shared/account";
import logger from "../../../shared/logger";
import { AppDataSource } from "../../db/data-source";
import { Notification } from "../../db/entity/Notification";

const router = Router();

const mapAccounts = () =>
	Server.get()
		.getAccounts()
		.map(({ account }) => account);

router.get("/", (req, res) => {
	return res.json({ message: "OK", accounts: mapAccounts() });
});

router.post("/add", async (req, res) => {
	const { email, configPath, proxyConfig } = req.body;
	if (!email) return res.status(400).json({ error: "No email provided" });
	if (proxyConfig) proxyConfig.port = parseInt(proxyConfig.port);
	const uuid = await Account.createAccount(
		email,
		configPath,
		(codeRes) => {
			logger.info(codeRes.message);
			AppDataSource.manager.insert(Notification, {
				account_uuid: "unknown",
				level: 3,
				title: "First time sign in",
				message: `${codeRes.message} Please make sure to sign in using the correct email (${email})`,
				time: Date.now(),
			});
			if (!res.headersSent)
				res.status(202).json({ message: "OK", response: codeRes });
		},
		proxyConfig
	);
	if (uuid != null) await Server.get().addAccount(uuid);
	if (!res.headersSent)
		res
			.status(uuid != null ? 200 : 500)
			.json({ message: "OK", accounts: mapAccounts() });
});
router.post("/delete", async (req, res) => {
	const { uuid } = req.body;
	if (!uuid) return res.status(400).json({ error: "No uuid provided" });
	const result = await Server.get().removeAccount(uuid);
	if (!result) return res.status(404).json({ error: "Account not found" });

	res.json({ message: "OK", accounts: mapAccounts() });
});

router.post("/restart", async (req, res) => {
	const { uuid } = req.body;
	if (!uuid) return res.status(400).json({ error: "No uuid provided" });
	const result = await Server.get().restartProcess(uuid);
	if (!result) return res.status(404).json({ error: "Account not found" });
	res.json({ message: "OK", accounts: mapAccounts() });
});

export default router;

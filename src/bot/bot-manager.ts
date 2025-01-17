import { Bot, BotEvents, BotOptions, createBot } from "mineflayer";
import Account from "../shared/account";
import {
    ChildEvents,
    ChildToMain,
    Location,
    ManagerUpdateData,
    OnlineStatus,
    Persistent,
} from "../shared/types";
import {
    persistentActions,
    wait,
    waitForEvent,
    withTimeout,
} from "../shared/utils";
import logger from "../shared/logger";
import { createClient } from "minecraft-protocol";
import { ChatMessage } from "prismarine-chat";
import BotConfig from "../shared/bot-config";
import Bazaar from "./bazaar";
import { PROMISE_TIMEOUT, globals } from "../shared/globals";
import { Vec3 } from "vec3";
import { findItemSlot } from "./bot-utils";
import { SocksClient } from "socks";
import http from "http";
import { HttpProxyAgent } from "http-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export default class BotManager {
    onlineStatus: OnlineStatus = "offline";
    location: Location = "lobby";

    config: BotConfig;
    bot: Bot & Persistent<Bot>;
    applyPersistentActions: <T extends object>(target: T) => T & Persistent<T>;

    bazaar: Bazaar;
    hasCookie = true;

    shouldReconnect = false;
    spawnDelay = true;
    banned = false;

    constructor(public account: Account) {
        this.config = new BotConfig(account.config);
        const { apply } = persistentActions();
        this.applyPersistentActions = apply;

        const bot = createBot({
            client: createClient({
                username: "dummy",
                connect: () => null,
                closeTimeout: 2_147_483_647,
                version: "1.8.9",
            }),
        });
        this.bot = apply(bot);
        this.bot.on(
            "spawn",
            async () => {
                logger.debug(`Spawned in as ${this.bot.username}!`);
                this.account.username = this.bot.username;

                this.postNotification(
                    "Spawned in!",
                    `Spawned in as ${this.bot.username}`,
                    1
                );
                this.onlineStatus = "online";
                this.postUpdate();

                this.spawnDelay = true;
                await wait(8000); // Wait a bit before sending commands
                this.spawnDelay = false;

                await this.updateLocation();
            },
            { persistent: true }
        );
        this.bot.on(
            "message",
            async (message: ChatMessage, position: string) => {
                if (!message) return;
                if (position !== "chat") return;

                logger.debug(`[CHAT] ${message.toString()}`);
                this.postChatLog(message);

                const str = message.toString().trimStart();
                if (
                    str.startsWith("[Important] This server will restart soon")
                ) {
                    await this.sendChat("/evacuate");
                } else if (
                    str.startsWith(
                        "You need the Cookie Buff to use this feature!"
                    )
                ) {
                    logger.debug(
                        `Detected no cookie buff for ${this.account.username}`
                    );
                    this.hasCookie = false;
                } else if (str.startsWith("Please dont't spam the command")) {
                    this.lastMessageTime = Date.now() + 5000;
                }
            },
            { persistent: true }
        );
        this.bot.on(
            "error",
            (err: Error) => {
                logger.error(`Error from ${this.account.username}: ${err}`);
            },
            { persistent: true }
        );
        this.bot.on(
            "kicked",
            (reason?: string) => {
                logger.debug(`Kicked: ${reason}`);
                this.onlineStatus = "offline";
                if (JSON.stringify(reason).includes("banned")) {
                    this.postNotification(
                        "BANNED",
                        `Reason: ${reason ?? "No reason provided"}`,
                        3
                    );
                    this.banned = true;
                    this.disconnect();
                } else {
                    this.postNotification(
                        "Kicked",
                        `Kicked, reason: ${reason ?? "No reason provided"}`,
                        3
                    );
                }
                this.postUpdate();
            },
            { persistent: true }
        );
        this.bot.on(
            "end",
            (reason: string) => {
                this.spawnDelay = true;
                this.location = "lobby";
                logger.debug(`Connection ended: ${reason || "No reason"}`);
                this.onlineStatus = "offline";
                this.postUpdate();

                this.postNotification(
                    "Connection ended",
                    `Connection ended to hypixel.net, reason: ${
                        reason ?? "No reason provided"
                    }`,
                    1
                );

                if (this.shouldReconnect) {
                    const delay = 60 * 1000;
                    logger.debug(`Reconnecting in ${delay}ms`);

                    setTimeout(() => {
                        if (!this.shouldReconnect) return;
                        if (this.onlineStatus !== "offline") return;

                        logger.debug("Reconnecting...");
                        this.connect();
                    }, delay);
                }
            },
            { persistent: true }
        );

        this.bazaar = new Bazaar(this);
        const events = ["beforeExit", "SIGHUP", "SIGINT", "SIGTERM"];
        events.forEach((event) => {
            process.on(event, async () => {
                withTimeout(this.bazaar.saveLimit(), 5000)
                    .catch((err) => logger.error(err))
                    .finally(() => {
                        process.exit(0);
                    });
            });
        });
    }

    postEvent<Event extends ChildEvents>(
        event: Event,
        data: ChildToMain<Event>["data"]
    ) {
        // logger.debug(`Posting event ${event}`);
        const id = Date.now();
        const message: ChildToMain<Event> = {
            event,
            data,
            time: Date.now(),
            id,
        };
        process.send && process.send(message);
        return id;
    }

    async waitForReply<R, Event extends ChildEvents>(
        event: Event,
        data: ChildToMain<Event>["data"]
    ): Promise<R> {
        try {
            return await withTimeout(
                new Promise((resolve, reject) => {
                    if (process) {
                        const id = this.postEvent(event, data);
                        const listener = (message: unknown) => {
                            if (!message) return;
                            if (typeof message !== "object") return;
                            if (
                                !("event" in message) ||
                                message.event !== event
                            )
                                return;
                            if (!("id" in message) || message.id !== id) return;
                            if (!("data" in message)) return;

                            process.off("message", listener);
                            resolve(message.data as R);
                        };
                        process.on("message", listener);
                    } else reject(new Error("Process is not defined"));
                }),
                20_000
            );
        } catch (err) {
            throw new Error(`Failed to get reply from parent process: ${err}`);
        }
    }

    serialize(): ManagerUpdateData {
        return {
            ...this.account.serialize(),
            onlineStatus: this.onlineStatus,
            location: this.location,
            hasCookie: this.hasCookie,
            banned: this.banned,
        };
    }

    postUpdate() {
        this.postEvent("manager-update", this.serialize());
    }

    postNotification(title: string, message: string, level: 1 | 2 | 3) {
        this.postEvent("notification", { title, message, level });
    }

    postChatLog(message: ChatMessage) {
        this.postEvent("chat", {
            message: message.toAnsi(),
        });
    }

    getPurse(): number {
        const sidebarItems =
            this.bot.scoreboard?.sidebar?.items?.map((item) =>
                item.displayName.toString().replace(item.name, "")
            ) ?? [];

        for (const item of sidebarItems) {
            const match = /(Purse|Piggy): ([\d,\\.]+)/.exec(item);
            if (!match) continue;

            return Number(match[2].replaceAll(",", ""));
        }

        logger.debug(`Purse not found: ${sidebarItems.join(", ")}`);
        return 0;
    }

    getEmptyInventorySpace(): number {
        const { bot } = this;
        let count = 0;
        for (
            let i = bot.inventory.inventoryStart;
            i < bot.inventory.inventoryEnd;
            ++i
        ) {
            const slot = bot.inventory.slots[i];
            if (!slot) count++;
        }

        return count;
    }
    isInventoryFull(): boolean {
        return this.getEmptyInventorySpace() === 0;
    }
    isInventoryEmpty(): boolean {
        const { bot } = this;
        for (
            let i = bot.inventory.inventoryStart;
            i < bot.inventory.inventoryEnd;
            ++i
        ) {
            const slot = bot.inventory.slots[i];
            if (slot && slot.customName !== "§aSkyBlock Menu §7(Click)")
                return false;
        }
        this.waitForBotEvent("whisper").then();
        return true;
    }
    waitForBotEvent<Event extends keyof BotEvents>(
        eventName: Event,
        timeout?: number
    ) {
        return waitForEvent(this.bot, eventName, timeout);
    }

    async reconnect(delay = 10_000) {
        await this.disconnect();
        await wait(delay);
        await this.connect();
    }

    async disconnect() {
        logger.debug("Disconnecting");
        try {
            this.shouldReconnect = false;
            if (this.onlineStatus !== "offline") {
                this.bot.quit();
                await this.waitForBotEvent("end", -1);
            }
        } catch (err) {
            logger.error(`Failed to disconnect: ${err}. trying again in 5s`);
            await wait(5000);
            await this.disconnect();
        }
    }

    async connect() {
        const server = {
            host: "hypixel.net",
            port: 25565,
            toString() {
                return this.host + ":" + this.port;
            },
        };
        logger.debug("Connecting...");

        this.shouldReconnect = true;
        if (this.onlineStatus !== "offline") return;
        this.postNotification("Connecting", `Connecting to ${server}`, 1);

        try {
            this.onlineStatus = "connecting";
            this.postUpdate();

            const options: BotOptions = {
                username: this.account.email ?? "unknown",
                version: "1.8.9",
                auth: "microsoft",
                profilesFolder: globals.ACCOUNT_CACHE_DIR(
                    this.account.email ?? "unknown"
                ),
                logErrors: false,
                onMsaCode: (res) => {
                    logger.debug(JSON.stringify(res));
                    logger.info(
                        `First time sign in: ${
                            res.message
                        }. Please make sure to sign in using the correct email${
                            this.account.email ? ` (${this.account.email})` : ""
                        }`
                    );
                    this.postNotification(
                        "First time sign in",
                        `${
                            res.message
                        }. Please make sure to sign in using the correct email${
                            this.account.email ? ` (${this.account.email})` : ""
                        }`,
                        3
                    );
                },
            };
            const { proxyConfig } = this.account;
            if (proxyConfig) {
                server.host = `mc.${server.host}`;
                const proxyUrl = new URL(
                    `${proxyConfig.type === "http" ? "http" : "socks"}://${
                        proxyConfig.host
                    }:${proxyConfig.port}`
                );
                if (proxyConfig.username)
                    proxyUrl.username = proxyConfig.username;
                if (proxyConfig.password)
                    proxyUrl.password = proxyConfig.password;

                options.fakeHost = server.host;
                if (proxyConfig.type === "http") {
                    options.agent = new HttpProxyAgent(proxyUrl);
                    options.connect = (client) => {
                        const options: http.RequestOptions = {
                            host: proxyConfig.host,
                            port: proxyConfig.port,
                            method: "CONNECT",
                            path: server.toString(),
                            timeout: 20_000,
                        };
                        if (proxyConfig.username && proxyConfig.password)
                            options.headers = {
                                "Proxy-Authorization":
                                    "Basic " +
                                    Buffer.from(
                                        decodeURIComponent(
                                            proxyConfig.username
                                        ) +
                                            ":" +
                                            decodeURIComponent(
                                                proxyConfig.password
                                            )
                                    ).toString("base64"),
                            };

                        http.request(options)
                            .on("connect", (res, socket) => {
                                if (res.statusCode === 200) {
                                    client.setSocket(socket);
                                    client.emit("connect");
                                } else
                                    client.emit(
                                        "error",
                                        new Error(
                                            `Failed to connect to proxy: ${res.statusCode} ${res.statusMessage}`
                                        )
                                    );
                            })
                            .on("error", (err) => {
                                client.emit(
                                    "error",
                                    new Error(
                                        `Failed to connect to proxy: ${err}`
                                    )
                                );
                            })
                            .end();
                    };
                } else {
                    options.agent = new SocksProxyAgent(proxyUrl);
                    options.connect = (client) => {
                        SocksClient.createConnection(
                            {
                                proxy: {
                                    host: proxyConfig.host,
                                    port: proxyConfig.port,
                                    type: 5,
                                    userId: proxyConfig.username,
                                    password: proxyConfig.password,
                                },
                                command: "connect",
                                destination: {
                                    ...server,
                                },
                            },
                            (err, info) => {
                                if (err || !info) {
                                    client.emit(
                                        "error",
                                        new Error(
                                            `Error connecting through proxy: ${
                                                err ?? "no info"
                                            }`
                                        )
                                    );
                                    return;
                                }
                                client.setSocket(info.socket);
                                client.emit("connect");
                            }
                        );
                    };
                }
            } else {
                options.port = server.port;
                options.host = server.host;
            }

            const bot = createBot(options);
            logger.debug("Applying persistent actions to bot");
            this.bot = this.applyPersistentActions(bot);

            await this.waitForBotEvent("login", 30_000);
        } catch (err) {
            this.onlineStatus = "offline";
            this.postUpdate();
            logger.error(
                `Error logging in with ${this.account.username}: ${err}`
            );
            setTimeout(
                () => this.shouldReconnect && this.connect(),
                30 * 60 * 1000 // Stupid 429
            );
        }
    }

    async updateLocation(): Promise<void> {
        const MAX_FAILS = 5;
        for (let i = 0; i < MAX_FAILS; i++) {
            if (this.onlineStatus !== "online") return;
            try {
                await this.sendChat("/locraw");
                const [message] = await this.waitForMessage(
                    [
                        /Please don't spam the command!/,
                        /You are sending too many commands!/,
                        /{"server":/,
                    ],
                    2000
                );
                if (!message.startsWith('{"server":')) continue;
                const locraw = JSON.parse(message);
                if (locraw.server === "limbo") this.location = "limbo";
                else if (locraw.gametype !== "SKYBLOCK")
                    this.location = "lobby";
                else if (locraw.map === "Private Island")
                    this.location = "island";
                else if (locraw.map === "Hub") this.location = "hub";
                else this.location = "skyblock";
                logger.debug(`Detected location: ${this.location}`);
                this.postUpdate();
                return;
            } catch (err) {
                logger.error(`Error while trying to update location: ${err}`);
            }
        }
        if (this.onlineStatus === "online") {
            logger.error(
                `Failed to update location after ${MAX_FAILS} attempts, reconnecting`
            );
            await this.disconnect();
            await wait(10_000);
            await this.connect();
        }
    }

    lastMessageTime = 0;
    async sendChat(message: string, ignoreDelay?: boolean) {
        if (this.bot.currentWindow)
            this.bot.closeWindow(this.bot.currentWindow);
        if (!ignoreDelay) {
            const delay = 1000;
            const waitTime = delay - (Date.now() - this.lastMessageTime);

            this.lastMessageTime = Date.now();
            if (waitTime > 0) {
                logger.debug(`Waiting ${waitTime}ms to send chat message...`);
                await wait(waitTime);
            }
        }
        this.lastMessageTime = Date.now();

        logger.debug(`Sending chat message '${message}'`);
        this.bot.chat(message);
    }

    signFails = 0;
    async writeToSign(data: string) {
        try {
            const bot = this.bot;
            logger.debug("Waiting for sign to open");
            const packet = await waitForEvent(bot._client, "open_sign_entity");
            await wait(250);
            const { x, y, z } = packet[0].location;
            logger.debug(
                `Writing '${data}' ('${data.substring(
                    0,
                    15
                )}') to sign at x${x} y${y} z${z}`
            );
            const block = bot.blockAt(new Vec3(x, y, z));
            if (!block) throw new Error("block not found");
            bot.updateSign(block, data.substring(0, 15));
            this.signFails = 0;
        } catch (err) {
            if (this.signFails > 5) {
                await this.reconnect();
            } else this.signFails++;
            throw new Error(`Failed to write to sign: ${err}`);
        }
    }

    lastClickTime = 0;
    async clickSlot<T>(
        slot: number,
        mouseButton?: 0 | 1,
        promise?: Promise<T>
    ) {
        await wait(this.lastClickTime + 250 - Date.now());
        this.lastClickTime = Date.now();

        const bot = this.bot;
        logger.debug(
            `Clicking slot ${slot}: ${
                bot.currentWindow &&
                bot.currentWindow.containerItems()[slot]?.customName
            }`
        );
        if (!bot.currentWindow)
            throw new Error("Failed to click: no current window");

        bot.currentWindow.requiresConfirmation = false;
        bot.clickWindow(slot, mouseButton ?? 0, 0);

        if (!promise)
            promise = this.waitForBotEvent("windowOpen") as Promise<T>;
        const value = await promise;

        return value;
    }

    async clickItem<T>(
        name: string,
        mouseButton?: 0 | 1,
        promise?: Promise<T>
    ) {
        logger.debug(`Clicking item ${name}`);
        const slot = findItemSlot(name, this.bot.currentWindow);
        if (slot === -1) {
            throw new Error(`Failed to find '${name}'`);
        }
        return this.clickSlot(slot, mouseButton, promise);
    }

    async addListenerWithTimeout<Event extends keyof BotEvents>(
        eventName: Event,
        listener: (...args: Parameters<BotEvents[Event]>) => boolean,
        timeout = PROMISE_TIMEOUT
    ): Promise<Parameters<BotEvents[Event]>> {
        return new Promise((resolve, reject) => {
            const wrapper = ((...args: Parameters<BotEvents[Event]>) => {
                // eslint-disable-next-line prefer-spread
                if (listener.apply(null, args)) {
                    this.bot.off(eventName, wrapper);
                    resolve(args as Parameters<BotEvents[Event]>);
                }
            }) as BotEvents[Event];
            this.bot.on(eventName, wrapper);
            setTimeout(() => {
                this.bot.off(eventName, wrapper);
                reject(new Error(`Listener timed out after ${timeout}ms`));
            }, timeout);
        });
    }

    async waitForMessage(
        regexps: RegExp[],
        timeout?: number,
        skipPlayerMessages = true
    ) {
        return this.addListenerWithTimeout(
            "messagestr",
            (message, position) => {
                if (position !== "chat") return false;
                const playerPattern = /^.* ([a-zA-Z0-9_]+): .+$/;
                if (skipPlayerMessages && playerPattern.test(message))
                    return false;

                for (const regexp of regexps)
                    if (regexp.test(message)) {
                        return true;
                    }
                return false;
            },
            timeout
        );
    }
}

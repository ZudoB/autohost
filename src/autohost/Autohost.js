const EventEmitter = require("events");

const api = require("../gameapi/api");
const commands = require("./commands");
const APMCalculator = require("./APMCalculator");
const {getForcedPlayCount, incrementForcedPlayCount} = require("../redis/redis");
const {TWO_PLAYER_MODES, APM_LIMIT_EXEMPTIONS} = require("../data/enums");
const {isDeveloper} = require("../data/people");
const {checkAllLegacy, checkAll} = require("./rules");
const ordinal = require("ordinal");
const motds = require("./motds");
const chalk = require("chalk");
const {getBan} = require("../data/globalbans");

/**
 * Autohost! Attaches to a {@link Ribbon} and manages everything in the associated lobby.
 */
class Autohost extends EventEmitter {

    constructor(ribbon, host, isPrivate) {
        super();

        if (!ribbon.room) {
            throw new Error("Ribbon should be connected to a lobby!");
        }

        this.creationTime = Date.now();
        this.timeoutWarned = false;
        this.apmLimitExemption = APM_LIMIT_EXEMPTIONS.NONE;

        this.persist = false;
        this.isPrivate = isPrivate;
        this.host = host;

        this.motd = undefined;

        this.apmCalculator = new APMCalculator(this);

        /** cache for player info **/
        this.playerData = new Map();
        /** cache for username lookup **/
        this.usernamesToIds = new Map();
        /** banned users **/
        this.bannedUsers = new Map();
        /** moderators **/
        this.moderatorUsers = new Map();
        /** users who were !allowed **/
        this.allowedUsers = new Map();

        /** users who have already seen the motd **/
        this.welcomedUsers = new Set();

        this.twoPlayerMode = TWO_PLAYER_MODES.STATIC_HOTSEAT;

        this.twoPlayerOpponent = undefined;
        this.twoPlayerChallenger = undefined;
        this.twoPlayerQueue = [];

        this.bracketSwapWarnedPlayers = {};

        this.rules = {};

        this.autostart = 0;

        this.motdID = "defaultMOTD";

        this.ribbon = ribbon;

        this.ribbon.on("ah-log", message => {
            this.log("[RIBBON] " + message);
        });

        this.ribbon.room.on("playersupdate", () => {
            if (this.ribbon.room.memberCount === 1 && !this.persist && this.someoneDidJoin) {
                this.destroy("Your room was closed because everyone left.");
            } else {
                this.checkAutostart();
            }
        });

        this.ribbon.on("gmupdate", () => {
            this.saveConfig();
        });

        this.ribbon.on("gmupdate.leave", leave => {
            const profile = this.playerData.get(leave);

            this.bracketSwapWarnedPlayers[leave] = 0;

            if (profile) {
                this.usernamesToIds.delete(profile.username.toLowerCase());
            }

            if (this.host === leave) {
                this.ribbon.room.takeOwnership();
            }

            if (this.twoPlayerChallenger === leave) {
                this.twoPlayerChallenger = undefined;
                this.nextChallenger();
                return;
            }

            if (this.twoPlayerOpponent === leave) {
                this.disableQueue();
                this.ribbon.sendChatMessage("The 1v1 queue was disabled because the opponent left.");
            }

            const queueIndex = this.twoPlayerQueue.indexOf(leave);
            if (queueIndex !== -1) {
                this.twoPlayerQueue.splice(queueIndex, 1);
            }
        });


        this.ribbon.on("replay", replay => {
            replay.frames.forEach(frame => {
                if (frame.type === "ige" && frame.data.data.type === "attack") {
                    this.apmCalculator.addGarbageIGE(frame.data.data.sender, frame.data.data.lines);
                }
            });
        });

        this.ribbon.on("gmupdate.bracket", async update => {
            if (!this.ribbon.room.isHost || update.bracket === "spectator") return;

            const playerData = await this.getPlayerData(update.uid);

            const ineligibleMessage = await this.checkPlayerEligibility(update.uid);

            if (ineligibleMessage) {
                this.ribbon.room.switchPlayerBracket(update.uid, "spectator");

                if (this.bracketSwapWarnedPlayers[update.uid]) return;

                this.bracketSwapWarnedPlayers[update.uid] = true;

                setTimeout(() => {
                    this.bracketSwapWarnedPlayers[update.uid] = false;
                }, 10000);

                this.sendMessage(playerData.username, `${ineligibleMessage}.`);
            }
        });

        this.ribbon.on("chat", async chat => {
            if (chat.user.role === "bot") return; // ignore other bots

            const message = chat.content.trim();

            if (message.startsWith(">teto ")) {
                this.ribbon.sendChatMessage(":mahoblush:");
                return;
            }

            if (!message.startsWith("!")) return; // ignore not commands

            const username = chat.user.username;
            const user = chat.user._id;

            if (!user) return; // ignore osk trying to bully us

            let host = user === this.host;
            const mod = [...this.moderatorUsers.values()].indexOf(user) !== -1;
            const dev = isDeveloper(user);

            if (!host && !dev) {
                host = ["admin", "mod"].indexOf((await this.getPlayerData(user)).role) !== -1;
            }

            const args = message.substring(1).split(" ");
            const command = args.shift().toLowerCase();

            if (commands.hasOwnProperty(command)) {
                const commandObj = commands[command];

                if (!this.ribbon.room.isHost && commandObj.needhost) {
                    this.sendMessage(username, "The host needs to exit !hostmode before you can run this command.");
                    return;
                }

                if (!dev && commandObj.devonly) {
                    this.sendMessage(username, "This command is only available for developers.");
                    return;
                }

                if (!host && !dev && commandObj.hostonly) {
                    this.sendMessage(username, "Only the lobby host can use this command.");
                    return;
                }

                if (!host && !mod && !dev && commandObj.modonly) {
                    this.sendMessage(username, "Only lobby moderators can use this command.");
                    return;
                }

                commandObj.handler(user, username, args, this);
            }
        });

        this.ribbon.on("readymulti", async data => {
            if (!this.ribbon.room.isHost) {
                if (this.ribbon.room.players.indexOf(botUserID) !== -1) {
                    const name = (await this.getPlayerData(this.ribbon.room.settings.owner)).username?.toUpperCase();
                    const count = parseInt(await getForcedPlayCount()) || 23; // default to a sensible number if it doesn't work
                    this.ribbon.sendChatMessage(`You thought there would be some funny easter egg here, didn't you, ${name}? Did you think I'd start playing at 5000 APM or something? Seriously?`);
                    this.ribbon.sendChatMessage(`I'm trying my best to help people, and this absolute COMEDIAN over here thought it'd be HILARIOUS to force a room moderation bot into the players bracket.`);
                    this.ribbon.sendChatMessage(`Now watch as, for the ${ordinal(count + 1)} time in my life, I get kicked from the server. I don't get paid for this, you know.`);
                    await incrementForcedPlayCount();
                } else {
                    this.ribbon.sendChatMessage("Please avoid starting the game while in host mode, as this can lead to unexpected behaviour.");
                }
            }

            this.ribbon.room.takeOwnership();

            this.apmCalculator.clearListenIDs();
            for (const player of data.contexts) {
                const playerData = await this.getPlayerData(player.user._id);

                if (this.apmLimitExemption === APM_LIMIT_EXEMPTIONS.RANKED && playerData.league.rank !== "z") {
                    this.log("Exempting " + player.user.username + " from APM limiter.");
                } else {
                    this.apmCalculator.addListenID(player.listenID, player.user.username);
                }

                this.checkPlayerEligibility(player.user._id).then(ineligible => {
                    if (ineligible) {
                        this.ribbon.room.kickPlayer(player.user._id);
                        this.log(player.user._id + " failed final check.");
                    } else {
                        this.log(player.user._id + " verified for play.");
                    }
                });
            }
        });

        this.ribbon.on("startmulti", () => {
            setTimeout(() => {
                if (this.ribbon.room.ingame) { // don't start if the game's already over
                    this.apmCalculator.start();
                }
            }, 20000);

            // ok this seems to work, but i'm not sure
            // `startscope` seems to prompt the server to send replay data, which we Really Want™
            this.ribbon.room.players.forEach(playerID => {
                this.ribbon.sendMessage({
                    command: "startscope",
                    data: playerID
                });
            });
        });

        this.ribbon.on("replayexpectend", gameover => {
            this.apmCalculator.die(gameover.listenID);
        });

        this.ribbon.on("endmulti", endstate => {
            this.gameEndedAt = Date.now();

            this.apmCalculator.stop();

            const firstPlace = endstate.currentboard.find(player => player.success);

            if (firstPlace && this.twoPlayerMode === TWO_PLAYER_MODES.DYNAMIC_HOTSEAT && firstPlace.user._id !== this.twoPlayerOpponent) {
                this.ribbon.sendChatMessage(`${firstPlace.user.username.toUpperCase()} has become the champion!`);

                this.twoPlayerOpponent = firstPlace.user._id;
                this.twoPlayerChallenger = undefined;
                if (this.twoPlayerQueue.indexOf(firstPlace.user._id) !== -1) {
                    this.twoPlayerQueue.splice(this.twoPlayerQueue.indexOf(firstPlace.user._id), 1);
                }
            }

            setTimeout(() => {
                this.nextChallenger();
                this.checkAutostart();
            }, 10000);
        });

        this.ribbon.on("gmupdate.join", join => {
            const ban = getBan(join._id, ["join", "join-persist"]);

            if ((ban && (ban.type === "join" || (ban.type === "join-persist" && this.persist))) || [...this.bannedUsers.values()].indexOf(join._id) !== -1) {
                if (!this.ribbon.room.isHost) {
                    this.ribbon.room.takeOwnership();
                    this.ribbon.room.kickPlayer(join._id);
                    this.ribbon.room.transferOwnership(this.host);
                    this.ribbon.sendChatMessage("Took host temporarily to remove a banned player.");
                } else {
                    this.ribbon.room.kickPlayer(join._id);
                }
                return;
            }

            this.someoneDidJoin = true;

            api.getUser(join._id).then(user => {
                this.playerData.set(user._id, user);
                this.usernamesToIds.set(user.username.toLowerCase(), user._id);

                const {message, rule} = checkAll(this.rules, user, this);

                if (rule) {
                    this.ribbon.room.switchPlayerBracket(user._id, "spectator");
                }

                const actualMotdID = motds.hasOwnProperty(this.motdID) ? this.motdID : "defaultMOTD";

                motds[actualMotdID](this, join._id, user.username, rule, message).then(message => {
                    if (message && !this.welcomedUsers.has(join._id)) {
                        this.ribbon.sendChatMessage(message);
                        this.welcomedUsers.add(join._id);
                        this.saveConfig();
                    }
                });
            });
        });

        this.timeoutInterval = setInterval(() => {
            if (this.persist || this.ribbon.room.settings.type === "private") return;
            if (Date.now() - this.creationTime >= 28200000 && !this.timeoutWarned) { // 7 hours 50 minutes
                this.ribbon.clearChat();
                this.ribbon.sendChatMessage("⚠ LOBBY TIMEOUT WARNING ⚠\n\nTo prevent abuse, public Autohost lobbies time out after eight hours. This lobby will time out soon, so please finish up your games. Thank you!");
                this.timeoutWarned = true;
            } else if (Date.now() - this.creationTime >= 2.88e+7) { // 8 hours
                this.ribbon.room.settings.players.forEach(player => {
                    if (player._id === botUserID) return;
                    this.ribbon.room.kickPlayer(player._id);
                });

                this.destroy("Your Autohost room timed out. Feel free to open a new one.");
            }
        }, 10000);
    }

    log(message) {
        const rulesString = Object.keys(this.rules).map(rule => {
            return rule.split("_").map(part => part[0]).join("").toUpperCase() + "=" + this.rules[rule];
        }).join(",") || "NoRules";

        // Upper case = true, lower case = false
        // H = host mode, or other player host?
        // G = game in progress?
        // O = 1v1 mode?
        // P = persist?
        const flagsString = (this.ribbon?.room?.settings?.owner !== botUserID ? "H" : "h") + (this.ribbon.room.ingame ? "G" : "g") + (this.twoPlayerOpponent ? "O" : "o") + (this.persist ? "P" : "p");
        console.log(chalk.whiteBright(`[Autohost] [${new Date().toLocaleString()} ${this.roomID} ${this.host} ${rulesString} ${flagsString}] ${message.replace(/\n/g, "<line break>")}`));
    }

    async checkPlayerEligibility(player) {
        if (this.twoPlayerOpponent) {
            const elMessage = this.check2pEligibility(player);
            if (elMessage) return elMessage;
        }

        const playerData = await this.getPlayerData(player);

        if ([...this.allowedUsers.values()].indexOf(player) !== -1) {
            // user can play
            return;
        }

        return checkAllLegacy(this.rules, playerData, this);
    }

    get roomID() {
        return this.ribbon.room.settings.id;
    }

    sendMessage(username, message) {
        this.ribbon.sendChatMessage(`[${username.toUpperCase()}] -> ${message}`);
    }

    async getUserID(username) {
        if (this.usernamesToIds.has(username.toLowerCase())) {
            return this.usernamesToIds.get(username.toLowerCase());
        } else {
            const data = (await this.getPlayerData(username.toLowerCase()));
            return data ? data._id : undefined;
        }
    }

    async getPlayerData(player) {
        player = player.toLowerCase();
        if (this.playerData.has(player)) {
            return this.playerData.get(player);
        } else {
            this.log("Loading player data for " + player);
            const data = await api.getUser(player);
            if (data) {
                this.playerData.set(data._id, data);
                this.usernamesToIds.set(data.username.toLowerCase(), data._id);
            }
            return data;
        }
    }

    banPlayer(user, username) {
        this.bannedUsers.set(username.toLowerCase(), user);
    }

    unbanPlayer(username) {
        if (this.bannedUsers.has(username.toLowerCase())) {
            this.bannedUsers.delete(username.toLowerCase());
            return true;
        }
        return false;
    }

    modPlayer(user, username) {
        this.moderatorUsers.set(username.toLowerCase(), user);
    }

    unmodPlayer(username) {
        if (this.moderatorUsers.has(username.toLowerCase())) {
            this.moderatorUsers.delete(username.toLowerCase());
            return true;
        }
        return false;
    }

    recheckPlayers() {
        return Promise.all(this.ribbon.room.players.map(async player => {
            if (await this.checkPlayerEligibility(player)) {
                if (!this.ribbon.room.ingame) {
                    this.ribbon.room.switchPlayerBracket(player, "spectator");
                }
            }
        }));
    }

    checkAutostart() {
        if (Date.now() - this.gameEndedAt < 5000 || this.ribbon.room.ingame) return;

        if (this.autostart === 0) {
            if (this.autostartTimer) {
                clearTimeout(this.autostartTimer);
                this.autostartTimer = undefined;
            }

            return;
        }

        if (this.ribbon.room.ingame) return;

        if (this.ribbon.room.players.length < 2 && this.autostartTimer) {
            if (!this.twoPlayerOpponent) {
                this.ribbon.sendChatMessage("Start cancelled - waiting for players...");
            }
            clearTimeout(this.autostartTimer);
            this.autostartTimer = undefined;
        } else if (this.ribbon.room.players.length >= 2 && !this.autostartTimer) {
            if (!this.twoPlayerOpponent) {
                this.ribbon.sendChatMessage("Game starting in " + this.autostart + " seconds!");
            }
            this.autostartTimer = setTimeout(() => {
                this.start();
                this.autostartTimer = undefined;
            }, this.autostart * 1000);
        }
    }

    check2pEligibility(user) {
        if (this.twoPlayerChallenger !== user && this.twoPlayerOpponent !== user) {
            if (this.twoPlayerQueue.indexOf(user) === -1) {
                return "There is currently a queue for 1v1s in this room - type !queue to join";
            } else {
                return "Please wait to play";
            }
        }
    }

    nextChallenger() {
        if (!this.twoPlayerOpponent || this.ribbon.room.ingame) {
            return false;
        }

        this.twoPlayerChallenger = this.twoPlayerQueue.shift();

        this.ribbon.room.players.forEach(player => {
            this.ribbon.room.switchPlayerBracket(player, "spectator");
        });

        if (!this.twoPlayerChallenger) {
            this.ribbon.sendChatMessage("The 1v1 queue is empty! Type !queue to join.");
            return false;
        }

        this.ribbon.room.switchPlayerBracket(this.twoPlayerOpponent, "player");
        this.ribbon.room.switchPlayerBracket(this.twoPlayerChallenger, "player");

        this.getPlayerData(this.twoPlayerChallenger).then(playerData => {
            this.ribbon.sendChatMessage(`${playerData.username.toUpperCase()} is up next!`);
        });

        return true;
    }

    disableQueue() {
        this.twoPlayerOpponent = undefined;
        this.twoPlayerQueue = [];
        this.autostart = 0
        if (this.autostartTimer) {
            clearTimeout(this.autostartTimer);
            this.autostartTimer = undefined;
        }
        this.saveConfig();
    }

    allowPlayer(user, username) {
        this.allowedUsers.set(username.toLowerCase(), user);
    }

    unallowPlayer(username) {
        if (this.allowedUsers.has(username.toLowerCase())) {
            this.allowedUsers.delete(username.toLowerCase());
            return true;
        }
        return false;
    }

    async start() {
        clearTimeout(this.autostartTimer);
        this.autostartTimer = undefined;

        if (this.twoPlayerOpponent) {
            if (!this.twoPlayerChallenger) {
                this.nextChallenger();
            }
        } else {
            await this.recheckPlayers();
        }

        if (this.ribbon.room.players.length < 2) {
            this.ribbon.sendChatMessage("Not enough players to start.");
            return;
        }

        this.ribbon.room.start();
    }

    destroy(message) {
        this.closing = true;
        this.ribbon.disconnectGracefully();
        clearTimeout(this.autostartTimer);
        clearInterval(this.timeoutInterval);
        this.emit("stop", message);
    }

    saveConfig() {
        this.emit("configchange");
    }
}

module.exports = Autohost;

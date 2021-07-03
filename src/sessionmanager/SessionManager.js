const Ribbon = require("../ribbon/Ribbon");
const Autohost = require("../autohost/Autohost");
const crypto = require("crypto");
const chalk = require("chalk");
const api = require("../gameapi/api");
const TournamentAutohost = require("../tournaments/TournamentAutohost");
const {getBan} = require("../data/globalbans");
const {SERIALISE_TYPES} = require("../data/enums");
const {setLobby, deleteLobby, getLobby, getAllLobbies} = require("../redis/redis");
const {serialise, deserialise} = require("../redis/serialiser");

function sendAutohostWelcome(ribbon, user) {
    ribbon.sendDM(user, "Hi there! Autohost is a bot for TETR.IO that allows for additional host features in custom games. \n\nType !public to create a public lobby. \nType !private to create a private lobby. \n\nIf you're new to Autohost, visit https://kagar.in/autohost to learn more.");
}

function lobbyCreationCommandHandler(isPrivate, sessionmanager, user) {
    const ban = getBan(user, ["host", "join"]);
    if (ban) {
        sessionmanager.ribbon.sendDM(user, `You have been banned from hosting Autohost lobbies until ${new Date(ban.expires).toDateString()} for the following reason: ${ban.reason}`);
        return;
    }
    sessionmanager.createLobby(user, isPrivate).then(id => {
        const session = sessionmanager.getSession(id);
        sessionmanager.ribbon.sendDM(user, `Your ${isPrivate ? "private" : "public"} lobby has been created! \n\nI've tried to invite you, but in case that doesn't work, the room code is ${session.roomID} - join from the Multiplayer menu.`);
        session.ribbon.socialInvite(user);
        setTimeout(() => {
            if (!session.someoneDidJoin) {
                session.destroy("Your lobby timed out because you didn't join in time. Create another one to continue.");
            }
        }, 25000);
    });
}

const COMMANDS = {
    public(sessionmanager, user) {
        return lobbyCreationCommandHandler(false, sessionmanager, user);
    },
    private(sessionmanager, user) {
        return lobbyCreationCommandHandler(true, sessionmanager, user);
    },
    sip(sessionmanager, user) {
        sessionmanager.ribbon.sendDM(user, ":serikasip:");
    },
    login(sessionmanager, user, args) {

    }
};

class SessionManager {

    constructor() {
        this.sessions = new Map();
        this.loginSessions = new Map();

        this.connect();
    }

    log(message) {
        console.log(chalk.yellowBright(`[SessionManager] [${new Date().toLocaleString()}] ${message}`));
    }

    connect() {
        if (this.ribbon) {
            this.ribbon.disconnectGracefully();
        }

        this.startTime = Date.now();

        this.ribbon = new Ribbon(process.env.TOKEN);

        this.ribbon.on("dead", () => {
            this.log("Ribbon died, connecting again...");
            this.connect();
        });

        this.ribbon.once("ready", () => {
            this.ribbon.sendMessage({
                command: "social.presence",
                data: {
                    status: "online",
                    detail: "zen"
                }
            });
        });

        this.ribbon.on("ah-log", msg => {
            this.log("[RIBBON] " + msg);
        });

        this.ribbon.on("social.notification", notif => {
            if (notif.type === "friend") {
                const user = notif.data.relationship.from._id;
                api.friendUser(user).then(() => { // in order to send dms, there needs to be an open dm session or a friendship from our side
                    sendAutohostWelcome(this.ribbon, user);
                    setTimeout(() => {
                        api.unfriendUser(user);
                    }, 10000);
                });
            }
        });

        this.ribbon.on("social.dm", message => {
            if (message.data.userdata.role === "bot") return;

            this.log(`DM (${message.data.user}): ${message.data.content}`);

            if (message.data.content.startsWith("!")) {
                const args = message.data.content.substring(1).trim().split(" ");
                const command = args.shift().toLowerCase();

                if (COMMANDS.hasOwnProperty(command)) {
                    COMMANDS[command](this, message.data.user, args);
                } else {
                    this.ribbon.sendDM(message.data.user, "Sorry, that is not a valid command here. Most Autohost commands should be used in game chat, rather than DMs with me.");
                }
            } else {
                sendAutohostWelcome(this.ribbon, message.data.user);
            }
        });
    }

    applyRoomEvents(autohost, id) {
        autohost.ribbon.once("dead", () => {
            if (autohost.closing) return;

            this.log(`Ribbon died for session ID ${id}, restoring...`);
            this.deleteSession(id);
            this.restoreLobby(id);
        });

        autohost.on("stop", message => {
            this.ribbon.sendDM(autohost.host, message);
            this.deleteSession(id);
            deleteLobby(id).then(() => {
                this.log(`Deleted AH config from Redis for session ID ${id}`);
            });
        });

        autohost.on("configchange", () => {
            const settings = serialise(autohost);
            setLobby(id, settings).then(() => {
                this.log(`Saved AH config to Redis for session ID ${id}`);
            });
        });
    }

    restoreLobby(id) {
        return new Promise(resolve => {
            if (this.sessions.has(id)) {
                this.log("Tried to restore a lobby that's still up.");
                return;
            }

            getLobby(id).then(lobby => {
                const ribbon = new Ribbon(process.env.TOKEN);

                this.log(`Restoring lobby ID ${id}`);

                let joinAttempts = 0;

                ribbon.once("joinroom", () => {
                    ribbon.room.takeOwnership();

                    ribbon.sendChatMessage("Autohost was kicked, rebooted, or otherwise disconnected from TETR.IO. Your room settings have been restored!");

                    let session;

                    if (lobby.type === SERIALISE_TYPES.AUTOHOST) {
                        session = new Autohost(ribbon, lobby.data.host, lobby.data.isPrivate);
                    } else if (lobby.type === SERIALISE_TYPES.TOURNAMENT) {
                        session = new TournamentAutohost({
                            ribbon,
                            restoring: true
                        });
                    }

                    deserialise(lobby, session);
                    this.applyRoomEvents(session, id);
                    this.sessions.set(id, session);
                    resolve();
                });

                ribbon.on("err", error => {
                    if (error === "no such room") {
                        ribbon.disconnectGracefully();
                        this.deleteSession(id);
                        deleteLobby(id).then(() => {
                            this.log(`Room restoration failed because the room no longer exists. Session ${id} was removed from Redis.`);
                            resolve();
                        });
                    } else if (error === "you are already in this room") {
                        joinAttempts++;
                        if (joinAttempts > 4) {
                            this.deleteSession(id);
                            deleteLobby(id).then(() => {
                                this.log(`We're apparently still in the room even after waiting. Killing session ${id}.`);
                                resolve();
                            });
                        } else {
                            this.log(`Attempt ${joinAttempts} at restoring ${id} failed (server hasn't caught on yet)`);
                            setTimeout(() => {
                                ribbon.joinRoom(lobby.data.roomID);
                            }, 5000);
                        }
                    } else if (error === "bots may not join this room" || error === "bots may not join rooms that block anons") {
                        ribbon.disconnectGracefully();
                        this.deleteSession(id);
                        deleteLobby(id).then(() => {
                            this.log(`Cannot (re)join lobby for session ${id} because it blocks anons. Session deleted.`);
                            this.ribbon.sendDM(lobby.host, "Autohost could not join your lobby because anons (and therefore bots) are blocked.");
                            resolve();
                        });
                    }
                });

                ribbon.once("ready", () => {
                    ribbon.joinRoom(lobby.data.roomID);
                });
            });
        });
    }

    async restoreAllLobbies() {
        const lobbies = await getAllLobbies();

        this.log(`Full restore starting! Restoring ${lobbies.length} lobbies.`);

        for (const lobby of lobbies) {
            await this.restoreLobby(lobby);
        }
    }

    createLobby(host, isPrivate) {
        return new Promise(resolve => {
            const ribbon = new Ribbon(process.env.TOKEN);

            this.log(`Creating new lobby (host = ${host}, private = ${isPrivate}}`);

            ribbon.once("joinroom", () => {
                const autohost = new Autohost(ribbon, host, isPrivate);

                api.getUser(host).then(user => {
                    const id = Date.now() + "-" + crypto.randomBytes(8).toString("hex");

                    ribbon.room.setName(user.username.toUpperCase() + "'S AUTOHOST ROOM");

                    this.applyRoomEvents(autohost, id);

                    this.sessions.set(id, autohost);
                    resolve(id);
                });
            });

            ribbon.once("ready", () => {
                ribbon.createRoom(isPrivate);
            });
        });
    }

    createMatchLobby(options) {
        return new Promise(resolve => {
            const ribbon = new Ribbon(process.env.TOKEN);

            options.ribbon = ribbon;

            this.log(`Creating new MATCH lobby (tournament = ${options.tournamentID}, match = ${options.matchID})`);

            ribbon.once("joinroom", () => {
                const autohost = new TournamentAutohost(options);

                const id = Date.now() + "-" + crypto.randomBytes(8).toString("hex");

                this.applyRoomEvents(autohost, id);

                this.sessions.set(id, autohost);
                resolve(id);
            });

            ribbon.once("ready", () => {
                ribbon.createRoom(true);
            });
        });
    }

    getStats() {
        const sessions = [...this.sessions.values()];
        return {
            sessions: {
                count: sessions.length,
                count_persist: sessions.filter(s => s.persist).length,
                count_public: sessions.filter(s => s.ribbon.room.settings.type === "public").length
            },
            players: {
                count: sessions.length > 0 ? sessions.map(s => s.ribbon.room.settings.players.length).reduce((a, b) => a + b) : 0
            },
            start_time: this.startTime
        };
    }

    getSession(id) {
        return this.sessions.get(id);
    }

    getSessionByPersistKey(key) {
        return [...this.sessions.values()].find(session => {
            return session.persistKey === key;
        });
    }

    getSessionByTournamentMatch(tournament, match) {
        return [...this.sessions.values()].find(session => {
            return session.tournamentID === tournament && session.matchID === match;
        });
    }

    deleteSession(id) {
        this.log("Deleted session ID " + id);
        this.sessions.delete(id);
    }

    shutdown() {
        this.sessions.forEach(session => {
            session.ribbon.disconnectGracefully();
        });
    }

    createLoginSession(user) {
        return new Promise(resolve => {
            const ribbon = new Ribbon(process.env.TOKEN);

            const key = crypto.randomBytes(64).toString("hex");

            ribbon.on("gmupdate.join", join => {
                console.log(join, user);
                if (join._id === user) {
                    ribbon.sendChatMessage(`Hi ${join.username.toUpperCase()} - type LOGIN in chat to continue logging in to Autohost Tournaments. If you aren't trying to log in, simply leave the room.`);
                } else {
                    ribbon.room.kickPlayer(join._id);
                }
            });

            ribbon.on("chat", chat => {
                if (chat.user._id === user && chat.content.toLowerCase().trim() === "login") {
                    ribbon.sendChatMessage(":verified: Login complete! You can now leave this room.");
                    this.loginSessions.set(key, {validated: true, user});
                    ribbon.disconnectGracefully();
                }
            })

            ribbon.once("joinroom", room => {
                ribbon.room.setName("LOG IN TO AUTOHOST");
                this.loginSessions.set(key, {validated: false, user});
                resolve({room, key});
            });

            ribbon.once("ready", () => {
                ribbon.createRoom(true);
            });

            setTimeout(() => {
                ribbon.disconnectGracefully();
                this.endLoginSession(key);
            }, 300000);
        });
    }

    validateLoginSession(user, key) {
        if (this.loginSessions.has(key)) {
            const session = this.loginSessions.get(key);
            return session.validated && session.user === user;
        } else {
            return false;
        }
    }

    endLoginSession(key) {
        this.loginSessions.delete(key);
    }
}

module.exports = SessionManager;

const fetch = require("node-fetch");
const chalk = require("chalk");

const API_BASE = "https://ch.tetr.io/api/";
const AUTHED_BASE = "https://tetr.io/api/";

function log(message) {
    console.log(chalk.magentaBright(`[GameAPI] [${new Date().toLocaleString()}] ${message}`));
}

async function get(url) {
    return await (await fetch(API_BASE + url, {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + process.env.TOKEN
        }
    })).json();
}

async function getAuthed(url) {
    return await (await fetch(AUTHED_BASE + url, {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + process.env.TOKEN
        }
    })).json();
}

async function postAuthed(url, body) {
    return await (await fetch(AUTHED_BASE + url, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + process.env.TOKEN,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    })).json();
}

async function getUser(id) {
    if (!id || id.length === 0) return undefined;

    const result = await get("users/" + id);

    if (result.success) {
        log(`Retrieved user info for ${id}`);
        return result.data.user;
    } else {
        return undefined;
    }
}

async function getMe() {
    const result = await getAuthed("users/me");

    if (result && result.success) {
        log(`Retrieved personal information`);
        return result.user;
    } else {
        return undefined;
    }
}

async function getRibbonVersion() {
    const result = await getAuthed("server/environment");

    if (result.success) {
        log(`Retrieved Ribbon version ${result.signature.commit.id}`);
        return result.signature.commit;
    } else {
        return undefined;
    }
}

async function getRibbonEndpoint() {
    const result = await getAuthed("server/ribbon");

    if (result && result.success) {
        log(`Retrieved recommended ribbon endpoint: ${result.endpoint}`)
        return result.endpoint;
    } else {
        throw new Error("Unable to find ribbon endpoint");
    }
}

async function friendUser(user) {
    log(`Friending user ${user}`);
    return await postAuthed("relationships/friend", {user});
}

async function unfriendUser(user) {
    log(`Unfriending user ${user}`);
    return await postAuthed("relationships/remove", {user});
}

module.exports = {getUser, getMe, getRibbonVersion, getRibbonEndpoint, friendUser, unfriendUser};

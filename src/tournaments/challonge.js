const fetch = require("node-fetch");

function parseDescriptionMeta(description) {
    const startPos = description.indexOf("{");
    const endPos = description.lastIndexOf("}");
    const json = description.substring(startPos, endPos+1);
    return JSON.parse(json);
}

function challongeResponseToTournament(t) {
    const meta = parseDescriptionMeta(t.description);

    return {
        id: t.id,
        url: t.url,
        name: t.name,
        shortname: meta.shortname,
        description: meta.description,
        ft: meta.ft,
        wb: meta.wb
    };
}

function challongeResponseToParticipant(p) {
    const misc = JSON.parse(p.misc);

    return {
        id: p.id,
        name: p.name,
        seed: p.seed,
        user_id: misc.id,
        tr: misc.tr
    };
}

async function getAllTournaments() {
    const response = await fetch(`https://api.challonge.com/v1/tournaments.json?api_key=${process.env.CHALLONGE_KEY}`);

    return (await response.json()).map(t => challongeResponseToTournament(t.tournament));
}

async function createTournament(host, name, url, shortname, description, type, ft, wb) {
    const params = new URLSearchParams();

    const descriptionMeta = JSON.stringify({host, name, shortname, description, ft, wb});

    params.set("api_key", process.env.CHALLONGE_KEY);
    params.set("tournament[name]", name);
    params.set("tournament[url]", url);
    params.set("tournament[description]", "DO NOT MODIFY THIS DESCRIPTION DIRECTLY! " + descriptionMeta);
    params.set("tournament[tournament_type]", type);
    params.set("tournament[open_signup]", "false");

    const response = await fetch(`https://api.challonge.com/v1/tournaments.json`, {
        method: "POST",
        body: params
    });

    const body = await response.json();

    const tournament = body.tournament;

    if (!tournament) {
        throw new Error(JSON.stringify(body) || "could not create tournament, contact the developer");
    }

    return challongeResponseToTournament(tournament);
}

async function createParticipant(tournament, name, id, tr, seed) {
    const params = new URLSearchParams();
    params.set("api_key", process.env.CHALLONGE_KEY);
    params.set("participant[name]", name);
    params.set("participant[seed]", seed);
    params.set("participant[misc]", JSON.stringify({id, tr}));


    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/participants.json`, {
        method: "POST",
        body: params
    });

    const participant = (await response.json()).participant;

    if (!participant) {
        throw new Error("could not create participant, contact staff");
    }

    return challongeResponseToParticipant(participant);
}

async function getMatchesForParticipant(tournament, participant) {
    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/matches.json?api_key=${process.env.CHALLONGE_KEY}&participant_id=${participant}`);

    return (await response.json()).map(match => match.match);
}

async function getMatch(tournament, match) {
    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/matches/${match}.json?api_key=${process.env.CHALLONGE_KEY}`);

    return (await response.json()).match;
}


async function getAllParticipants(tournament) {
    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/participants.json?api_key=${process.env.CHALLONGE_KEY}`);

    const participants = await response.json();

    return participants.map(participant => challongeResponseToParticipant(participant.participant));
}

async function getParticipantByTetrioID(tournament, uid) {
    return (await getAllParticipants(tournament)).find(participant => participant.user_id === uid);
}

async function seedPlayer(tournament, tr) {
    const participants = (await getAllParticipants(tournament)).map(participant => participant.tr);

    // kagari forgive me for what i'm doing

    participants.push(tr);
    participants.sort();
    participants.reverse();

    return participants.indexOf(tr) + 1;
}

async function getParticipant(tournament, id) {
    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/participants/${id}.json?api_key=${process.env.CHALLONGE_KEY}`);

    const participant = (await response.json()).participant;

    if (!participant) {
        throw new Error("could not find participant, contact staff");
    }

    return challongeResponseToParticipant(participant);
}

async function reportScores(tournament, match, player1score, player2score, winnerID) {
    const params = new URLSearchParams();
    params.set("api_key", process.env.CHALLONGE_KEY);
    params.set("match[scores_csv]", player1score + "-" + player2score);
    params.set("match[winner_id", winnerID);


    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/matches/${match}.json`, {
        method: "PUT",
        body: params
    });

    return await response.json();
}

async function markUnderway(tournament, match) {
    const response = await fetch(`https://api.challonge.com/v1/tournaments/${tournament}/matches/${match}/mark_as_underway.json?api_key=${process.env.CHALLONGE_KEY}`, {
        method: "POST"
    });

    return await response.json();
}

module.exports = {
    getAllTournaments,
    createTournament,
    createParticipant,
    getMatchesForParticipant,
    getAllParticipants,
    getParticipantByTetrioID,
    seedPlayer,
    getMatch,
    getParticipant,
    reportScores,
    markUnderway
};

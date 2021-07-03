const challonge = require("../../tournaments/challonge");
const {getUser} = require("../../gameapi/api");
const {Router, json} = require("express");
const {body, validationResult} = require("express-validator");
const {TOURNAMENT_TYPES} = require("../../data/enums");
const auth = require("../auth");

module.exports = function (sessionmanager) {
    const app = Router();

    app.get("/", async (req, res) => {
        const tournaments = await challonge.getAllTournaments();

        res.json({tournaments});
    });

    app.post("/",
        auth,
        json(),
        body("name").isLength({min: 3, max: 60}),
        body("summary").isLength({min: 3, max: 200}),
        body("description").isString(),
        body("shortname").isLength({min: 3, max: 16}),
        body("name").isLength({min: 3, max: 60}),
        body("url").optional({checkFalsy: true}).matches(/[a-zA-Z0-9_]{3,16}/),
        body("type").isIn(Object.keys(TOURNAMENT_TYPES)),
        body("ft").isInt({min: 1, max: 99}),
        body("wb").isInt({min: 1, max: 99}),
        body("rank_limit").isArray({min: 2, max: 2}), // todo: validate ranks
        async (req, res) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({errors: errors.array()});
            }

            try {
                const tournament = await challonge.createTournament({
                    host: req.tetrioID,
                    name: req.body.name,
                    url: req.body.url && req.body.url.length > 1 ? req.body.url : undefined,
                    shortname: req.body.shortname,
                    summary: req.body.summary,
                    description: req.body.description,
                    type: TOURNAMENT_TYPES[req.body.type],
                    ft: req.body.ft,
                    wb: req.body.wb,
                    rank_limit: req.body.rank_limit
                });
                res.json(tournament);
            } catch (e) {
                res.status(500).json({error: e.message});
            }
        });

    app.get("/:tournament", async (req, res) => {
        const tournament = await challonge.getTournament(req.params.tournament);
        if (tournament) {
            res.json({tournament});
        } else {
            res.status(404).json({error: "Tournament not found."});
        }
    });

    app.post("/:tournament/participant", auth, async (req, res) => {
        const user = await getUser(req.tetrioID);

        const seed = await challonge.seedPlayer(req.params.tournament, user.league?.rating || -1);

        console.log(`Seeded ${user.username} (TR ${user.league?.rating}) to position ${seed}`);

        try {
            const participant = await challonge.createParticipant(req.params.tournament, user.username, user._id, user.league?.rating || -1, seed);
            res.json({participant});
        } catch (e) {
            res.status(500).json({error: e.message});
        }
    });

    app.get("/:tournament/participant", async (req, res) => {
        const participants = await challonge.getAllParticipants(req.params.tournament);

        if (participants) {
            res.json({participants});
        } else {
            res.status(404).json({error: "tournament not found"});
        }
    });

    app.get("/:tournament/participant/:participant", async (req, res) => {
        const participant = await challonge.getParticipantByTetrioID(req.params.tournament, req.params.participant);

        if (participant) {
            res.json({participant});
        } else {
            res.status(404).json({error: "participant not found"});
        }
    });

    app.post("/:tournament/match/:match/lobby", auth, async (req, res) => {
        const match = await challonge.getMatch(req.params.tournament, req.params.match);

        // todo: check participants to ensure we should allow this

        if (!match) {
            res.status(404).json({error: "Match not found, contact staff."});
            return;
        }

        if (match.state !== "open") {
            res.status(403).json({error: "Match pending or already finished, contact staff."});

            return;
        }

        if (match.underway_at) {
            const session = sessionmanager.getSessionByTournamentMatch(req.params.tournament, req.params.match);

            if (session) {
                res.json({code: session.roomID, created: false});
            } else {
                res.status(403).json({error: "Match unavailable, contact staff."});
            }

            return;
        }

        const player1 = await challonge.getParticipant(req.params.tournament, match.player1_id);
        const player2 = await challonge.getParticipant(req.params.tournament, match.player2_id);

        const sessionID = await sessionmanager.createMatchLobby({
            tournamentID: req.params.tournament,
            matchID: req.params.match,
            player1,
            player2,
            round: match.round,
            tournamentShortname: "Test Tournament",
            tournamentName: "Zudo's Test Tournament #1",
            ft: 7,
            wb: 0,
            restoring: false
        });

        const session = sessionmanager.getSession(sessionID);

        await challonge.markUnderway(req.params.tournament, req.params.match);

        res.json({code: session.roomID, created: true});
    });

    return app;
}

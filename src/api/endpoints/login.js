const {Router, json} = require("express");
const api = require("../../gameapi/api");
const jwt = require("jsonwebtoken");
const {isDeveloper, isPartner} = require("../../data/people");

module.exports = function (sessionmanager) {
    const app = Router();

    app.post("/", json(), async (req, res) => {
        const user = await api.getUser(req.body.user);

        if (!user) {
            return res.status(404).json({error: "User not found, check your spelling and try again."});
        }

        if (user.role === "banned") {
            return res.status(400).json({error: "You are banned from TETR.IO, and are therefore unable to use Autohost Tournaments."});
        }

        if (user.role === "anon") {
            return res.status(400).json({error: "Aonymous accounts cannot be used to log in. Please create a TETR.IO account and log in with that."});
        }

        if (user.role === "bot") {
            return res.status(400).json({error: "Bot accounts cannot be used to log in, sorry!"});
        }

        const {room, key} = await sessionmanager.createLoginSession(user._id);

        res.json({room, key, user: user._id});
    });

    app.get("/", (req, res) => {
        if (sessionmanager.validateLoginSession(req.query.user, req.query.key)) {
            jwt.sign({
                sub: req.query.user,
                developer: isDeveloper(req.query.user),
                partner: isPartner(req.query.user)
            }, process.env.JWT_KEY, (err, jwt) => {
                if (err) return res.status(500).json({error: "failed to issue token, contact the developer"});
                sessionmanager.endLoginSession(req.query.user);
                res.json({token: jwt});
            });
        } else {
            res.status(401).json({error: "not authorised yet or session invalid"});
        }
    });

    return app;
}

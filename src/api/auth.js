const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
    const header = req.get("authorization");

    if (!header) {
        return res.status(401).json({error: "authorization required"});
    }

    const parts = header.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
        return res.status(401).json({error: "bearer token required"});
    }

    const token = parts[1];

    jwt.verify(token, process.env.JWT_KEY, (err, claim) => {
        if (err) return res.status(401).json({error: "token invalid"});

        req.tetrioID = claim.sub;
    });

    next();
}

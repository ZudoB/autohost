const express = require("express");
const chalk = require("chalk");
const cors = require("cors");

class APIServer {

    constructor(port, sessionmanager) {
        this.app = express();

        this.app.disable("x-powered-by");

        this.app.use(cors());

        this.app.use("/stats", require("./endpoints/stats")(sessionmanager));
        this.app.use("/tournament", require("./endpoints/tournament")(sessionmanager));
        this.app.use("/login", require("./endpoints/login")(sessionmanager));

        this.app.listen(port, () => {
            this.log(`Now listening on port ${port}`);
        });
    }

    log(message) {
        console.log(chalk.cyanBright(`[APIServer] [${new Date().toLocaleString()}] ${message}`));
    }
}

module.exports = APIServer;

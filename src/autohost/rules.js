const {getBan} = require("../data/globalbans");
const {RANK_HIERARCHY} = require("../data/data");

function xpToLevel(xp) {
    return Math.pow(xp / 500, 0.6) + (xp / (5000 + Math.max(0, xp - 4000000) / 5000)) + 1;
}

const RULES = {
    anons_allowed: {
        type: Boolean,
        default: true,
        check(value, user) {
            // check: option set AND user is anon
            return !value && user.role === "anon";
        },
        message() {
            return "Unregistered (anonymous / guest) players cannot play in this room";
        },
        description(value) {
            return `Anonymous players allowed: ${value ? ":checked:" : ":crossed:"}`;
        }
    },
    unrated_allowed: {
        type: Boolean,
        default: true,
        check(value, user) {
            // check: unrated NOT allowed AND *percentile* rank is unranked
            return !value && user.league.percentile_rank === "z";
        },
        message() {
            return "Players who have not completed their Tetra League rating games cannot play in this room";
        },
        description(value) {
            return `Unrated players allowed: ${value ? ":checked:" : ":crossed:"}`;
        }
    },
    rankless_allowed: {
        type: Boolean,
        default: true,
        check(value, user) {
            // check: rankless NOT allowed AND rank is unranked
            return !value && user.league.rank === "z";
        },
        message() {
            return "Players without a rank letter cannot play in this room";
        },
        description(value) {
            return `Rankless players allowed: ${value ? ":checked:" : ":crossed:"}`;
        }
    },
    max_rank: {
        type: RANK_HIERARCHY,
        default: "z",
        check(value, user) {
            // check: option set AND user has a TR AND percentile rank > max
            return value !== "z" && user.league.percentile_rank !== "z" && RANK_HIERARCHY.indexOf(user.league.percentile_rank) > RANK_HIERARCHY.indexOf(value)
        },
        message(value) {
            return `Your TR is too high for this room (maximum is around :rank${value.replace("+", "plus").replace("-", "minus")}:)`
        },
        description(value) {
            if (value === "z") {
                return "Maximum rank: no limit";
            } else {
                return `Maximum rank: :rank${value.replace("+", "plus").replace("-", "minus")}:`;
            }
        }
    },
    min_rank: {
        type: RANK_HIERARCHY,
        default: "z",
        check(value, user) {
            // check: option set AND user has a TR AND percentile rank < min
            return value !== "z" && user.league.percentile_rank !== "z" && RANK_HIERARCHY.indexOf(user.league.percentile_rank) < RANK_HIERARCHY.indexOf(value)
        },
        message(value) {
            return `Your TR is too low for this room (minimum is around :rank${value.replace("+", "plus").replace("-", "minus")}:)`
        },
        description(value) {
            if (value === "z") {
                return "Minimum rank: no limit";
            } else {
                return `Minimum rank: :rank${value.replace("+", "plus").replace("-", "minus")}:`;
            }
        }
    },
    min_level: {
        type: Number,
        default: 0,
        check(value, user) {
            // check: option set AND level < min
            return value !== 0 && xpToLevel(user.xp) < value;
        },
        message(value) {
            return `Your level is too low for this room (minimum is ${value})`
        },
        description(value) {
            return `Minimum level: ${value}`;
        }
    },
    max_apm: {
        type: Number,
        default: 0,
        check(value, user, autohost) {
            return value > 0 && autohost.apmCalculator.infractions.get(user.username) >= 3;
        },
        message(value) {
            return `You cannot play as you have been consistently exceeding the room's APM limit (${value} APM)`;
        },
        description(value) {
            return `Maximum APM: ${value !== 0 ? value : "no limit"}`;
        },
        onchange(autohost, oldvalue, newvalue) {
            if (!oldvalue) {
                autohost.ribbon.sendChatMessage("Please note that APM limits are still in development, and may not behave as expected. Be generous with your APM limits, as low limits may inadvertently exclude legitimate players.");
            }

            if (newvalue > oldvalue) {
                if (oldvalue > 0) {
                    autohost.ribbon.sendChatMessage("The APM limit was increased. Players who previously exceeded the APM limit can now play again.");
                }
                autohost.apmCalculator.infractions.clear();
            }
        }
    }
};

function checkAll(ruleset, user, autohost) {
    const ban = getBan(user._id, ["participation", "participation-persist"]);

    if (ban) {
        if (autohost.persist && ban.type === "participation-persist") {
            return {
                rule: "globalban",
                message: `You have been banned from participating in unattended Autohost lobbies until ${new Date(ban.expires).toDateString()} for the following reason: ${ban.reason}`
            }
        } else if (ban.type === "participation") {
            return {
                rule: "globalban",
                message: `You have been banned from participating in ALL Autohost lobbies until ${new Date(ban.expires).toDateString()} for the following reason: ${ban.reason}`
            }
        }
    }

    for (const rule in RULES) {
        if (RULES.hasOwnProperty(rule)) {
            // default is a reserved keyword lol
            const {check, default: defaultValue, message} = RULES[rule];

            let value;

            if (ruleset.hasOwnProperty(rule)) {
                value = ruleset[rule];
            } else {
                value = defaultValue;
            }

            if (check(value, user, autohost)) {
                return {
                    rule,
                    message: message(value)
                };
            }
        }
    }

    return {rule: undefined, message: undefined};
}

function checkAllLegacy(ruleset, user, autohost) {
    return checkAll(ruleset, user, autohost).message;
}

module.exports = {checkAll, checkAllLegacy, RULES};

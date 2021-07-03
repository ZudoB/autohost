const DEVELOPERS = [
    "5e4979d4fad3ca55f6512458" // zudo
];

const PARTNERS = [
    "5e4979d4fad3ca55f6512458", // zudo
    "5e47696db7c60f23a497ee6c" // cab
];

function isDeveloper(user) {
    return DEVELOPERS.indexOf(user) !== -1;
}

function isPartner(user) {
    return PARTNERS.indexOf(user) !== -1;
}

module.exports = {isDeveloper, isPartner};

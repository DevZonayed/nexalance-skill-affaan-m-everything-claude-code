const { parseConfig } = require('./config');

function main() {
  return parseConfig('./app.json');
}

module.exports = { main };

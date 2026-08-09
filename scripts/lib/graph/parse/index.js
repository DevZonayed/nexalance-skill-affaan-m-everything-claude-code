'use strict';

const typescript = require('./typescript');

const PARSERS = {
  typescript,
  tsx: typescript,
  javascript: typescript,
};

async function parseSource(lang, source) {
  const parser = PARSERS[lang];
  if (!parser) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  return parser.parseSource(lang, source);
}

module.exports = { parseSource, PARSERS };

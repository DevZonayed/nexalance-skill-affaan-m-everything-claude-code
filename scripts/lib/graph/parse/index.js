'use strict';

const typescript = require('./typescript');
const python = require('./python');
const rust = require('./rust');
const go = require('./go');

const PARSERS = {
  typescript,
  tsx: typescript,
  javascript: typescript,
  python,
  rust,
  go,
};

async function parseSource(lang, source) {
  const parser = PARSERS[lang];
  if (!parser) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  return parser.parseSource(lang, source);
}

module.exports = { parseSource, PARSERS };

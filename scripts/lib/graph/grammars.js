'use strict';

const path = require('path');
const Parser = require('web-tree-sitter');

// Maps our language id to the tree-sitter-wasms grammar filename stem.
const GRAMMAR_FILES = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  rust: 'tree-sitter-rust',
  go: 'tree-sitter-go',
};

const languageCache = new Map();
const parserCache = new Map();
let initPromise = null;

function supportedLanguages() {
  return Object.keys(GRAMMAR_FILES);
}

function grammarPath(lang) {
  const stem = GRAMMAR_FILES[lang];
  const pkgDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  return path.join(pkgDir, 'out', `${stem}.wasm`);
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

async function loadGrammar(lang) {
  if (!GRAMMAR_FILES[lang]) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  if (languageCache.has(lang)) {
    return languageCache.get(lang);
  }
  await ensureInit();
  const language = await Parser.Language.load(grammarPath(lang));
  languageCache.set(lang, language);
  return language;
}

async function getParser(lang) {
  if (parserCache.has(lang)) {
    return parserCache.get(lang);
  }
  const language = await loadGrammar(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

module.exports = {
  supportedLanguages,
  loadGrammar,
  getParser,
};

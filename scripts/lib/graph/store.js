'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const { parseSource } = require('./parse');
const { refineKind } = require('./kinds');

const SCHEMA = 'ecc.graph.file.v1';
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go'];

function graphDir(repoRoot) {
  return path.join(repoRoot, '.ecc', 'graph');
}

function hashContent(source) {
  return `sha256:${crypto.createHash('sha256').update(String(source), 'utf8').digest('hex')}`;
}

function shardPath(dir, relPath) {
  const digest = crypto.createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 32);
  return path.join(dir, 'files', `${digest}.json`);
}

function writeShard(dir, shard) {
  return writeFileAtomic(shardPath(dir, shard.path), `${JSON.stringify(shard, null, 2)}\n`);
}

function readShard(dir, relPath) {
  try {
    return JSON.parse(fs.readFileSync(shardPath(dir, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function resolveImport(repoRoot, fromRel, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const baseDir = path.dirname(path.join(repoRoot, fromRel));
  for (const ext of RESOLVE_EXTS) {
    const candidate = path.resolve(baseDir, spec + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(repoRoot, candidate).split(path.sep).join('/');
    }
  }
  for (const ext of RESOLVE_EXTS.filter(Boolean)) {
    const candidate = path.resolve(baseDir, spec, `index${ext}`);
    if (fs.existsSync(candidate)) {
      return path.relative(repoRoot, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

async function buildShard(repoRoot, relPath, lang, rev) {
  const abs = path.join(repoRoot, relPath);
  const source = fs.readFileSync(abs, 'utf8');
  const base = {
    schema: SCHEMA,
    path: relPath,
    lang,
    hash: hashContent(source),
    rev,
    status: 'indexed',
    doc: null,
    imports: [],
    exports: [],
    symbols: [],
  };

  let parsed;
  try {
    parsed = await parseSource(lang, source);
  } catch (err) {
    return Object.assign(base, { status: 'parse_error', error: err.message });
  }

  base.doc = parsed.doc;
  base.exports = parsed.exports;
  base.imports = parsed.imports.map(imp => Object.assign({}, imp, {
    resolved: resolveImport(repoRoot, relPath, imp.from),
  }));
  base.symbols = parsed.symbols.map(symbol => {
    const refined = refineKind(symbol, { lang, relPath, source });
    return Object.assign({}, symbol, { kind: refined.kind, label: refined.label });
  });

  return base;
}

module.exports = {
  SCHEMA,
  graphDir,
  hashContent,
  shardPath,
  writeShard,
  readShard,
  resolveImport,
  buildShard,
};

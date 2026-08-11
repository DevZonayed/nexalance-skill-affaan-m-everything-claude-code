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

function buildIndexes(shards) {
  const symbols = {};
  const kinds = {};
  const out = {};
  const incoming = {};

  for (const shard of shards) {
    if (shard.status !== 'indexed') continue;

    for (const symbol of shard.symbols || []) {
      const ref = {
        path: shard.path,
        line: symbol.line,
        kind: symbol.kind,
        exported: Boolean(symbol.exported),
      };
      if (!symbols[symbol.name]) symbols[symbol.name] = [];
      symbols[symbol.name].push(ref);

      if (!kinds[symbol.kind]) kinds[symbol.kind] = [];
      kinds[symbol.kind].push({
        path: shard.path,
        line: symbol.line,
        name: symbol.name,
        label: symbol.label || null,
      });
    }

    const targets = (shard.imports || [])
      .map(imp => imp.resolved)
      .filter(Boolean);
    if (targets.length) {
      out[shard.path] = [...new Set(targets)].sort();
      for (const target of out[shard.path]) {
        if (!incoming[target]) incoming[target] = [];
        if (!incoming[target].includes(shard.path)) incoming[target].push(shard.path);
      }
    }
  }

  for (const key of Object.keys(incoming)) incoming[key].sort();

  return {
    symbols: { schema: 'ecc.graph.symbols.v1', symbols },
    kinds: { schema: 'ecc.graph.kinds.v1', kinds },
    edges: { schema: 'ecc.graph.edges.v1', out, in: incoming },
  };
}

function indexPath(dir, name) {
  return path.join(dir, 'index', `${name}.json`);
}

function writeIndexes(dir, indexes) {
  for (const name of ['symbols', 'kinds', 'edges']) {
    writeFileAtomic(indexPath(dir, name), `${JSON.stringify(indexes[name], null, 2)}\n`);
  }
}

function readIndex(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

function buildManifest(input) {
  const shards = input.shards || [];
  const indexed = shards.filter(s => s.status === 'indexed');
  const symbolCount = indexed.reduce((n, s) => n + (s.symbols || []).length, 0);
  const edgeCount = indexed.reduce(
    (n, s) => n + (s.imports || []).filter(i => i.resolved).length, 0
  );
  return {
    schema: 'ecc.graph.manifest.v1',
    rev: input.rev,
    built_at: new Date().toISOString(),
    git_sha: input.gitSha || null,
    languages: input.languages || [],
    entrypoints: input.entrypoints || [],
    counts: { files: indexed.length, symbols: symbolCount, edges: edgeCount },
    unindexed: {
      unsupported: input.unsupportedCount || 0,
      parse_error: shards.filter(s => s.status === 'parse_error').length,
    },
  };
}

function writeManifest(dir, manifest) {
  writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
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
  buildIndexes,
  writeIndexes,
  readIndex,
  buildManifest,
  writeManifest,
  readManifest,
};

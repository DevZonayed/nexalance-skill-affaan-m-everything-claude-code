'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const detector = require('./detector');
const store = require('./store');
const historyLog = require('./history');
const { isHeuristic, STRUCTURAL_KINDS, HEURISTIC_KINDS } = require('./kinds');

const EXIT = { ANSWERED: 0, ABSENT: 1, UNAVAILABLE: 2, NOT_INDEXED: 3 };

function gitSha(repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function countUnsupported(repoRoot) {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return 0;
  const all = result.stdout.split('\n').filter(Boolean);
  return all.filter(f => detector.languageForFile(f) === null).length;
}

async function build(repoRoot) {
  const dir = store.graphDir(repoRoot);
  const previous = store.readManifest(dir);
  const rev = previous ? previous.rev + 1 : 1;
  const sha = gitSha(repoRoot);
  const files = detector.listSourceFiles(repoRoot);

  const shards = [];
  const events = [];
  for (const file of files) {
    const oldShard = store.readShard(dir, file.path);
    const shard = await store.buildShard(repoRoot, file.path, file.lang, rev);
    store.writeShard(dir, shard);
    shards.push(shard);
    events.push(...historyLog.diffShards(oldShard, shard, { rev, sha }));
  }

  const indexes = store.buildIndexes(shards);
  store.writeIndexes(dir, indexes);
  const manifest = store.buildManifest({
    rev,
    gitSha: sha,
    languages: detector.detectLanguages(repoRoot),
    entrypoints: detector.findEntrypoints(repoRoot),
    shards,
    unsupportedCount: countUnsupported(repoRoot),
  });
  store.writeManifest(dir, manifest);
  historyLog.appendEvents(dir, events);

  return { rev, counts: manifest.counts };
}

// Re-parses a file if its on-disk content no longer matches the stored hash.
async function verifyFresh(repoRoot, relPath) {
  const dir = store.graphDir(repoRoot);
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return { state: 'missing', shard: null };

  const shard = store.readShard(dir, relPath);
  const source = fs.readFileSync(abs, 'utf8');
  const actual = store.hashContent(source);
  if (shard && shard.hash === actual) return { state: 'fresh', shard };

  const lang = detector.languageForFile(relPath);
  if (!lang) return { state: 'missing', shard: null };

  const manifest = store.readManifest(dir);
  const rev = manifest ? manifest.rev : 1;
  const healed = await store.buildShard(repoRoot, relPath, lang, rev);
  store.writeShard(dir, healed);
  historyLog.appendEvents(dir, historyLog.diffShards(shard, healed, { rev, sha: gitSha(repoRoot) }));
  return { state: 'healed', shard: healed };
}

function indexOrUnavailable(repoRoot, name) {
  const dir = store.graphDir(repoRoot);
  if (!store.readManifest(dir)) return null;
  return store.readIndex(dir, name);
}

async function find(repoRoot, name, opts) {
  const options = opts || {};
  const index = indexOrUnavailable(repoRoot, 'symbols');
  if (!index) return { code: EXIT.UNAVAILABLE, results: [] };

  const candidatePaths = new Set((index.symbols[name] || []).map(r => r.path));

  // Any file previously holding this symbol must be re-verified, and so must
  // every file whose shard may have gained it since the last build.
  const results = [];
  const checked = new Set();
  for (const relPath of candidatePaths) {
    checked.add(relPath);
    const { shard } = await verifyFresh(repoRoot, relPath);
    if (!shard) continue;
    for (const symbol of shard.symbols || []) {
      if (symbol.name === name) {
        results.push({ path: relPath, line: symbol.line, kind: symbol.kind,
          signature: symbol.signature, doc: symbol.doc, exported: symbol.exported });
      }
    }
  }

  // A miss is only definitive after re-verifying every indexed file, because a
  // symbol may have been added since the last build.
  if (!results.length) {
    for (const file of detector.listSourceFiles(repoRoot)) {
      if (checked.has(file.path)) continue;
      const { shard } = await verifyFresh(repoRoot, file.path);
      if (!shard) continue;
      for (const symbol of shard.symbols || []) {
        if (symbol.name === name) {
          results.push({ path: file.path, line: symbol.line, kind: symbol.kind,
            signature: symbol.signature, doc: symbol.doc, exported: symbol.exported });
        }
      }
    }
  }

  const filtered = options.kind
    ? results.filter(r => r.kind === options.kind)
    : results;

  return {
    code: filtered.length ? EXIT.ANSWERED : EXIT.ABSENT,
    results: filtered,
  };
}

async function fileInfo(repoRoot, relPath) {
  const lang = detector.languageForFile(relPath);
  if (!lang) return { code: EXIT.NOT_INDEXED, shard: null };
  const { state, shard } = await verifyFresh(repoRoot, relPath);
  if (state === 'missing' || !shard) return { code: EXIT.NOT_INDEXED, shard: null };
  if (shard.status !== 'indexed') return { code: EXIT.NOT_INDEXED, shard };
  return { code: EXIT.ANSWERED, shard };
}

async function deps(repoRoot, relPath, opts) {
  const options = opts || {};
  const edges = indexOrUnavailable(repoRoot, 'edges');
  if (!edges) return { code: EXIT.UNAVAILABLE, direct: [], reverse: [] };
  const direct = edges.out[relPath] || [];
  const reverse = edges.in[relPath] || [];
  const hit = options.reverse ? reverse.length : direct.length;
  return { code: hit ? EXIT.ANSWERED : EXIT.ABSENT, direct, reverse };
}

async function impact(repoRoot, target) {
  const edges = indexOrUnavailable(repoRoot, 'edges');
  if (!edges) return { code: EXIT.UNAVAILABLE, direct: [], transitive: [], tests: [] };

  const direct = edges.in[target] || [];
  const seen = new Set(direct);
  const queue = [...direct];
  while (queue.length) {
    const current = queue.shift();
    for (const next of edges.in[current] || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const all = [...seen];
  const tests = all.filter(p => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\./i.test(p));
  return {
    code: all.length ? EXIT.ANSWERED : EXIT.ABSENT,
    direct,
    transitive: all.filter(p => !direct.includes(p)),
    tests,
  };
}

async function list(repoRoot, kind, opts) {
  const options = opts || {};
  const heuristic = isHeuristic(kind);
  const index = indexOrUnavailable(repoRoot, 'kinds');
  if (!index) return { code: EXIT.UNAVAILABLE, results: [], heuristic };

  if (!STRUCTURAL_KINDS.has(kind) && !HEURISTIC_KINDS.has(kind)) {
    return { code: EXIT.NOT_INDEXED, results: [], heuristic };
  }

  let results = index.kinds[kind] || [];
  if (options.pathPrefix) {
    results = results.filter(r => r.path.startsWith(options.pathPrefix));
  }

  if (results.length) return { code: EXIT.ANSWERED, results, heuristic };
  // An empty heuristic result does not prove absence.
  return { code: heuristic ? EXIT.NOT_INDEXED : EXIT.ABSENT, results: [], heuristic };
}

async function history(repoRoot, target) {
  const dir = store.graphDir(repoRoot);
  if (!store.readManifest(dir)) return { code: EXIT.UNAVAILABLE, events: [] };
  const byPath = historyLog.readEvents(dir, { path: target });
  const events = byPath.length ? byPath : historyLog.readEvents(dir, { symbol: target });
  return { code: events.length ? EXIT.ANSWERED : EXIT.ABSENT, events };
}

async function status(repoRoot) {
  const manifest = store.readManifest(store.graphDir(repoRoot));
  if (!manifest) return { code: EXIT.UNAVAILABLE, line: '' };
  const { files, symbols } = manifest.counts;
  const errors = manifest.unindexed.parse_error;
  const unsupported = manifest.unindexed.unsupported;
  const line =
    `graph: ${files} files, ${symbols} symbols, rev ${manifest.rev} ` +
    `(${errors} parse errors, ${unsupported} unsupported)\n` +
    'query before reading files: ecc graph find|file|deps|impact|list';
  return { code: EXIT.ANSWERED, line };
}

async function doctor(repoRoot) {
  const dir = store.graphDir(repoRoot);
  const manifest = store.readManifest(dir);
  if (!manifest) {
    return { code: EXIT.UNAVAILABLE, report: { ok: false, reason: 'no index; run: ecc graph build' } };
  }
  const files = detector.listSourceFiles(repoRoot);
  let stale = 0;
  let missing = 0;
  for (const file of files) {
    const shard = store.readShard(dir, file.path);
    if (!shard) { missing++; continue; }
    const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8');
    if (store.hashContent(source) !== shard.hash) stale++;
  }
  return {
    code: EXIT.ANSWERED,
    report: {
      ok: true,
      rev: manifest.rev,
      indexed: manifest.counts.files,
      stale,
      missing,
      parse_errors: manifest.unindexed.parse_error,
    },
  };
}

module.exports = {
  EXIT, build, verifyFresh, find, fileInfo, deps, impact, list, history, status, doctor,
};

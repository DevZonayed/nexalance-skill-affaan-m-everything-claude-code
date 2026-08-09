#!/usr/bin/env node
'use strict';

const path = require('path');
const query = require('./lib/graph/query');
const format = require('./lib/graph/format');

const USAGE = `Usage: ecc graph <verb> [args] [--json]

  build [--force]            Build or rebuild the index
  find <symbol> [--kind K]   Locate a symbol
  file <path>                Summarise a file
  deps <path> [--reverse]    Imports, or importers
  impact <path>              Transitive reverse dependencies
  list --kind <kind>         List symbols of a kind
  history <symbol|path>      Structural changelog
  doctor                     Index health
  status                     One-line summary

Exit codes: 0 answered, 1 definitively absent, 2 unavailable, 3 not indexed.`;

function repoRoot() {
  return process.env.ECC_GRAPH_ROOT || process.cwd();
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function emit(asJson, payload, humanText) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (humanText) {
    process.stdout.write(`${humanText}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  const asJson = flag(args, 'json');
  const root = repoRoot();

  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(verb ? 0 : 2);
  }

  switch (verb) {
    case 'build': {
      const result = await query.build(root);
      emit(asJson, result,
        `built rev ${result.rev}: ${result.counts.files} files, ` +
        `${result.counts.symbols} symbols, ${result.counts.edges} edges`);
      process.exit(query.EXIT.ANSWERED);
      break;
    }
    case 'find': {
      const name = args[1];
      if (!name) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.find(root, name, { kind: option(args, 'kind') });
      const withName = r.results.map(x => Object.assign({ name }, x));
      emit(asJson, { code: r.code, results: withName }, format.formatFind(withName));
      process.exit(r.code);
      break;
    }
    case 'file': {
      const rel = args[1];
      if (!rel) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.fileInfo(root, rel.split(path.sep).join('/'));
      emit(asJson, r, r.shard ? format.formatFile(r.shard) : 'not indexed');
      process.exit(r.code);
      break;
    }
    case 'deps': {
      const rel = args[1];
      const reverse = flag(args, 'reverse');
      const r = await query.deps(root, rel, { reverse });
      const shown = reverse ? r.reverse : r.direct;
      emit(asJson, r, shown.join('\n') || 'none');
      process.exit(r.code);
      break;
    }
    case 'impact': {
      const r = await query.impact(root, args[1]);
      emit(asJson, r,
        `direct (${r.direct.length}): ${r.direct.join(', ') || 'none'}\n` +
        `transitive (${r.transitive.length}): ${r.transitive.join(', ') || 'none'}\n` +
        `tests: ${r.tests.join(', ') || 'none'}`);
      process.exit(r.code);
      break;
    }
    case 'list': {
      const kind = option(args, 'kind');
      if (!kind) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.list(root, kind, { pathPrefix: option(args, 'path') });
      emit(asJson, r, r.results.length
        ? format.formatList(r.results)
        : `no ${kind} found${r.heuristic ? ' (heuristic kind: absence not guaranteed)' : ''}`);
      process.exit(r.code);
      break;
    }
    case 'history': {
      const r = await query.history(root, args[1]);
      emit(asJson, r, r.events
        .map(e => `rev${e.rev} ${e.sha || '-'} ${e.op} ${e.symbol || e.path}` +
          `${e.from || e.to ? ` ${e.from || ''} -> ${e.to || ''}` : ''}`)
        .join('\n') || 'no events');
      process.exit(r.code);
      break;
    }
    case 'doctor': {
      const r = await query.doctor(root);
      emit(asJson, r, JSON.stringify(r.report));
      process.exit(r.code);
      break;
    }
    case 'status': {
      const r = await query.status(root);
      emit(asJson, r, r.line);
      process.exit(r.code);
      break;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write(`[graph] ${err.message}\n`);
  process.exit(query.EXIT.UNAVAILABLE);
});

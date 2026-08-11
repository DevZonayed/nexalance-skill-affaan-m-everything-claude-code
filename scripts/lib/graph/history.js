'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'ecc.graph.event.v1';

function eventsPath(dir) {
  return path.join(dir, 'history', 'events.jsonl');
}

function makeEvent(meta, op, filePath, fields) {
  return Object.assign({
    schema: SCHEMA,
    rev: meta.rev,
    sha: meta.sha || null,
    at: new Date().toISOString(),
    op,
    path: filePath,
    symbol: null,
    from: null,
    to: null,
    decision: null,
  }, fields || {});
}

function symbolMap(shard) {
  const map = new Map();
  for (const symbol of (shard && shard.symbols) || []) {
    map.set(symbol.name, symbol);
  }
  return map;
}

function edgeSet(shard) {
  return new Set(
    ((shard && shard.imports) || []).map(i => i.resolved).filter(Boolean)
  );
}

function diffShards(oldShard, newShard, meta) {
  if (!oldShard && !newShard) return [];
  if (!oldShard) return [makeEvent(meta, 'file.added', newShard.path)];
  if (!newShard) return [makeEvent(meta, 'file.removed', oldShard.path)];

  const filePath = newShard.path;
  const events = [];
  const before = symbolMap(oldShard);
  const after = symbolMap(newShard);

  for (const [name, symbol] of after) {
    if (!before.has(name)) {
      events.push(makeEvent(meta, 'symbol.added', filePath, { symbol: name, to: symbol.signature || null }));
    } else {
      const prev = before.get(name);
      if ((prev.signature || null) !== (symbol.signature || null)) {
        events.push(makeEvent(meta, 'signature.changed', filePath, {
          symbol: name,
          from: prev.signature || null,
          to: symbol.signature || null,
        }));
      }
    }
  }

  for (const name of before.keys()) {
    if (!after.has(name)) {
      events.push(makeEvent(meta, 'symbol.removed', filePath, { symbol: name }));
    }
  }

  const oldEdges = edgeSet(oldShard);
  const newEdges = edgeSet(newShard);
  for (const target of newEdges) {
    if (!oldEdges.has(target)) events.push(makeEvent(meta, 'edge.added', filePath, { to: target }));
  }
  for (const target of oldEdges) {
    if (!newEdges.has(target)) events.push(makeEvent(meta, 'edge.removed', filePath, { from: target }));
  }

  return events;
}

function appendEvents(dir, events) {
  if (!events || !events.length) return;
  const target = eventsPath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.appendFileSync(target, `${lines}\n`, 'utf8');
}

function readEvents(dir, filter) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(dir), 'utf8');
  } catch {
    return [];
  }
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!filter) return events;
  return events.filter(e =>
    (!filter.path || e.path === filter.path) &&
    (!filter.symbol || e.symbol === filter.symbol)
  );
}

module.exports = { SCHEMA, diffShards, appendEvents, readEvents, eventsPath };

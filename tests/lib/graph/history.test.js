/**
 * Tests for scripts/lib/graph/history.js
 *
 * Run with: node tests/lib/graph/history.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../../../scripts/lib/graph/history');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function shard(symbols, imports) {
  return {
    schema: 'ecc.graph.file.v1', path: 'src/a.js', lang: 'javascript',
    hash: 'sha256:x', rev: 1, status: 'indexed', doc: null,
    imports: imports || [], exports: [], symbols,
  };
}

const META = { rev: 48, sha: '9f8e7d6' };

function runTests() {
  console.log('\n=== Testing graph/history.js ===\n');
  let passed = 0;
  let failed = 0;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hist-')), 'graph');

  if (test('detects an added symbol', () => {
    const events = history.diffShards(shard([]), shard([{ name: 'f', kind: 'function', signature: '()' }]), META);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].op, 'symbol.added');
    assert.strictEqual(events[0].symbol, 'f');
    assert.strictEqual(events[0].rev, 48);
    assert.strictEqual(events[0].decision, null);
  })) passed++; else failed++;

  if (test('detects a removed symbol', () => {
    const events = history.diffShards(shard([{ name: 'f', kind: 'function', signature: '()' }]), shard([]), META);
    assert.strictEqual(events[0].op, 'symbol.removed');
  })) passed++; else failed++;

  if (test('detects a changed signature with from and to', () => {
    const before = shard([{ name: 'f', kind: 'function', signature: '(a)' }]);
    const after = shard([{ name: 'f', kind: 'function', signature: '(a, b)' }]);
    const events = history.diffShards(before, after, META);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].op, 'signature.changed');
    assert.strictEqual(events[0].from, '(a)');
    assert.strictEqual(events[0].to, '(a, b)');
  })) passed++; else failed++;

  if (test('emits nothing when nothing changed', () => {
    const s = shard([{ name: 'f', kind: 'function', signature: '()' }]);
    assert.strictEqual(history.diffShards(s, s, META).length, 0);
  })) passed++; else failed++;

  if (test('detects file added and removed', () => {
    assert.strictEqual(history.diffShards(null, shard([]), META)[0].op, 'file.added');
    assert.strictEqual(history.diffShards(shard([]), null, META)[0].op, 'file.removed');
  })) passed++; else failed++;

  if (test('detects edge changes', () => {
    const before = shard([], []);
    const after = shard([], [{ from: './b', resolved: 'src/b.js', symbols: [], line: 1, external: false }]);
    const events = history.diffShards(before, after, META);
    assert.ok(events.some(e => e.op === 'edge.added' && e.to === 'src/b.js'));
  })) passed++; else failed++;

  if (test('appends and reads back events, filtered by symbol', () => {
    history.appendEvents(dir, history.diffShards(shard([]), shard([{ name: 'g', kind: 'function', signature: '()' }]), META));
    history.appendEvents(dir, history.diffShards(shard([]), shard([{ name: 'h', kind: 'function', signature: '()' }]), META));
    assert.strictEqual(history.readEvents(dir).length, 2);
    assert.strictEqual(history.readEvents(dir, { symbol: 'g' }).length, 1);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

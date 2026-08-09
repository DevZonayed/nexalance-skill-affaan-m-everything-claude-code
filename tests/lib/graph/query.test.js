/**
 * Tests for scripts/lib/graph/query.js — including the fail-closed staleness contract.
 *
 * Run with: node tests/lib/graph/query.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const query = require('../../../scripts/lib/graph/query');

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-q-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'config.js'),
    '/** Config helpers. */\nfunction parseConfig(p) { return p; }\n');
  fs.writeFileSync(path.join(root, 'src', 'main.js'),
    "const { parseConfig } = require('./config');\nfunction main() { return parseConfig('a'); }\n");
  return root;
}

async function runTests() {
  console.log('\n=== Testing graph/query.js ===\n');
  let passed = 0;
  let failed = 0;
  const repo = makeRepo();

  if (await asyncTest('build indexes the repo', async () => {
    const result = await query.build(repo);
    assert.ok(result.counts.files >= 2, `files=${result.counts.files}`);
    assert.ok(result.counts.symbols >= 2);
  })) passed++; else failed++;

  if (await asyncTest('find returns 0 and a located symbol', async () => {
    const r = await query.find(repo, 'parseConfig');
    assert.strictEqual(r.code, query.EXIT.ANSWERED);
    assert.strictEqual(r.results[0].path, 'src/config.js');
    assert.strictEqual(r.results[0].line, 2);
  })) passed++; else failed++;

  if (await asyncTest('find returns 1 (definitively absent) for a real miss', async () => {
    const r = await query.find(repo, 'noSuchSymbol');
    assert.strictEqual(r.code, query.EXIT.ABSENT);
    assert.strictEqual(r.results.length, 0);
  })) passed++; else failed++;

  // The core safety property.
  if (await asyncTest('STALENESS: edit behind the index, find self-heals and never lies', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'config.js'),
      '/** Config helpers. */\nfunction parseConfig(p) { return p; }\nfunction renamedLater(q) { return q; }\n');
    const r = await query.find(repo, 'renamedLater');
    assert.strictEqual(r.code, query.EXIT.ANSWERED, 'should find the newly added symbol');
    assert.strictEqual(r.results[0].line, 3);
  })) passed++; else failed++;

  if (await asyncTest('STALENESS: deleting a symbol behind the index yields ABSENT not a stale hit', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'config.js'), '/** Config helpers. */\n');
    const r = await query.find(repo, 'parseConfig');
    assert.strictEqual(r.code, query.EXIT.ABSENT, `expected ABSENT, got ${r.code}`);
  })) passed++; else failed++;

  if (await asyncTest('deps reports forward and reverse edges', async () => {
    await query.build(repo);
    const forward = await query.deps(repo, 'src/main.js');
    assert.ok(forward.direct.includes('src/config.js'));
    const reverse = await query.deps(repo, 'src/config.js', { reverse: true });
    assert.ok(reverse.reverse.includes('src/main.js'));
  })) passed++; else failed++;

  if (await asyncTest('list on a heuristic kind never returns ABSENT', async () => {
    const r = await query.list(repo, 'http-route');
    assert.strictEqual(r.heuristic, true);
    assert.notStrictEqual(r.code, query.EXIT.ABSENT);
    assert.strictEqual(r.code, query.EXIT.NOT_INDEXED);
  })) passed++; else failed++;

  if (await asyncTest('list on a structural kind with no hits returns ABSENT', async () => {
    const r = await query.list(repo, 'enum');
    assert.strictEqual(r.heuristic, false);
    assert.strictEqual(r.code, query.EXIT.ABSENT);
  })) passed++; else failed++;

  if (await asyncTest('a missing index returns UNAVAILABLE, never a guess', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-empty-'));
    const r = await query.find(empty, 'anything');
    assert.strictEqual(r.code, query.EXIT.UNAVAILABLE);
    fs.rmSync(empty, { recursive: true, force: true });
  })) passed++; else failed++;

  if (await asyncTest('status emits a one-line summary', async () => {
    const r = await query.status(repo);
    assert.strictEqual(r.code, query.EXIT.ANSWERED);
    assert.ok(/graph: \d+ files, \d+ symbols/.test(r.line), `got: ${r.line}`);
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

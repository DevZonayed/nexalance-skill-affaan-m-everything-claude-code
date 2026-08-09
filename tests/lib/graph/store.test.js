/**
 * Tests for scripts/lib/graph/store.js
 *
 * Run with: node tests/lib/graph/store.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../../scripts/lib/graph/store');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-graph-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'config.js'),
    '/** Config helpers. */\nfunction parseConfig(p) { return p; }\nmodule.exports = { parseConfig };\n'
  );
  fs.writeFileSync(
    path.join(root, 'src', 'main.js'),
    "const { parseConfig } = require('./config');\nfunction main() { return parseConfig('a'); }\n"
  );
  return root;
}

async function runTests() {
  console.log('\n=== Testing graph/store.js ===\n');
  let passed = 0;
  let failed = 0;
  const repo = makeRepo();
  const dir = store.graphDir(repo);

  if (test('hashContent is stable and prefixed', () => {
    const a = store.hashContent('hello');
    assert.ok(a.startsWith('sha256:'));
    assert.strictEqual(a, store.hashContent('hello'));
    assert.notStrictEqual(a, store.hashContent('hello '));
  })) passed++; else failed++;

  if (test('shardPath stays inside the graph dir and is stable', () => {
    const p1 = store.shardPath(dir, 'src/config.js');
    const p2 = store.shardPath(dir, 'src/config.js');
    assert.strictEqual(p1, p2);
    assert.ok(p1.startsWith(path.join(dir, 'files')));
    assert.notStrictEqual(p1, store.shardPath(dir, 'src/main.js'));
  })) passed++; else failed++;

  if (await asyncTest('buildShard produces a valid v1 shard', async () => {
    const shard = await store.buildShard(repo, 'src/config.js', 'javascript', 1);
    assert.strictEqual(shard.schema, 'ecc.graph.file.v1');
    assert.strictEqual(shard.path, 'src/config.js');
    assert.strictEqual(shard.status, 'indexed');
    assert.ok(shard.hash.startsWith('sha256:'));
    assert.strictEqual(shard.doc, 'Config helpers.');
    assert.ok(shard.symbols.some(s => s.name === 'parseConfig'));
  })) passed++; else failed++;

  if (await asyncTest('write then read round-trips a shard', async () => {
    const shard = await store.buildShard(repo, 'src/config.js', 'javascript', 1);
    store.writeShard(dir, shard);
    const back = store.readShard(dir, 'src/config.js');
    assert.deepStrictEqual(back, shard);
  })) passed++; else failed++;

  if (test('readShard returns null when absent', () => {
    assert.strictEqual(store.readShard(dir, 'src/nope.js'), null);
  })) passed++; else failed++;

  if (await asyncTest('a syntactically broken file yields parse_error, not a throw', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'broken.py'), 'def (((\n');
    const shard = await store.buildShard(repo, 'src/broken.py', 'python', 1);
    assert.ok(['indexed', 'parse_error'].includes(shard.status));
    assert.ok(Array.isArray(shard.symbols));
  })) passed++; else failed++;

  if (test('resolveImport resolves a relative specifier', () => {
    assert.strictEqual(store.resolveImport(repo, 'src/main.js', './config'), 'src/config.js');
    assert.strictEqual(store.resolveImport(repo, 'src/main.js', 'node:fs'), null);
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

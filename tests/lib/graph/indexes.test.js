/**
 * Tests for derived indexes and manifest in scripts/lib/graph/store.js
 *
 * Run with: node tests/lib/graph/indexes.test.js
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

const SHARDS = [
  {
    schema: 'ecc.graph.file.v1', path: 'src/config.js', lang: 'javascript',
    hash: 'sha256:a', rev: 1, status: 'indexed', doc: null,
    imports: [], exports: ['parseConfig'],
    symbols: [{ name: 'parseConfig', kind: 'function', line: 42, exported: true, calls: [] }],
  },
  {
    schema: 'ecc.graph.file.v1', path: 'src/main.js', lang: 'javascript',
    hash: 'sha256:b', rev: 1, status: 'indexed', doc: null,
    imports: [{ from: './config', resolved: 'src/config.js', symbols: ['parseConfig'], line: 1, external: false }],
    exports: ['main'],
    symbols: [{ name: 'main', kind: 'function', line: 3, exported: true, calls: ['parseConfig'] }],
  },
];

function runTests() {
  console.log('\n=== Testing graph indexes and manifest ===\n');
  let passed = 0;
  let failed = 0;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-idx-')), 'graph');

  const indexes = store.buildIndexes(SHARDS);

  if (test('symbols index maps a name to a LIST of refs', () => {
    const refs = indexes.symbols.symbols.parseConfig;
    assert.ok(Array.isArray(refs), 'expected an array');
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].path, 'src/config.js');
    assert.strictEqual(refs[0].line, 42);
  })) passed++; else failed++;

  if (test('kinds index groups by kind', () => {
    assert.strictEqual(indexes.kinds.kinds.function.length, 2);
  })) passed++; else failed++;

  if (test('edges index precomputes reverse edges', () => {
    assert.deepStrictEqual(indexes.edges.out['src/main.js'], ['src/config.js']);
    assert.deepStrictEqual(indexes.edges.in['src/config.js'], ['src/main.js']);
  })) passed++; else failed++;

  if (test('indexes round-trip through disk', () => {
    store.writeIndexes(dir, indexes);
    const back = store.readIndex(dir, 'symbols');
    assert.deepStrictEqual(back, indexes.symbols);
  })) passed++; else failed++;

  if (test('readIndex returns null when missing', () => {
    assert.strictEqual(store.readIndex(path.join(dir, 'nope'), 'symbols'), null);
  })) passed++; else failed++;

  if (test('manifest reports counts and unindexed coverage', () => {
    const manifest = store.buildManifest({
      rev: 1, gitSha: 'a1b2c3d',
      languages: [{ lang: 'javascript', files: 2 }],
      entrypoints: ['src/main.js'],
      shards: SHARDS,
      unsupportedCount: 2848,
    });
    assert.strictEqual(manifest.schema, 'ecc.graph.manifest.v1');
    assert.strictEqual(manifest.counts.files, 2);
    assert.strictEqual(manifest.counts.symbols, 2);
    assert.strictEqual(manifest.counts.edges, 1);
    assert.strictEqual(manifest.unindexed.unsupported, 2848);
    assert.strictEqual(manifest.unindexed.parse_error, 0);
    store.writeManifest(dir, manifest);
    assert.deepStrictEqual(store.readManifest(dir), manifest);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

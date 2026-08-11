/**
 * Tests for the ecc graph CLI.
 *
 * Run with: node tests/graph-cli.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'graph.js');

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

function run(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo, encoding: 'utf8', env: Object.assign({}, process.env, { ECC_GRAPH_ROOT: repo }),
  });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cli-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'config.js'),
    '/** Config helpers. */\nfunction parseConfig(p) { return p; }\n');
  return root;
}

function runTests() {
  console.log('\n=== Testing ecc graph CLI ===\n');
  let passed = 0;
  let failed = 0;
  const repo = makeRepo();

  if (test('build exits 0 and reports counts', () => {
    const r = run(repo, ['build']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/files/.test(r.stdout), r.stdout);
  })) passed++; else failed++;

  if (test('find exits 0 and prints a terse located line', () => {
    const r = run(repo, ['find', 'parseConfig']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/src\/config\.js:2/.test(r.stdout), r.stdout);
    assert.ok(r.stdout.length < 400, `output too large: ${r.stdout.length} chars`);
  })) passed++; else failed++;

  if (test('find exits 1 for a definitively absent symbol', () => {
    assert.strictEqual(run(repo, ['find', 'nope']).status, 1);
  })) passed++; else failed++;

  if (test('--json emits parseable JSON', () => {
    const r = run(repo, ['find', 'parseConfig', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.results[0].path, 'src/config.js');
  })) passed++; else failed++;

  if (test('file prints a compact summary', () => {
    const r = run(repo, ['file', 'src/config.js']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/Config helpers\./.test(r.stdout), r.stdout);
    assert.ok(r.stdout.length < 800, `output too large: ${r.stdout.length} chars`);
  })) passed++; else failed++;

  if (test('an unknown verb exits 2 with usage', () => {
    const r = run(repo, ['frobnicate']);
    assert.strictEqual(r.status, 2);
    assert.ok(/Usage/i.test(r.stdout + r.stderr));
  })) passed++; else failed++;

  if (test('querying without an index exits 2, never guesses', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-noidx-'));
    const r = run(empty, ['find', 'x']);
    assert.strictEqual(r.status, 2);
    fs.rmSync(empty, { recursive: true, force: true });
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

/**
 * Tests for scripts/hooks/graph-update.js
 *
 * Run with: node tests/hooks/graph-update.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'graph-update.js');

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

function runHook(input, cwd) {
  return spawnSync(process.execPath, [HOOK], {
    input, encoding: 'utf8', cwd,
    env: Object.assign({}, process.env, { ECC_GRAPH_ROOT: cwd }),
  });
}

function runTests() {
  console.log('\n=== Testing hooks/graph-update.js ===\n');
  let passed = 0;
  let failed = 0;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hook-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function a() {}\n');

  if (test('exits 0 on malformed JSON', () => {
    assert.strictEqual(runHook('not json', repo).status, 0);
  })) passed++; else failed++;

  if (test('exits 0 on empty input', () => {
    assert.strictEqual(runHook('', repo).status, 0);
  })) passed++; else failed++;

  if (test('exits 0 when the file is an unsupported language', () => {
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'README.md') } });
    assert.strictEqual(runHook(input, repo).status, 0);
  })) passed++; else failed++;

  if (test('exits 0 and updates the shard for a supported edit', () => {
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.js') } });
    const r = runHook(input, repo);
    assert.strictEqual(r.status, 0, r.stderr);
    const shardDir = path.join(repo, '.ecc', 'graph', 'files');
    assert.ok(fs.existsSync(shardDir), 'shard directory was not created');
  })) passed++; else failed++;

  if (test('exits 0 when the target file does not exist', () => {
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'gone.js') } });
    assert.strictEqual(runHook(input, repo).status, 0);
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

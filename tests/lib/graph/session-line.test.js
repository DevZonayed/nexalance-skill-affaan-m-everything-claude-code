/**
 * Tests that the SessionStart graph line stays within its token budget.
 *
 * Run with: node tests/lib/graph/session-line.test.js
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

async function runTests() {
  console.log('\n=== Testing SessionStart graph line ===\n');
  let passed = 0;
  let failed = 0;

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-line-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function a() {}\n');

  if (await asyncTest('emits nothing when no index exists', async () => {
    const r = await query.status(repo);
    assert.strictEqual(r.code, query.EXIT.UNAVAILABLE);
    assert.strictEqual(r.line, '');
  })) passed++; else failed++;

  if (await asyncTest('line stays under the 240-character budget', async () => {
    await query.build(repo);
    const r = await query.status(repo);
    assert.strictEqual(r.code, query.EXIT.ANSWERED);
    assert.ok(r.line.length < 240, `line was ${r.line.length} chars: ${r.line}`);
    assert.ok(r.line.includes('ecc graph find'), 'must tell the agent how to query');
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

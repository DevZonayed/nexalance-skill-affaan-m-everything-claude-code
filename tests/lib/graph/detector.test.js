/**
 * Tests for scripts/lib/graph/detector.js
 *
 * Run with: node tests/lib/graph/detector.test.js
 */

const assert = require('assert');
const path = require('path');
const detector = require('../../../scripts/lib/graph/detector');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'graph', 'sample-repo');

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

function runTests() {
  console.log('\n=== Testing graph/detector.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('maps extensions to languages', () => {
    assert.strictEqual(detector.languageForFile('src/a.ts'), 'typescript');
    assert.strictEqual(detector.languageForFile('src/a.tsx'), 'tsx');
    assert.strictEqual(detector.languageForFile('src/a.js'), 'javascript');
    assert.strictEqual(detector.languageForFile('src/a.py'), 'python');
    assert.strictEqual(detector.languageForFile('src/a.rs'), 'rust');
    assert.strictEqual(detector.languageForFile('src/a.go'), 'go');
  })) passed++; else failed++;

  if (test('returns null for unsupported extensions', () => {
    assert.strictEqual(detector.languageForFile('README.md'), null);
    assert.strictEqual(detector.languageForFile('noext'), null);
  })) passed++; else failed++;

  if (test('lists only supported source files', () => {
    const files = detector.listSourceFiles(FIXTURE).map(f => f.path).sort();
    assert.deepStrictEqual(files, ['src/config.js', 'src/main.js']);
  })) passed++; else failed++;

  if (test('detects languages with counts', () => {
    const langs = detector.detectLanguages(FIXTURE);
    const js = langs.find(l => l.lang === 'javascript');
    assert.ok(js, 'javascript not detected');
    assert.strictEqual(js.files, 2);
  })) passed++; else failed++;

  if (test('finds the package.json main entrypoint', () => {
    assert.ok(detector.findEntrypoints(FIXTURE).includes('src/main.js'));
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

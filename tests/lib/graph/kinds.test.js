/**
 * Tests for scripts/lib/graph/kinds.js
 *
 * Run with: node tests/lib/graph/kinds.test.js
 */

const assert = require('assert');
const kinds = require('../../../scripts/lib/graph/kinds');

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

function sym(over) {
  return Object.assign(
    { name: 'x', kind: 'function', line: 1, end_line: 2, signature: '()', doc: null, exported: true, calls: [] },
    over
  );
}

function runTests() {
  console.log('\n=== Testing graph/kinds.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('classifies structural and heuristic tiers', () => {
    assert.strictEqual(kinds.isHeuristic('function'), false);
    assert.strictEqual(kinds.isHeuristic('http-route'), true);
    assert.strictEqual(kinds.isHeuristic('react-hook'), true);
  })) passed++; else failed++;

  if (test('detects a react hook by naming convention', () => {
    const r = kinds.refineKind(sym({ name: 'useAuth' }), { lang: 'typescript', relPath: 'src/useAuth.ts', source: '' });
    assert.strictEqual(r.kind, 'react-hook');
  })) passed++; else failed++;

  if (test('detects a test by file path', () => {
    const r = kinds.refineKind(sym({ name: 'runs' }), { lang: 'typescript', relPath: 'tests/a.test.js', source: '' });
    assert.strictEqual(r.kind, 'test');
  })) passed++; else failed++;

  // Regression: a file-wide #[test] scan tagged every symbol in the file as a test.
  if (test('does NOT tag a rust type as a test just because the file has tests', () => {
    const source = [
      'pub enum PaneLayout {',   // line 1 — the symbol under test
      '    Split,',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    #[test]',
      '    fn works() {}',
      '}',
    ].join('\n');
    const r = kinds.refineKind(
      sym({ name: 'PaneLayout', kind: 'enum', line: 1 }),
      { lang: 'rust', relPath: 'ecc2/src/config/mod.rs', source }
    );
    assert.strictEqual(r.kind, 'enum', `expected enum, got ${r.kind}`);
  })) passed++; else failed++;

  if (test('detects a rust test by attribute', () => {
    // `fn works()` is on line 2; the #[test] attribute directly precedes it.
    const r = kinds.refineKind(
      sym({ name: 'works', line: 2 }),
      { lang: 'rust', relPath: 'src/lib.rs', source: '#[test]\nfn works() {}' }
    );
    assert.strictEqual(r.kind, 'test');
  })) passed++; else failed++;

  if (test('detects an error type by name suffix', () => {
    const r = kinds.refineKind(sym({ name: 'ConfigError', kind: 'class' }), { lang: 'typescript', relPath: 'src/a.ts', source: '' });
    assert.strictEqual(r.kind, 'error-type');
  })) passed++; else failed++;

  if (test('leaves an ordinary function structural', () => {
    const r = kinds.refineKind(sym({ name: 'parseConfig' }), { lang: 'typescript', relPath: 'src/config.ts', source: '' });
    assert.strictEqual(r.kind, 'function');
    assert.strictEqual(kinds.isHeuristic(r.kind), false);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

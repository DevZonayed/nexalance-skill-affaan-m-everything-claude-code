/**
 * Tests for scripts/lib/graph/grammars.js
 *
 * Run with: node tests/lib/graph/grammars.test.js
 */

const assert = require('assert');
const grammars = require('../../../scripts/lib/graph/grammars');

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

async function runTests() {
  console.log('\n=== Testing graph/grammars.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('supportedLanguages includes the four v1 languages', () => {
    const langs = grammars.supportedLanguages();
    for (const l of ['typescript', 'python', 'rust', 'go']) {
      assert.ok(langs.includes(l), `missing ${l}`);
    }
  })) passed++; else failed++;

  for (const lang of ['typescript', 'python', 'rust', 'go']) {
    if (await asyncTest(`loads ${lang} grammar at ABI 14`, async () => {
      const L = await grammars.loadGrammar(lang);
      assert.strictEqual(L.version, 14, `expected ABI 14, got ${L.version}`);
    })) passed++; else failed++;
  }

  if (await asyncTest('parser extracts a function name from typescript', async () => {
    const parser = await grammars.getParser('typescript');
    const tree = parser.parse('export function parseConfig(p: string): C { return load(p); }');
    const L = await grammars.loadGrammar('typescript');
    const q = L.query('(function_declaration name: (identifier) @n)');
    const names = q.captures(tree.rootNode).map(c => c.node.text);
    assert.deepStrictEqual(names, ['parseConfig']);
  })) passed++; else failed++;

  if (await asyncTest('rejects an unsupported language', async () => {
    await assert.rejects(
      () => grammars.loadGrammar('cobol'),
      /Unsupported language: cobol/
    );
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

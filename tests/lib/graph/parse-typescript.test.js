/**
 * Tests for scripts/lib/graph/parse/typescript.js
 *
 * Run with: node tests/lib/graph/parse-typescript.test.js
 */

const assert = require('assert');
const { parseSource } = require('../../../scripts/lib/graph/parse');

const SRC = `/** Configuration loading and validation. */
import { loadEnv } from './env';
import fs from 'node:fs';

/**
 * Parse a config file and validate required keys.
 */
export function parseConfig(filePath, opts) {
  loadEnv();
  return validate(filePath);
}

export class ConfigError extends Error {}

function helper() { return 1; }
`;

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
  console.log('\n=== Testing graph/parse/typescript.js ===\n');
  let passed = 0;
  let failed = 0;
  const result = await parseSource('typescript', SRC);

  if (await asyncTest('extracts the leading file doc comment', async () => {
    assert.strictEqual(result.doc, 'Configuration loading and validation.');
  })) passed++; else failed++;

  if (await asyncTest('extracts named function with 1-indexed line', async () => {
    const fn = result.symbols.find(s => s.name === 'parseConfig');
    assert.ok(fn, 'parseConfig not found');
    assert.strictEqual(fn.kind, 'function');
    assert.strictEqual(fn.line, 8);
    assert.strictEqual(fn.exported, true);
  })) passed++; else failed++;

  if (await asyncTest('attaches the preceding doc comment to the symbol', async () => {
    const fn = result.symbols.find(s => s.name === 'parseConfig');
    assert.strictEqual(fn.doc, 'Parse a config file and validate required keys.');
  })) passed++; else failed++;

  if (await asyncTest('records the call graph for a symbol', async () => {
    const fn = result.symbols.find(s => s.name === 'parseConfig');
    assert.ok(fn.calls.includes('loadEnv'), `calls was ${JSON.stringify(fn.calls)}`);
    assert.ok(fn.calls.includes('validate'));
  })) passed++; else failed++;

  if (await asyncTest('extracts an exported class', async () => {
    const cls = result.symbols.find(s => s.name === 'ConfigError');
    assert.ok(cls, 'ConfigError not found');
    assert.strictEqual(cls.kind, 'class');
    assert.strictEqual(cls.exported, true);
  })) passed++; else failed++;

  if (await asyncTest('marks a non-exported symbol as not exported', async () => {
    const fn = result.symbols.find(s => s.name === 'helper');
    assert.strictEqual(fn.exported, false);
  })) passed++; else failed++;

  if (await asyncTest('extracts imports and flags external modules', async () => {
    const env = result.imports.find(i => i.from === './env');
    assert.ok(env, 'relative import missing');
    assert.deepStrictEqual(env.symbols, ['loadEnv']);
    assert.strictEqual(env.external, false);
    const nodeFs = result.imports.find(i => i.from === 'node:fs');
    assert.strictEqual(nodeFs.external, true);
  })) passed++; else failed++;

  if (await asyncTest('rejects an unsupported language', async () => {
    await assert.rejects(() => parseSource('cobol', 'x'), /Unsupported language: cobol/);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

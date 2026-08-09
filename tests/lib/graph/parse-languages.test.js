/**
 * Tests for python, rust and go extraction.
 *
 * Run with: node tests/lib/graph/parse-languages.test.js
 */

const assert = require('assert');
const { parseSource } = require('../../../scripts/lib/graph/parse');

const PY = `"""Config helpers."""
from .env import load_env

def parse_config(path):
    """Parse a config file."""
    return load_env(path)

class ConfigError(Exception):
    pass
`;

const RS = `use crate::env::load_env;

/// Parse a config file.
pub fn parse_config(path: &str) -> Config {
    load_env(path)
}

pub struct ConfigError;
`;

const GO = `package main

import "fmt"

// ParseConfig parses a config file.
func ParseConfig(path string) Config {
    return load(path)
}
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
  console.log('\n=== Testing graph/parse language coverage ===\n');
  let passed = 0;
  let failed = 0;

  if (await asyncTest('python: function, docstring and class', async () => {
    const r = await parseSource('python', PY);
    const fn = r.symbols.find(s => s.name === 'parse_config');
    assert.ok(fn, 'parse_config not found');
    assert.strictEqual(fn.kind, 'function');
    assert.strictEqual(fn.line, 4);
    assert.strictEqual(fn.doc, 'Parse a config file.');
    assert.ok(r.symbols.some(s => s.name === 'ConfigError' && s.kind === 'class'));
    assert.ok(r.imports.some(i => i.from === '.env'));
  })) passed++; else failed++;

  if (await asyncTest('rust: function, /// doc and struct', async () => {
    const r = await parseSource('rust', RS);
    const fn = r.symbols.find(s => s.name === 'parse_config');
    assert.ok(fn, 'parse_config not found');
    assert.strictEqual(fn.kind, 'function');
    assert.strictEqual(fn.doc, 'Parse a config file.');
    assert.ok(r.symbols.some(s => s.name === 'ConfigError'));
  })) passed++; else failed++;

  if (await asyncTest('go: exported function and preceding comment', async () => {
    const r = await parseSource('go', GO);
    const fn = r.symbols.find(s => s.name === 'ParseConfig');
    assert.ok(fn, 'ParseConfig not found');
    assert.strictEqual(fn.kind, 'function');
    assert.strictEqual(fn.doc, 'ParseConfig parses a config file.');
    assert.strictEqual(fn.exported, true);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

# Code Graph Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, model-free code index so an agent can answer "does this symbol exist, what does this file contain, what breaks if I change it" for ~50 tokens instead of ~1,200.

**Architecture:** Four modules in strict dependency order — `detector` (which languages, which files), `parser` (WASM tree-sitter → symbols/imports/docs), `store` (sharded JSON on disk, content hashing, derived indexes, history events), `query` (CLI verbs, fail-closed staleness, exit-code contract). A `PostToolUse` hook keeps the index warm; a query-time content-hash check guarantees correctness even when files change outside the agent's write path.

**Tech Stack:** Node >= 18, CommonJS, `web-tree-sitter@0.22.6`, `tree-sitter-wasms@0.1.13`, existing `scripts/lib/atomic-write.js` and `scripts/lib/utils.js`.

**Spec:** `docs/superpowers/specs/2026-08-09-code-graph-memory-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=18`. CommonJS only (`require`/`module.exports`). No TypeScript, no ESM, no transpilation.
- **Pinned dependency pair, verified 2026-08-09:** `web-tree-sitter@0.22.6` + `tree-sitter-wasms@0.1.13`, grammar ABI 14. `web-tree-sitter@0.26.x` fails on these grammars with `getDylinkMetadata`. Never upgrade one without the other.
- web-tree-sitter 0.22 API: `const Parser = require('web-tree-sitter')`, `await Parser.init()`, `await Parser.Language.load(wasmPath)`, `parser.setLanguage(L)`, `L.query(src)`, `q.captures(node) -> [{name, node}]`.
- File naming: lowercase with hyphens. Tests mirror `scripts/` under `tests/`, named `*.test.js`.
- Test style follows `tests/lib/utils.test.js`: `require('assert')`, a local `test(name, fn)` helper printing `✓`/`✗`, a pass/fail tally, and `process.exit(failed > 0 ? 1 : 0)`.
- Run the suite with `node tests/run-all.js`; a single file with `node tests/<path>.test.js`.
- Hooks must **always** `exit 0`. Log to stderr with a `[GraphUpdate]` prefix. Never block an edit.
- All shard/index writes go through `writeFileAtomic` from `scripts/lib/atomic-write.js`.
- `.ecc/graph/` is generated and gitignored. Deleting it must lose nothing unrecoverable.
- Query output is a token budget. Default output terse; verbosity opt-in via flags.
- Lint before commit: `npx eslint scripts/ tests/` and `npx markdownlint-cli '**/*.md' --ignore node_modules`.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `scripts/lib/graph/grammars.js` | Load and cache WASM grammars |
| `scripts/lib/graph/detector.js` | Languages present, file→language, entrypoints |
| `scripts/lib/graph/parse/typescript.js` | TS/JS/TSX extraction |
| `scripts/lib/graph/parse/python.js` | Python extraction |
| `scripts/lib/graph/parse/rust.js` | Rust extraction |
| `scripts/lib/graph/parse/go.js` | Go extraction |
| `scripts/lib/graph/parse/index.js` | Dispatch to a language parser |
| `scripts/lib/graph/kinds.js` | Symbol taxonomy, structural vs heuristic tiers |
| `scripts/lib/graph/store.js` | Shards, hashing, derived indexes, manifest |
| `scripts/lib/graph/history.js` | Shard diffing, event log |
| `scripts/lib/graph/query.js` | Verb implementations, staleness heal, exit codes |
| `scripts/lib/graph/format.js` | Terse human output |
| `scripts/graph.js` | `ecc graph` CLI entry |
| `scripts/hooks/graph-update.js` | PostToolUse incremental update |
| `skills/code-graph/SKILL.md` | Teaches the agent when to query |

**Modified:** `package.json` (deps + `files`), `scripts/ecc.js` (COMMANDS registry at line 9, PRIMARY_COMMANDS at line 104), `hooks/hooks.json` (PostToolUse), `.gitignore`.

**Tests:** one `tests/lib/graph/<module>.test.js` per module, plus `tests/hooks/graph-update.test.js` and fixtures under `tests/fixtures/graph/`.

---

### Task 1: Grammar runtime and loader

Proves the pinned toolchain works inside the repo before anything is built on it.

**Files:**
- Modify: `package.json` (dependencies)
- Create: `scripts/lib/graph/grammars.js`
- Test: `tests/lib/graph/grammars.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `supportedLanguages(): string[]` → `['typescript','tsx','javascript','python','rust','go']`
  - `async loadGrammar(lang: string): Language` — throws `Error` with message `Unsupported language: <lang>` for unknown input
  - `async getParser(lang: string): Parser` — cached per language

- [ ] **Step 1: Add the pinned dependencies**

```bash
npm install --save-exact web-tree-sitter@0.22.6 tree-sitter-wasms@0.1.13
```

Then confirm `package.json` shows exactly `"web-tree-sitter": "0.22.6"` and `"tree-sitter-wasms": "0.1.13"` (no `^`).

- [ ] **Step 2: Write the failing test**

Create `tests/lib/graph/grammars.test.js`:

```js
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
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node tests/lib/graph/grammars.test.js`
Expected: FAIL — `Cannot find module '../../../scripts/lib/graph/grammars'`

- [ ] **Step 4: Implement the loader**

Create `scripts/lib/graph/grammars.js`:

```js
'use strict';

const path = require('path');
const Parser = require('web-tree-sitter');

// Maps our language id to the tree-sitter-wasms grammar filename stem.
const GRAMMAR_FILES = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  rust: 'tree-sitter-rust',
  go: 'tree-sitter-go',
};

const languageCache = new Map();
const parserCache = new Map();
let initPromise = null;

function supportedLanguages() {
  return Object.keys(GRAMMAR_FILES);
}

function grammarPath(lang) {
  const stem = GRAMMAR_FILES[lang];
  const pkgDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  return path.join(pkgDir, 'out', `${stem}.wasm`);
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

async function loadGrammar(lang) {
  if (!GRAMMAR_FILES[lang]) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  if (languageCache.has(lang)) {
    return languageCache.get(lang);
  }
  await ensureInit();
  const language = await Parser.Language.load(grammarPath(lang));
  languageCache.set(lang, language);
  return language;
}

async function getParser(lang) {
  if (parserCache.has(lang)) {
    return parserCache.get(lang);
  }
  const language = await loadGrammar(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

module.exports = {
  supportedLanguages,
  loadGrammar,
  getParser,
};
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node tests/lib/graph/grammars.test.js`
Expected: PASS, 7 passed / 0 failed.

If any grammar reports a version other than 14, **stop** — the dependency pair has drifted. Do not proceed; re-pin per the Global Constraints.

- [ ] **Step 6: Do NOT touch the `files` array yet**

`tests/scripts/npm-publish-surface.test.js` derives the expected `files` array from the
actual module graph and fails on any entry that is not yet reachable from a published
entry point. At this task neither `scripts/graph.js` (does not exist) nor
`scripts/lib/graph/` (not yet reachable) may be listed. Both are added in Task 10,
once `scripts/graph.js` exists and is registered in `scripts/ecc.js`.

Verify the surface is still green before committing:

```bash
node tests/scripts/npm-publish-surface.test.js
```

Expected: `Failed: 0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/lib/graph/grammars.js tests/lib/graph/grammars.test.js
git commit -m "feat(graph): add pinned WASM tree-sitter grammar loader"
```

---

### Task 2: Language detector

**Files:**
- Create: `scripts/lib/graph/detector.js`
- Test: `tests/lib/graph/detector.test.js`
- Create fixtures: `tests/fixtures/graph/sample-repo/`

**Interfaces:**
- Consumes: `supportedLanguages()` from Task 1
- Produces:
  - `languageForFile(relPath: string): string|null` — extension → language id
  - `listSourceFiles(repoRoot: string): Array<{path: string, lang: string}>` — repo-relative,
    forward-slash paths for the working tree: tracked plus untracked-but-not-ignored
    (`git ls-files --cached --others --exclude-standard`). Outside a git repository it falls
    back to a filesystem walk, which later tasks depend on because their tests build fixture
    repos with `fs.mkdtempSync` and never run `git init`.
  - `findEntrypoints(repoRoot: string): string[]`
  - `detectLanguages(repoRoot: string): Array<{lang: string, files: number}>`

- [ ] **Step 1: Create the fixture repo**

```bash
mkdir -p tests/fixtures/graph/sample-repo/src
```

Create `tests/fixtures/graph/sample-repo/package.json`:

```json
{ "name": "sample", "version": "1.0.0", "main": "src/main.js" }
```

Create `tests/fixtures/graph/sample-repo/src/main.js`:

```js
const { parseConfig } = require('./config');

function main() {
  return parseConfig('./app.json');
}

module.exports = { main };
```

Create `tests/fixtures/graph/sample-repo/src/config.js`:

```js
/** Configuration loading and validation. */

/**
 * Parse a config file and validate required keys.
 */
function parseConfig(filePath) {
  return JSON.parse(filePath);
}

class ConfigError extends Error {}

module.exports = { parseConfig, ConfigError };
```

Create `tests/fixtures/graph/sample-repo/README.md` with the single line `# sample` (an unsupported file, to prove it is excluded).

- [ ] **Step 2: Write the failing test**

Create `tests/lib/graph/detector.test.js`:

```js
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
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node tests/lib/graph/detector.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the detector**

Create `scripts/lib/graph/detector.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXTENSIONS = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target',
  '__pycache__', '.venv', 'venv', 'vendor', '.ecc',
]);

function languageForFile(relPath) {
  return EXTENSIONS[path.extname(String(relPath || '')).toLowerCase()] || null;
}

function walk(dir, repoRoot, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, repoRoot, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      const lang = languageForFile(rel);
      if (lang) acc.push({ path: rel, lang });
    }
  }
  return acc;
}

// Working-tree files git would keep: tracked plus untracked-but-not-ignored.
// Returns null when repoRoot is not a git repository.
function gitListFiles(repoRoot) {
  const result = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' }
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\n').filter(Boolean);
}

function isSkipped(relPath) {
  return relPath.split('/').some(segment => SKIP_DIRS.has(segment));
}

function listSourceFiles(repoRoot) {
  const tracked = gitListFiles(repoRoot);
  if (tracked) {
    const seen = new Set();
    const files = [];
    for (const rel of tracked) {
      if (seen.has(rel) || isSkipped(rel)) continue;
      const lang = languageForFile(rel);
      if (!lang) continue;
      if (!fs.existsSync(path.join(repoRoot, rel))) continue;
      seen.add(rel);
      files.push({ path: rel, lang });
    }
    return files;
  }
  // Not a git repository (temp fixture dirs in tests): fall back to a filesystem walk.
  return walk(repoRoot, repoRoot, []);
}

function detectLanguages(repoRoot) {
  const counts = new Map();
  for (const file of listSourceFiles(repoRoot)) {
    counts.set(file.lang, (counts.get(file.lang) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([lang, files]) => ({ lang, files }))
    .sort((a, b) => b.files - a.files);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findEntrypoints(repoRoot) {
  const found = new Set();

  const pkg = readJson(path.join(repoRoot, 'package.json'));
  if (pkg) {
    if (typeof pkg.main === 'string') found.add(pkg.main.replace(/^\.\//, ''));
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const target of Object.values(pkg.bin)) {
        if (typeof target === 'string') found.add(target.replace(/^\.\//, ''));
      }
    }
  }

  for (const candidate of ['src/main.rs', 'src/lib.rs', 'main.go', 'src/main.py', '__main__.py']) {
    if (fs.existsSync(path.join(repoRoot, candidate))) found.add(candidate);
  }

  return [...found].filter(rel => fs.existsSync(path.join(repoRoot, rel)));
}

module.exports = {
  languageForFile,
  listSourceFiles,
  detectLanguages,
  findEntrypoints,
};
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node tests/lib/graph/detector.test.js`
Expected: PASS, 5 passed / 0 failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/graph/detector.js tests/lib/graph/detector.test.js tests/fixtures/graph/
git commit -m "feat(graph): add language and entrypoint detector"
```

---

### Task 3: TypeScript/JavaScript parser

> **Scope note.** The `import_statement` handling below covers ESM only. This
> repository is CommonJS (see Global Constraints), so `require()` calls must also be
> extracted or no JavaScript file will produce dependency edges and `deps`/`impact`
> will be empty repo-wide. Extend the import walk to handle
> `const { a } = require('x')` and `const x = require('x')` in this task.

**Files:**
- Create: `scripts/lib/graph/parse/typescript.js`
- Create: `scripts/lib/graph/parse/index.js`
- Test: `tests/lib/graph/parse-typescript.test.js`

**Interfaces:**
- Consumes: `getParser(lang)`, `loadGrammar(lang)` from Task 1
- Produces:
  - `async parseSource(lang: string, source: string): {doc: string|null, imports: Import[], exports: string[], symbols: Symbol[]}`
  - `Symbol` = `{name, kind, line, end_line, signature, doc, exported, calls}` — `line` is **1-indexed**
  - `Import` = `{from, resolved, symbols, line, external}` — `resolved` is `null` at parse time; Task 6 fills it
  - From `parse/index.js`: `async parseSource(lang, source)` dispatching by language, throwing `Unsupported language: <lang>` otherwise

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/parse-typescript.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/parse-typescript.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the TS/JS parser**

Create `scripts/lib/graph/parse/typescript.js`:

```js
'use strict';

const { getParser } = require('../grammars');

function cleanDoc(raw) {
  if (!raw) return null;
  const text = raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .replace(/^\/\/+/gm, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || null;
}

// Returns the comment node immediately preceding `node`, if any.
function precedingComment(node) {
  let prev = node.previousNamedSibling;
  if (prev && prev.type === 'export_statement') prev = prev.previousNamedSibling;
  if (prev && prev.type === 'comment') return prev;
  return null;
}

function isExported(node) {
  const parent = node.parent;
  return Boolean(parent && parent.type === 'export_statement');
}

function collectCalls(node) {
  const calls = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'identifier') calls.add(fn.text);
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      stack.push(current.namedChild(i));
    }
  }
  return [...calls];
}

function signatureOf(node) {
  const params = node.childForFieldName('parameters');
  const ret = node.childForFieldName('return_type');
  return `(${params ? params.text.slice(1, -1) : ''})${ret ? ` ${ret.text}` : ''}`;
}

const DECL_KINDS = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

async function parseSource(lang, source) {
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const symbols = [];
  const imports = [];
  const exports = [];

  // File-level doc: a comment that is the very first named node.
  const first = root.namedChild(0);
  const doc = first && first.type === 'comment' ? cleanDoc(first.text) : null;

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();

    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      const from = sourceNode ? sourceNode.text.slice(1, -1) : null;
      if (from) {
        const named = [];
        const clause = node.namedChildren.find(c => c.type === 'import_clause');
        if (clause) {
          const stack2 = [clause];
          while (stack2.length) {
            const c = stack2.pop();
            if (c.type === 'import_specifier') {
              const n = c.childForFieldName('name');
              if (n) named.push(n.text);
            }
            for (let i = 0; i < c.namedChildCount; i++) stack2.push(c.namedChild(i));
          }
        }
        imports.push({
          from,
          resolved: null,
          symbols: named,
          line: node.startPosition.row + 1,
          external: !from.startsWith('.'),
        });
      }
    }

    const kind = DECL_KINDS[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const exported = isExported(node);
        const commentNode = precedingComment(node.parent && node.parent.type === 'export_statement' ? node.parent : node);
        symbols.push({
          name: nameNode.text,
          kind,
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: kind === 'function' ? signatureOf(node) : null,
          doc: cleanDoc(commentNode ? commentNode.text : null),
          exported,
          calls: kind === 'function' ? collectCalls(node) : [],
        });
        if (exported) exports.push(nameNode.text);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      stack.push(node.namedChild(i));
    }
  }

  symbols.sort((a, b) => a.line - b.line);
  return { doc, imports, exports, symbols };
}

module.exports = { parseSource };
```

Create `scripts/lib/graph/parse/index.js`:

```js
'use strict';

const typescript = require('./typescript');

const PARSERS = {
  typescript,
  tsx: typescript,
  javascript: typescript,
};

async function parseSource(lang, source) {
  const parser = PARSERS[lang];
  if (!parser) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  return parser.parseSource(lang, source);
}

module.exports = { parseSource, PARSERS };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/parse-typescript.test.js`
Expected: PASS, 8 passed / 0 failed.

If `doc` extraction fails, print the parse tree with `console.log(tree.rootNode.toString())` inside a scratch script to inspect the real node types before adjusting `precedingComment`. Do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/graph/parse/ tests/lib/graph/parse-typescript.test.js
git commit -m "feat(graph): add typescript and javascript symbol extraction"
```

---

### Task 4: Python, Rust and Go parsers

**Files:**
- Create: `scripts/lib/graph/parse/python.js`, `scripts/lib/graph/parse/rust.js`, `scripts/lib/graph/parse/go.js`
- Modify: `scripts/lib/graph/parse/index.js` (register the three)
- Test: `tests/lib/graph/parse-languages.test.js`

**Interfaces:**
- Consumes: `getParser(lang)` from Task 1; the `Symbol`/`Import` shapes from Task 3
- Produces: same `parseSource(lang, source)` contract as Task 3, for `python`, `rust`, `go`

Each language differs only in node types and doc-comment convention:

| Language | Function node | Class/type node | Doc convention |
|---|---|---|---|
| Python | `function_definition` | `class_definition` | First `string` statement inside the body (docstring) |
| Rust | `function_item` | `struct_item`, `enum_item`, `trait_item`, `impl_item` | Preceding `line_comment` starting `///` |
| Go | `function_declaration`, `method_declaration` | `type_declaration` | Preceding `comment` lines |

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/parse-languages.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/parse-languages.test.js`
Expected: FAIL — `Unsupported language: python`

- [ ] **Step 3: Implement the three parsers**

Create `scripts/lib/graph/parse/python.js`:

```js
'use strict';

const { getParser } = require('../grammars');

function cleanDocstring(node) {
  if (!node) return null;
  const text = node.text.replace(/^[rubf]*("""|'''|"|')/i, '').replace(/("""|'''|"|')$/, '');
  return text.split('\n').map(l => l.trim()).filter(Boolean).join(' ').trim() || null;
}

function bodyDocstring(node) {
  const body = node.childForFieldName('body');
  if (!body) return null;
  const first = body.namedChild(0);
  if (first && first.type === 'expression_statement') {
    const str = first.namedChild(0);
    if (str && str.type === 'string') return cleanDocstring(str);
  }
  return null;
}

function collectCalls(node) {
  const calls = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === 'call') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'identifier') calls.add(fn.text);
    }
    for (let i = 0; i < current.namedChildCount; i++) stack.push(current.namedChild(i));
  }
  return [...calls];
}

async function parseSource(lang, source) {
  const parser = await getParser('python');
  const root = parser.parse(source).rootNode;

  const symbols = [];
  const imports = [];
  const exports = [];

  const first = root.namedChild(0);
  let doc = null;
  if (first && first.type === 'expression_statement') {
    const str = first.namedChild(0);
    if (str && str.type === 'string') doc = cleanDocstring(str);
  }

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();

    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      if (mod) {
        const names = node.namedChildren
          .filter(c => c.type === 'dotted_name' && c !== mod)
          .map(c => c.text);
        imports.push({
          from: mod.text,
          resolved: null,
          symbols: names,
          line: node.startPosition.row + 1,
          external: !mod.text.startsWith('.'),
        });
      }
    }

    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isFn = node.type === 'function_definition';
        const params = node.childForFieldName('parameters');
        symbols.push({
          name: nameNode.text,
          kind: isFn ? 'function' : 'class',
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: isFn && params ? `(${params.text.slice(1, -1)})` : null,
          doc: bodyDocstring(node),
          exported: !nameNode.text.startsWith('_'),
          calls: isFn ? collectCalls(node) : [],
        });
        if (!nameNode.text.startsWith('_')) exports.push(nameNode.text);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
  }

  symbols.sort((a, b) => a.line - b.line);
  return { doc, imports, exports, symbols };
}

module.exports = { parseSource };
```

Create `scripts/lib/graph/parse/rust.js`:

```js
'use strict';

const { getParser } = require('../grammars');

const KINDS = {
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  type_item: 'type',
};

function docFor(node) {
  const lines = [];
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'line_comment' && prev.text.startsWith('///')) {
    lines.unshift(prev.text.replace(/^\/\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }
  return lines.filter(Boolean).join(' ') || null;
}

function collectCalls(node) {
  const calls = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'identifier') calls.add(fn.text);
    }
    for (let i = 0; i < current.namedChildCount; i++) stack.push(current.namedChild(i));
  }
  return [...calls];
}

async function parseSource(lang, source) {
  const parser = await getParser('rust');
  const root = parser.parse(source).rootNode;

  const symbols = [];
  const imports = [];
  const exports = [];

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();

    if (node.type === 'use_declaration') {
      const arg = node.childForFieldName('argument');
      if (arg) {
        imports.push({
          from: arg.text,
          resolved: null,
          symbols: [],
          line: node.startPosition.row + 1,
          external: !/^(crate|self|super)\b/.test(arg.text),
        });
      }
    }

    const kind = KINDS[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const params = node.childForFieldName('parameters');
        const ret = node.childForFieldName('return_type');
        const exported = node.text.trimStart().startsWith('pub');
        symbols.push({
          name: nameNode.text,
          kind,
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: kind === 'function' && params
            ? `(${params.text.slice(1, -1)})${ret ? ` -> ${ret.text}` : ''}`
            : null,
          doc: docFor(node),
          exported,
          calls: kind === 'function' ? collectCalls(node) : [],
        });
        if (exported) exports.push(nameNode.text);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
  }

  symbols.sort((a, b) => a.line - b.line);
  return { doc: null, imports, exports, symbols };
}

module.exports = { parseSource };
```

Create `scripts/lib/graph/parse/go.js`:

```js
'use strict';

const { getParser } = require('../grammars');

function docFor(node) {
  const lines = [];
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'comment' && prev.text.startsWith('//')) {
    lines.unshift(prev.text.replace(/^\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }
  return lines.filter(Boolean).join(' ') || null;
}

function collectCalls(node) {
  const calls = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'identifier') calls.add(fn.text);
    }
    for (let i = 0; i < current.namedChildCount; i++) stack.push(current.namedChild(i));
  }
  return [...calls];
}

async function parseSource(lang, source) {
  const parser = await getParser('go');
  const root = parser.parse(source).rootNode;

  const symbols = [];
  const imports = [];
  const exports = [];

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();

    if (node.type === 'import_spec') {
      const pathNode = node.childForFieldName('path') || node.namedChild(0);
      if (pathNode) {
        const from = pathNode.text.replace(/^"|"$/g, '');
        imports.push({
          from,
          resolved: null,
          symbols: [],
          line: node.startPosition.row + 1,
          external: !from.startsWith('.'),
        });
      }
    }

    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const params = node.childForFieldName('parameters');
        const result = node.childForFieldName('result');
        const exported = /^[A-Z]/.test(nameNode.text);
        symbols.push({
          name: nameNode.text,
          kind: node.type === 'method_declaration' ? 'method' : 'function',
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: `(${params ? params.text.slice(1, -1) : ''})${result ? ` ${result.text}` : ''}`,
          doc: docFor(node),
          exported,
          calls: collectCalls(node),
        });
        if (exported) exports.push(nameNode.text);
      }
    }

    if (node.type === 'type_spec') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: 'type',
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: null,
          doc: docFor(node.parent || node),
          exported: /^[A-Z]/.test(nameNode.text),
          calls: [],
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
  }

  symbols.sort((a, b) => a.line - b.line);
  return { doc: null, imports, exports, symbols };
}

module.exports = { parseSource };
```

- [ ] **Step 4: Register them in the dispatcher**

In `scripts/lib/graph/parse/index.js`, replace the `PARSERS` object with:

```js
const typescript = require('./typescript');
const python = require('./python');
const rust = require('./rust');
const go = require('./go');

const PARSERS = {
  typescript,
  tsx: typescript,
  javascript: typescript,
  python,
  rust,
  go,
};
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node tests/lib/graph/parse-languages.test.js`
Expected: PASS, 3 passed / 0 failed.

Then re-run Task 3's suite to confirm no regression: `node tests/lib/graph/parse-typescript.test.js` — 8 passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/graph/parse/ tests/lib/graph/parse-languages.test.js
git commit -m "feat(graph): add python, rust and go symbol extraction"
```

---

### Task 5: Symbol taxonomy

Adds the `kind` tiering the exit-code contract depends on.

**Files:**
- Create: `scripts/lib/graph/kinds.js`
- Test: `tests/lib/graph/kinds.test.js`

**Interfaces:**
- Consumes: `Symbol` objects from Tasks 3–4
- Produces:
  - `STRUCTURAL_KINDS: Set<string>` — `function, method, class, interface, type, enum, const, module`
  - `HEURISTIC_KINDS: Set<string>` — `react-component, react-hook, http-route, cli-command, test, error-type`
  - `isHeuristic(kind: string): boolean`
  - `refineKind(symbol, ctx): {kind: string, label: string|null}` where `ctx = {lang, relPath, source}`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/kinds.test.js`:

```js
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

  if (test('detects a rust test by attribute', () => {
    const r = kinds.refineKind(sym({ name: 'works' }), { lang: 'rust', relPath: 'src/lib.rs', source: '#[test]\nfn works() {}' });
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/kinds.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the taxonomy**

Create `scripts/lib/graph/kinds.js`:

```js
'use strict';

const STRUCTURAL_KINDS = new Set([
  'function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'module',
]);

const HEURISTIC_KINDS = new Set([
  'react-component', 'react-hook', 'http-route', 'cli-command', 'test', 'error-type',
]);

function isHeuristic(kind) {
  return HEURISTIC_KINDS.has(kind);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|test_.*\.py$/i;

function looksLikeTest(symbol, ctx) {
  if (TEST_PATH.test(ctx.relPath) || TEST_FILE.test(ctx.relPath)) return true;
  // Must be per-symbol. A file-wide scan tags every struct in a module that
  // merely contains a #[cfg(test)] block as a test.
  if (ctx.lang === 'rust' && rustSymbolIsTest(symbol, ctx.source)) return true;
  if (ctx.lang === 'python' && /^test_/.test(symbol.name)) return true;
  if (ctx.lang === 'go' && /^Test[A-Z]/.test(symbol.name)) return true;
  return false;
}

function refineKind(symbol, ctx) {
  const context = ctx || {};
  const relPath = context.relPath || '';
  const lang = context.lang || '';
  const source = context.source || '';

  if (looksLikeTest(symbol, { relPath, lang, source })) {
    return { kind: 'test', label: null };
  }

  if (/Error$|Exception$/.test(symbol.name) &&
      (symbol.kind === 'class' || symbol.kind === 'type')) {
    return { kind: 'error-type', label: null };
  }

  if ((lang === 'typescript' || lang === 'tsx' || lang === 'javascript')) {
    if (/^use[A-Z]/.test(symbol.name) && symbol.kind === 'function') {
      return { kind: 'react-hook', label: null };
    }
    if (/^[A-Z]/.test(symbol.name) && symbol.kind === 'function' && /\.[jt]sx$/.test(relPath)) {
      return { kind: 'react-component', label: null };
    }
  }

  return { kind: symbol.kind, label: null };
}

module.exports = {
  STRUCTURAL_KINDS,
  HEURISTIC_KINDS,
  isHeuristic,
  refineKind,
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/kinds.test.js`
Expected: PASS, 6 passed / 0 failed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/graph/kinds.js tests/lib/graph/kinds.test.js
git commit -m "feat(graph): add symbol taxonomy with structural and heuristic tiers"
```

---

### Task 6: Shard store and content hashing

**Files:**
- Create: `scripts/lib/graph/store.js`
- Test: `tests/lib/graph/store.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic` from `scripts/lib/atomic-write.js`; `parseSource` from Task 3/4; `refineKind` from Task 5
- Produces:
  - `graphDir(repoRoot): string` → `<repoRoot>/.ecc/graph`
  - `hashContent(source: string): string` → `sha256:<hex>`
  - `shardPath(dir, relPath): string`
  - `writeShard(dir, shard): string`
  - `readShard(dir, relPath): object|null`
  - `async buildShard(repoRoot, relPath, lang, rev): object` — full `ecc.graph.file.v1` shard including `hash` and `status`
  - `resolveImport(repoRoot, relPath, spec): string|null`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/store.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `scripts/lib/graph/store.js`:

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const { parseSource } = require('./parse');
const { refineKind } = require('./kinds');

const SCHEMA = 'ecc.graph.file.v1';
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go'];

function graphDir(repoRoot) {
  return path.join(repoRoot, '.ecc', 'graph');
}

function hashContent(source) {
  return `sha256:${crypto.createHash('sha256').update(String(source), 'utf8').digest('hex')}`;
}

function shardPath(dir, relPath) {
  const digest = crypto.createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 32);
  return path.join(dir, 'files', `${digest}.json`);
}

function writeShard(dir, shard) {
  return writeFileAtomic(shardPath(dir, shard.path), `${JSON.stringify(shard, null, 2)}\n`);
}

function readShard(dir, relPath) {
  try {
    return JSON.parse(fs.readFileSync(shardPath(dir, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function resolveImport(repoRoot, fromRel, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const baseDir = path.dirname(path.join(repoRoot, fromRel));
  for (const ext of RESOLVE_EXTS) {
    const candidate = path.resolve(baseDir, spec + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(repoRoot, candidate).split(path.sep).join('/');
    }
  }
  for (const ext of RESOLVE_EXTS.filter(Boolean)) {
    const candidate = path.resolve(baseDir, spec, `index${ext}`);
    if (fs.existsSync(candidate)) {
      return path.relative(repoRoot, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

async function buildShard(repoRoot, relPath, lang, rev) {
  const abs = path.join(repoRoot, relPath);
  const source = fs.readFileSync(abs, 'utf8');
  const base = {
    schema: SCHEMA,
    path: relPath,
    lang,
    hash: hashContent(source),
    rev,
    status: 'indexed',
    doc: null,
    imports: [],
    exports: [],
    symbols: [],
  };

  let parsed;
  try {
    parsed = await parseSource(lang, source);
  } catch (err) {
    return Object.assign(base, { status: 'parse_error', error: err.message });
  }

  base.doc = parsed.doc;
  base.exports = parsed.exports;
  base.imports = parsed.imports.map(imp => Object.assign({}, imp, {
    resolved: resolveImport(repoRoot, relPath, imp.from),
  }));
  base.symbols = parsed.symbols.map(symbol => {
    const refined = refineKind(symbol, { lang, relPath, source });
    return Object.assign({}, symbol, { kind: refined.kind, label: refined.label });
  });

  return base;
}

module.exports = {
  SCHEMA,
  graphDir,
  hashContent,
  shardPath,
  writeShard,
  readShard,
  resolveImport,
  buildShard,
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/store.test.js`
Expected: PASS, 7 passed / 0 failed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/graph/store.js tests/lib/graph/store.test.js
git commit -m "feat(graph): add shard store with content hashing"
```

---

### Task 7: Derived indexes and manifest

**Files:**
- Modify: `scripts/lib/graph/store.js` (append index/manifest functions)
- Test: `tests/lib/graph/indexes.test.js`

**Interfaces:**
- Consumes: shards from Task 6
- Produces:
  - `buildIndexes(shards: object[]): {symbols, kinds, edges}` matching `ecc.graph.symbols.v1`, `ecc.graph.kinds.v1`, `ecc.graph.edges.v1`
  - `writeIndexes(dir, indexes): void`
  - `readIndex(dir, name: 'symbols'|'kinds'|'edges'): object|null`
  - `writeManifest(dir, manifest): void` / `readManifest(dir): object|null`
  - `buildManifest({rev, gitSha, languages, entrypoints, shards, unsupportedCount}): object`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/indexes.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/indexes.test.js`
Expected: FAIL — `store.buildIndexes is not a function`

- [ ] **Step 3: Implement indexes and manifest**

Append to `scripts/lib/graph/store.js`, before `module.exports`:

```js
function buildIndexes(shards) {
  const symbols = {};
  const kinds = {};
  const out = {};
  const incoming = {};

  for (const shard of shards) {
    if (shard.status !== 'indexed') continue;

    for (const symbol of shard.symbols || []) {
      const ref = {
        path: shard.path,
        line: symbol.line,
        kind: symbol.kind,
        exported: Boolean(symbol.exported),
      };
      if (!symbols[symbol.name]) symbols[symbol.name] = [];
      symbols[symbol.name].push(ref);

      if (!kinds[symbol.kind]) kinds[symbol.kind] = [];
      kinds[symbol.kind].push({
        path: shard.path,
        line: symbol.line,
        name: symbol.name,
        label: symbol.label || null,
      });
    }

    const targets = (shard.imports || [])
      .map(imp => imp.resolved)
      .filter(Boolean);
    if (targets.length) {
      out[shard.path] = [...new Set(targets)].sort();
      for (const target of out[shard.path]) {
        if (!incoming[target]) incoming[target] = [];
        if (!incoming[target].includes(shard.path)) incoming[target].push(shard.path);
      }
    }
  }

  for (const key of Object.keys(incoming)) incoming[key].sort();

  return {
    symbols: { schema: 'ecc.graph.symbols.v1', symbols },
    kinds: { schema: 'ecc.graph.kinds.v1', kinds },
    edges: { schema: 'ecc.graph.edges.v1', out, in: incoming },
  };
}

function indexPath(dir, name) {
  return path.join(dir, 'index', `${name}.json`);
}

function writeIndexes(dir, indexes) {
  for (const name of ['symbols', 'kinds', 'edges']) {
    writeFileAtomic(indexPath(dir, name), `${JSON.stringify(indexes[name], null, 2)}\n`);
  }
}

function readIndex(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

function buildManifest(input) {
  const shards = input.shards || [];
  const indexed = shards.filter(s => s.status === 'indexed');
  const symbolCount = indexed.reduce((n, s) => n + (s.symbols || []).length, 0);
  const edgeCount = indexed.reduce(
    (n, s) => n + (s.imports || []).filter(i => i.resolved).length, 0
  );
  return {
    schema: 'ecc.graph.manifest.v1',
    rev: input.rev,
    built_at: new Date().toISOString(),
    git_sha: input.gitSha || null,
    languages: input.languages || [],
    entrypoints: input.entrypoints || [],
    counts: { files: indexed.length, symbols: symbolCount, edges: edgeCount },
    unindexed: {
      unsupported: input.unsupportedCount || 0,
      parse_error: shards.filter(s => s.status === 'parse_error').length,
    },
  };
}

function writeManifest(dir, manifest) {
  writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
```

Then extend `module.exports` with `buildIndexes, writeIndexes, readIndex, buildManifest, writeManifest, readManifest`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/indexes.test.js`
Expected: PASS, 6 passed / 0 failed.

The manifest test compares a written manifest to the one read back. Because `built_at` is generated once and then serialised, this is deterministic within the test.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/graph/store.js tests/lib/graph/indexes.test.js
git commit -m "feat(graph): add derived symbol, kind and edge indexes"
```

---

### Task 8: Structural history events

**Files:**
- Create: `scripts/lib/graph/history.js`
- Test: `tests/lib/graph/history.test.js`

**Interfaces:**
- Consumes: shards from Task 6
- Produces:
  - `diffShards(oldShard: object|null, newShard: object|null, meta: {rev, sha}): Event[]`
  - `appendEvents(dir, events): void`
  - `readEvents(dir, filter?: {path?: string, symbol?: string}): Event[]`
  - `Event` = `{schema:'ecc.graph.event.v1', rev, sha, at, op, path, symbol, from, to, decision: null}`
  - `op` ∈ `symbol.added | symbol.removed | signature.changed | file.added | file.removed | edge.added | edge.removed`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/history.test.js`:

```js
/**
 * Tests for scripts/lib/graph/history.js
 *
 * Run with: node tests/lib/graph/history.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../../../scripts/lib/graph/history');

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

function shard(symbols, imports) {
  return {
    schema: 'ecc.graph.file.v1', path: 'src/a.js', lang: 'javascript',
    hash: 'sha256:x', rev: 1, status: 'indexed', doc: null,
    imports: imports || [], exports: [], symbols,
  };
}

const META = { rev: 48, sha: '9f8e7d6' };

function runTests() {
  console.log('\n=== Testing graph/history.js ===\n');
  let passed = 0;
  let failed = 0;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hist-')), 'graph');

  if (test('detects an added symbol', () => {
    const events = history.diffShards(shard([]), shard([{ name: 'f', kind: 'function', signature: '()' }]), META);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].op, 'symbol.added');
    assert.strictEqual(events[0].symbol, 'f');
    assert.strictEqual(events[0].rev, 48);
    assert.strictEqual(events[0].decision, null);
  })) passed++; else failed++;

  if (test('detects a removed symbol', () => {
    const events = history.diffShards(shard([{ name: 'f', kind: 'function', signature: '()' }]), shard([]), META);
    assert.strictEqual(events[0].op, 'symbol.removed');
  })) passed++; else failed++;

  if (test('detects a changed signature with from and to', () => {
    const before = shard([{ name: 'f', kind: 'function', signature: '(a)' }]);
    const after = shard([{ name: 'f', kind: 'function', signature: '(a, b)' }]);
    const events = history.diffShards(before, after, META);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].op, 'signature.changed');
    assert.strictEqual(events[0].from, '(a)');
    assert.strictEqual(events[0].to, '(a, b)');
  })) passed++; else failed++;

  if (test('emits nothing when nothing changed', () => {
    const s = shard([{ name: 'f', kind: 'function', signature: '()' }]);
    assert.strictEqual(history.diffShards(s, s, META).length, 0);
  })) passed++; else failed++;

  if (test('detects file added and removed', () => {
    assert.strictEqual(history.diffShards(null, shard([]), META)[0].op, 'file.added');
    assert.strictEqual(history.diffShards(shard([]), null, META)[0].op, 'file.removed');
  })) passed++; else failed++;

  if (test('detects edge changes', () => {
    const before = shard([], []);
    const after = shard([], [{ from: './b', resolved: 'src/b.js', symbols: [], line: 1, external: false }]);
    const events = history.diffShards(before, after, META);
    assert.ok(events.some(e => e.op === 'edge.added' && e.to === 'src/b.js'));
  })) passed++; else failed++;

  if (test('appends and reads back events, filtered by symbol', () => {
    history.appendEvents(dir, history.diffShards(shard([]), shard([{ name: 'g', kind: 'function', signature: '()' }]), META));
    history.appendEvents(dir, history.diffShards(shard([]), shard([{ name: 'h', kind: 'function', signature: '()' }]), META));
    assert.strictEqual(history.readEvents(dir).length, 2);
    assert.strictEqual(history.readEvents(dir, { symbol: 'g' }).length, 1);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/history.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement history**

Create `scripts/lib/graph/history.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'ecc.graph.event.v1';

function eventsPath(dir) {
  return path.join(dir, 'history', 'events.jsonl');
}

function makeEvent(meta, op, filePath, fields) {
  return Object.assign({
    schema: SCHEMA,
    rev: meta.rev,
    sha: meta.sha || null,
    at: new Date().toISOString(),
    op,
    path: filePath,
    symbol: null,
    from: null,
    to: null,
    decision: null,
  }, fields || {});
}

function symbolMap(shard) {
  const map = new Map();
  for (const symbol of (shard && shard.symbols) || []) {
    map.set(symbol.name, symbol);
  }
  return map;
}

function edgeSet(shard) {
  return new Set(
    ((shard && shard.imports) || []).map(i => i.resolved).filter(Boolean)
  );
}

function diffShards(oldShard, newShard, meta) {
  if (!oldShard && !newShard) return [];
  if (!oldShard) return [makeEvent(meta, 'file.added', newShard.path)];
  if (!newShard) return [makeEvent(meta, 'file.removed', oldShard.path)];

  const filePath = newShard.path;
  const events = [];
  const before = symbolMap(oldShard);
  const after = symbolMap(newShard);

  for (const [name, symbol] of after) {
    if (!before.has(name)) {
      events.push(makeEvent(meta, 'symbol.added', filePath, { symbol: name, to: symbol.signature || null }));
    } else {
      const prev = before.get(name);
      if ((prev.signature || null) !== (symbol.signature || null)) {
        events.push(makeEvent(meta, 'signature.changed', filePath, {
          symbol: name,
          from: prev.signature || null,
          to: symbol.signature || null,
        }));
      }
    }
  }

  for (const name of before.keys()) {
    if (!after.has(name)) {
      events.push(makeEvent(meta, 'symbol.removed', filePath, { symbol: name }));
    }
  }

  const oldEdges = edgeSet(oldShard);
  const newEdges = edgeSet(newShard);
  for (const target of newEdges) {
    if (!oldEdges.has(target)) events.push(makeEvent(meta, 'edge.added', filePath, { to: target }));
  }
  for (const target of oldEdges) {
    if (!newEdges.has(target)) events.push(makeEvent(meta, 'edge.removed', filePath, { from: target }));
  }

  return events;
}

function appendEvents(dir, events) {
  if (!events || !events.length) return;
  const target = eventsPath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.appendFileSync(target, `${lines}\n`, 'utf8');
}

function readEvents(dir, filter) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(dir), 'utf8');
  } catch {
    return [];
  }
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!filter) return events;
  return events.filter(e =>
    (!filter.path || e.path === filter.path) &&
    (!filter.symbol || e.symbol === filter.symbol)
  );
}

module.exports = { SCHEMA, diffShards, appendEvents, readEvents, eventsPath };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/history.test.js`
Expected: PASS, 7 passed / 0 failed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/graph/history.js tests/lib/graph/history.test.js
git commit -m "feat(graph): add structural changelog with shard diffing"
```

---

### Task 9: Build orchestration and the fail-closed query engine

This is the task that carries the core safety property. Review it hardest.

**Files:**
- Create: `scripts/lib/graph/query.js`
- Test: `tests/lib/graph/query.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2, 6, 7, 8
- Produces:
  - `EXIT = {ANSWERED: 0, ABSENT: 1, UNAVAILABLE: 2, NOT_INDEXED: 3}`
  - `async build(repoRoot, opts?): {rev, counts}`
  - `async verifyFresh(repoRoot, relPath): {state: 'fresh'|'healed'|'missing', shard: object|null}`
  - `async find(repoRoot, name, opts?): {code, results}`
  - `async fileInfo(repoRoot, relPath): {code, shard}`
  - `async deps(repoRoot, relPath, opts?): {code, direct, reverse}`
  - `async impact(repoRoot, target): {code, direct, transitive, tests}`
  - `async list(repoRoot, kind, opts?): {code, results, heuristic}`
  - `async status(repoRoot): {code, line}`
  - `async doctor(repoRoot): {code, report}`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/query.test.js`:

```js
/**
 * Tests for scripts/lib/graph/query.js — including the fail-closed staleness contract.
 *
 * Run with: node tests/lib/graph/query.test.js
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

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-q-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'config.js'),
    '/** Config helpers. */\nfunction parseConfig(p) { return p; }\n');
  fs.writeFileSync(path.join(root, 'src', 'main.js'),
    "const { parseConfig } = require('./config');\nfunction main() { return parseConfig('a'); }\n");
  return root;
}

async function runTests() {
  console.log('\n=== Testing graph/query.js ===\n');
  let passed = 0;
  let failed = 0;
  const repo = makeRepo();

  if (await asyncTest('build indexes the repo', async () => {
    const result = await query.build(repo);
    assert.ok(result.counts.files >= 2, `files=${result.counts.files}`);
    assert.ok(result.counts.symbols >= 2);
  })) passed++; else failed++;

  if (await asyncTest('find returns 0 and a located symbol', async () => {
    const r = await query.find(repo, 'parseConfig');
    assert.strictEqual(r.code, query.EXIT.ANSWERED);
    assert.strictEqual(r.results[0].path, 'src/config.js');
    assert.strictEqual(r.results[0].line, 2);
  })) passed++; else failed++;

  if (await asyncTest('find returns 1 (definitively absent) for a real miss', async () => {
    const r = await query.find(repo, 'noSuchSymbol');
    assert.strictEqual(r.code, query.EXIT.ABSENT);
    assert.strictEqual(r.results.length, 0);
  })) passed++; else failed++;

  // The core safety property.
  if (await asyncTest('STALENESS: edit behind the index, find self-heals and never lies', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'config.js'),
      '/** Config helpers. */\nfunction parseConfig(p) { return p; }\nfunction renamedLater(q) { return q; }\n');
    const r = await query.find(repo, 'renamedLater');
    assert.strictEqual(r.code, query.EXIT.ANSWERED, 'should find the newly added symbol');
    assert.strictEqual(r.results[0].line, 3);
  })) passed++; else failed++;

  if (await asyncTest('STALENESS: deleting a symbol behind the index yields ABSENT not a stale hit', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'config.js'), '/** Config helpers. */\n');
    const r = await query.find(repo, 'parseConfig');
    assert.strictEqual(r.code, query.EXIT.ABSENT, `expected ABSENT, got ${r.code}`);
  })) passed++; else failed++;

  if (await asyncTest('deps reports forward and reverse edges', async () => {
    await query.build(repo);
    const forward = await query.deps(repo, 'src/main.js');
    assert.ok(forward.direct.includes('src/config.js'));
    const reverse = await query.deps(repo, 'src/config.js', { reverse: true });
    assert.ok(reverse.reverse.includes('src/main.js'));
  })) passed++; else failed++;

  if (await asyncTest('list on a heuristic kind never returns ABSENT', async () => {
    const r = await query.list(repo, 'http-route');
    assert.strictEqual(r.heuristic, true);
    assert.notStrictEqual(r.code, query.EXIT.ABSENT);
    assert.strictEqual(r.code, query.EXIT.NOT_INDEXED);
  })) passed++; else failed++;

  if (await asyncTest('list on a structural kind with no hits returns ABSENT', async () => {
    const r = await query.list(repo, 'enum');
    assert.strictEqual(r.heuristic, false);
    assert.strictEqual(r.code, query.EXIT.ABSENT);
  })) passed++; else failed++;

  if (await asyncTest('a missing index returns UNAVAILABLE, never a guess', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-empty-'));
    const r = await query.find(empty, 'anything');
    assert.strictEqual(r.code, query.EXIT.UNAVAILABLE);
    fs.rmSync(empty, { recursive: true, force: true });
  })) passed++; else failed++;

  if (await asyncTest('status emits a one-line summary', async () => {
    const r = await query.status(repo);
    assert.strictEqual(r.code, query.EXIT.ANSWERED);
    assert.ok(/graph: \d+ files, \d+ symbols/.test(r.line), `got: ${r.line}`);
  })) passed++; else failed++;

  fs.rmSync(repo, { recursive: true, force: true });

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/lib/graph/query.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement build and query**

Create `scripts/lib/graph/query.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const detector = require('./detector');
const store = require('./store');
const historyLog = require('./history');
const { isHeuristic, STRUCTURAL_KINDS, HEURISTIC_KINDS } = require('./kinds');

const EXIT = { ANSWERED: 0, ABSENT: 1, UNAVAILABLE: 2, NOT_INDEXED: 3 };

function gitSha(repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function countUnsupported(repoRoot) {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return 0;
  const all = result.stdout.split('\n').filter(Boolean);
  return all.filter(f => detector.languageForFile(f) === null).length;
}

async function build(repoRoot) {
  const dir = store.graphDir(repoRoot);
  const previous = store.readManifest(dir);
  const rev = previous ? previous.rev + 1 : 1;
  const sha = gitSha(repoRoot);
  const files = detector.listSourceFiles(repoRoot);

  const shards = [];
  const events = [];
  for (const file of files) {
    const oldShard = store.readShard(dir, file.path);
    const shard = await store.buildShard(repoRoot, file.path, file.lang, rev);
    store.writeShard(dir, shard);
    shards.push(shard);
    events.push(...historyLog.diffShards(oldShard, shard, { rev, sha }));
  }

  const indexes = store.buildIndexes(shards);
  store.writeIndexes(dir, indexes);
  const manifest = store.buildManifest({
    rev,
    gitSha: sha,
    languages: detector.detectLanguages(repoRoot),
    entrypoints: detector.findEntrypoints(repoRoot),
    shards,
    unsupportedCount: countUnsupported(repoRoot),
  });
  store.writeManifest(dir, manifest);
  historyLog.appendEvents(dir, events);

  return { rev, counts: manifest.counts };
}

// Re-parses a file if its on-disk content no longer matches the stored hash.
async function verifyFresh(repoRoot, relPath) {
  const dir = store.graphDir(repoRoot);
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return { state: 'missing', shard: null };

  const shard = store.readShard(dir, relPath);
  const source = fs.readFileSync(abs, 'utf8');
  const actual = store.hashContent(source);
  if (shard && shard.hash === actual) return { state: 'fresh', shard };

  const lang = detector.languageForFile(relPath);
  if (!lang) return { state: 'missing', shard: null };

  const manifest = store.readManifest(dir);
  const rev = manifest ? manifest.rev : 1;
  const healed = await store.buildShard(repoRoot, relPath, lang, rev);
  store.writeShard(dir, healed);
  historyLog.appendEvents(dir, historyLog.diffShards(shard, healed, { rev, sha: gitSha(repoRoot) }));
  return { state: 'healed', shard: healed };
}

function indexOrUnavailable(repoRoot, name) {
  const dir = store.graphDir(repoRoot);
  if (!store.readManifest(dir)) return null;
  return store.readIndex(dir, name);
}

async function find(repoRoot, name, opts) {
  const options = opts || {};
  const index = indexOrUnavailable(repoRoot, 'symbols');
  if (!index) return { code: EXIT.UNAVAILABLE, results: [] };

  const candidatePaths = new Set((index.symbols[name] || []).map(r => r.path));

  // Any file previously holding this symbol must be re-verified, and so must
  // every file whose shard may have gained it since the last build.
  // The kind filter MUST be applied while collecting, never afterwards. Filtering
  // later lets a name match of the wrong kind suppress the full rescan below, so a
  // newly added symbol of the requested kind in a stale file is reported ABSENT —
  // conflating "not there" with "unknown" and breaking the exit-code contract.
  const matchesQuery = symbol =>
    symbol.name === name && (!options.kind || symbol.kind === options.kind);

  const results = [];
  const checked = new Set();
  for (const relPath of candidatePaths) {
    checked.add(relPath);
    const { shard } = await verifyFresh(repoRoot, relPath);
    if (!shard) continue;
    for (const symbol of shard.symbols || []) {
      if (matchesQuery(symbol)) {
        results.push({ path: relPath, line: symbol.line, kind: symbol.kind,
          signature: symbol.signature, doc: symbol.doc, exported: symbol.exported });
      }
    }
  }

  // A miss is only definitive after re-verifying every indexed file, because a
  // symbol may have been added since the last build.
  if (!results.length) {
    for (const file of detector.listSourceFiles(repoRoot)) {
      if (checked.has(file.path)) continue;
      const { shard } = await verifyFresh(repoRoot, file.path);
      if (!shard) continue;
      for (const symbol of shard.symbols || []) {
        if (matchesQuery(symbol)) {
          results.push({ path: file.path, line: symbol.line, kind: symbol.kind,
            signature: symbol.signature, doc: symbol.doc, exported: symbol.exported });
        }
      }
    }
  }

  const filtered = results;

  return {
    code: filtered.length ? EXIT.ANSWERED : EXIT.ABSENT,
    results: filtered,
  };
}

async function fileInfo(repoRoot, relPath) {
  const lang = detector.languageForFile(relPath);
  if (!lang) return { code: EXIT.NOT_INDEXED, shard: null };
  const { state, shard } = await verifyFresh(repoRoot, relPath);
  if (state === 'missing' || !shard) return { code: EXIT.NOT_INDEXED, shard: null };
  if (shard.status !== 'indexed') return { code: EXIT.NOT_INDEXED, shard };
  return { code: EXIT.ANSWERED, shard };
}

async function deps(repoRoot, relPath, opts) {
  const options = opts || {};
  const edges = indexOrUnavailable(repoRoot, 'edges');
  if (!edges) return { code: EXIT.UNAVAILABLE, direct: [], reverse: [] };
  const direct = edges.out[relPath] || [];
  const reverse = edges.in[relPath] || [];
  const hit = options.reverse ? reverse.length : direct.length;
  return { code: hit ? EXIT.ANSWERED : EXIT.ABSENT, direct, reverse };
}

async function impact(repoRoot, target) {
  const edges = indexOrUnavailable(repoRoot, 'edges');
  if (!edges) return { code: EXIT.UNAVAILABLE, direct: [], transitive: [], tests: [] };

  const direct = edges.in[target] || [];
  const seen = new Set(direct);
  const queue = [...direct];
  while (queue.length) {
    const current = queue.shift();
    for (const next of edges.in[current] || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const all = [...seen];
  const tests = all.filter(p => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\./i.test(p));
  return {
    code: all.length ? EXIT.ANSWERED : EXIT.ABSENT,
    direct,
    transitive: all.filter(p => !direct.includes(p)),
    tests,
  };
}

async function list(repoRoot, kind, opts) {
  const options = opts || {};
  const heuristic = isHeuristic(kind);
  const index = indexOrUnavailable(repoRoot, 'kinds');
  if (!index) return { code: EXIT.UNAVAILABLE, results: [], heuristic };

  if (!STRUCTURAL_KINDS.has(kind) && !HEURISTIC_KINDS.has(kind)) {
    return { code: EXIT.NOT_INDEXED, results: [], heuristic };
  }

  let results = index.kinds[kind] || [];
  if (options.pathPrefix) {
    results = results.filter(r => r.path.startsWith(options.pathPrefix));
  }

  if (results.length) return { code: EXIT.ANSWERED, results, heuristic };
  // An empty heuristic result does not prove absence.
  return { code: heuristic ? EXIT.NOT_INDEXED : EXIT.ABSENT, results: [], heuristic };
}

async function history(repoRoot, target) {
  const dir = store.graphDir(repoRoot);
  if (!store.readManifest(dir)) return { code: EXIT.UNAVAILABLE, events: [] };
  const byPath = historyLog.readEvents(dir, { path: target });
  const events = byPath.length ? byPath : historyLog.readEvents(dir, { symbol: target });
  return { code: events.length ? EXIT.ANSWERED : EXIT.ABSENT, events };
}

async function status(repoRoot) {
  const manifest = store.readManifest(store.graphDir(repoRoot));
  if (!manifest) return { code: EXIT.UNAVAILABLE, line: '' };
  const { files, symbols } = manifest.counts;
  const errors = manifest.unindexed.parse_error;
  const unsupported = manifest.unindexed.unsupported;
  const line =
    `graph: ${files} files, ${symbols} symbols, rev ${manifest.rev} ` +
    `(${errors} parse errors, ${unsupported} unsupported)\n` +
    'query before reading files: ecc graph find|file|deps|impact|list';
  return { code: EXIT.ANSWERED, line };
}

async function doctor(repoRoot) {
  const dir = store.graphDir(repoRoot);
  const manifest = store.readManifest(dir);
  if (!manifest) {
    return { code: EXIT.UNAVAILABLE, report: { ok: false, reason: 'no index; run: ecc graph build' } };
  }
  const files = detector.listSourceFiles(repoRoot);
  let stale = 0;
  let missing = 0;
  for (const file of files) {
    const shard = store.readShard(dir, file.path);
    if (!shard) { missing++; continue; }
    const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8');
    if (store.hashContent(source) !== shard.hash) stale++;
  }
  return {
    code: EXIT.ANSWERED,
    report: {
      ok: true,
      rev: manifest.rev,
      indexed: manifest.counts.files,
      stale,
      missing,
      parse_errors: manifest.unindexed.parse_error,
    },
  };
}

module.exports = {
  EXIT, build, verifyFresh, find, fileInfo, deps, impact, list, history, status, doctor,
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/lib/graph/query.test.js`
Expected: PASS, 10 passed / 0 failed.

The two `STALENESS:` assertions are the reason this feature is safe. If either fails, do not proceed to any later task.

- [ ] **Step 5: Verify the incremental-equivalence property by hand**

Run this scratch check and confirm it prints `IDENTICAL`:

```bash
node -e "
const fs=require('fs'),os=require('os'),path=require('path');
const q=require('./scripts/lib/graph/query');
const store=require('./scripts/lib/graph/store');
(async()=>{
  const r=fs.mkdtempSync(path.join(os.tmpdir(),'eq-'));
  fs.mkdirSync(path.join(r,'src'));
  fs.writeFileSync(path.join(r,'src/a.js'),'function a(){}\n');
  await q.build(r);
  fs.writeFileSync(path.join(r,'src/a.js'),'function a(){}\nfunction b(){}\n');
  await q.find(r,'b');                       // heals incrementally
  const inc=JSON.stringify(store.readShard(store.graphDir(r),'src/a.js').symbols);
  await q.build(r);                          // full rebuild
  const full=JSON.stringify(store.readShard(store.graphDir(r),'src/a.js').symbols);
  console.log(inc===full?'IDENTICAL':'DIVERGED\n'+inc+'\n'+full);
  fs.rmSync(r,{recursive:true,force:true});
})();
"
```

Expected: `IDENTICAL`. If it diverges, fix `verifyFresh` before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/graph/query.js tests/lib/graph/query.test.js
git commit -m "feat(graph): add fail-closed query engine with self-healing staleness"
```

---

### Task 10: CLI surface

**Files:**
- Create: `scripts/graph.js`, `scripts/lib/graph/format.js`
- Modify: `scripts/ecc.js` (COMMANDS object at line 9; PRIMARY_COMMANDS array at line 104)
- Modify: `.gitignore`
- Test: `tests/graph-cli.test.js`

**Interfaces:**
- Consumes: all of `query.js`
- Produces: `ecc graph <verb>` with the exit-code contract, `--json` on every verb

- [ ] **Step 1: Write the failing test**

Create `tests/graph-cli.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/graph-cli.test.js`
Expected: FAIL — `Cannot find module .../scripts/graph.js`

- [ ] **Step 3: Implement the formatter**

Create `scripts/lib/graph/format.js`:

```js
'use strict';

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatFind(results) {
  return results.map(r => {
    const head = `${r.path}:${r.line}  ${r.kind}  ${r.name || ''}${r.signature || ''}` +
      `${r.exported ? '  [exported]' : ''}`;
    return r.doc ? `${head}\n  ${truncate(r.doc, 100)}` : head;
  }).join('\n');
}

function formatFile(shard) {
  const lines = [];
  lines.push(`${shard.path}  ${shard.lang}  rev${shard.rev}`);
  if (shard.doc) lines.push(`doc: ${truncate(shard.doc, 120)}`);
  const imports = (shard.imports || [])
    .map(i => (i.symbols && i.symbols.length ? `${i.from}(${i.symbols.join(',')})` : i.from));
  if (imports.length) lines.push(`imports: ${imports.join(', ')}`);
  if ((shard.exports || []).length) lines.push(`exports: ${shard.exports.join(', ')}`);
  for (const symbol of shard.symbols || []) {
    lines.push(
      `  ${String(symbol.line).padStart(4)}  ${symbol.kind.padEnd(16)} ` +
      `${symbol.name}${symbol.signature || ''}` +
      `${symbol.doc ? `    ${truncate(symbol.doc, 60)}` : ''}`
    );
  }
  return lines.join('\n');
}

function formatList(results) {
  return results.map(r => `${r.path}:${r.line}  ${r.name}${r.label ? `  ${r.label}` : ''}`).join('\n');
}

module.exports = { formatFind, formatFile, formatList, truncate };
```

- [ ] **Step 4: Implement the CLI**

Create `scripts/graph.js`:

```js
#!/usr/bin/env node
'use strict';

const path = require('path');
const query = require('./lib/graph/query');
const format = require('./lib/graph/format');

const USAGE = `Usage: ecc graph <verb> [args] [--json]

  build [--force]            Build or rebuild the index
  find <symbol> [--kind K]   Locate a symbol
  file <path>                Summarise a file
  deps <path> [--reverse]    Imports, or importers
  impact <path>              Transitive reverse dependencies
  list --kind <kind>         List symbols of a kind
  history <symbol|path>      Structural changelog
  doctor                     Index health
  status                     One-line summary

Exit codes: 0 answered, 1 definitively absent, 2 unavailable, 3 not indexed.`;

function repoRoot() {
  return process.env.ECC_GRAPH_ROOT || process.cwd();
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function emit(asJson, payload, humanText) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (humanText) {
    process.stdout.write(`${humanText}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  const asJson = flag(args, 'json');
  const root = repoRoot();

  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(verb ? 0 : 2);
  }

  switch (verb) {
    case 'build': {
      const result = await query.build(root);
      emit(asJson, result,
        `built rev ${result.rev}: ${result.counts.files} files, ` +
        `${result.counts.symbols} symbols, ${result.counts.edges} edges`);
      process.exit(query.EXIT.ANSWERED);
      break;
    }
    case 'find': {
      const name = args[1];
      if (!name) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.find(root, name, { kind: option(args, 'kind') });
      const withName = r.results.map(x => Object.assign({ name }, x));
      emit(asJson, { code: r.code, results: withName }, format.formatFind(withName));
      process.exit(r.code);
      break;
    }
    case 'file': {
      const rel = args[1];
      if (!rel) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.fileInfo(root, rel.split(path.sep).join('/'));
      emit(asJson, r, r.shard ? format.formatFile(r.shard) : 'not indexed');
      process.exit(r.code);
      break;
    }
    case 'deps': {
      const rel = args[1];
      const reverse = flag(args, 'reverse');
      const r = await query.deps(root, rel, { reverse });
      const shown = reverse ? r.reverse : r.direct;
      emit(asJson, r, shown.join('\n') || 'none');
      process.exit(r.code);
      break;
    }
    case 'impact': {
      const r = await query.impact(root, args[1]);
      emit(asJson, r,
        `direct (${r.direct.length}): ${r.direct.join(', ') || 'none'}\n` +
        `transitive (${r.transitive.length}): ${r.transitive.join(', ') || 'none'}\n` +
        `tests: ${r.tests.join(', ') || 'none'}`);
      process.exit(r.code);
      break;
    }
    case 'list': {
      const kind = option(args, 'kind');
      if (!kind) { process.stdout.write(`${USAGE}\n`); process.exit(2); }
      const r = await query.list(root, kind, { pathPrefix: option(args, 'path') });
      emit(asJson, r, r.results.length
        ? format.formatList(r.results)
        : `no ${kind} found${r.heuristic ? ' (heuristic kind: absence not guaranteed)' : ''}`);
      process.exit(r.code);
      break;
    }
    case 'history': {
      const r = await query.history(root, args[1]);
      emit(asJson, r, r.events
        .map(e => `rev${e.rev} ${e.sha || '-'} ${e.op} ${e.symbol || e.path}` +
          `${e.from || e.to ? ` ${e.from || ''} -> ${e.to || ''}` : ''}`)
        .join('\n') || 'no events');
      process.exit(r.code);
      break;
    }
    case 'doctor': {
      const r = await query.doctor(root);
      emit(asJson, r, JSON.stringify(r.report));
      process.exit(r.code);
      break;
    }
    case 'status': {
      const r = await query.status(root);
      emit(asJson, r, r.line);
      process.exit(r.code);
      break;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write(`[graph] ${err.message}\n`);
  process.exit(query.EXIT.UNAVAILABLE);
});
```

- [ ] **Step 5: Register the command in `ecc.js`**

In `scripts/ecc.js`, inside the `COMMANDS` object (starts line 9), add after the `memory` entry:

```js
  graph: {
    script: 'graph.js',
    description: 'Query the local code graph index instead of reading source files',
  },
```

And in `PRIMARY_COMMANDS` (starts line 104), add `'graph',` immediately after `'memory',`.

- [ ] **Step 6: Gitignore the generated index**

Append to `.gitignore`:

```
# Generated code graph index (rebuildable via: ecc graph build)
.ecc/graph/
```

- [ ] **Step 6b: Add the graph runtime to the published package**

Now that `scripts/graph.js` exists and is reachable from `scripts/ecc.js`, add exactly
one entry to the `files` array in `package.json`, keeping the array's existing ordering:

```
"scripts/graph.js",
```

Do **not** add `"scripts/lib/graph/"`. The array already lists `scripts/lib/`, which
covers the whole subtree — verified with `npm pack --dry-run`, which ships all 12 graph
modules. A redundant entry makes `npm-publish-surface.test.js` fail, because it asserts
the array matches the derived module graph exactly.

Then confirm the publish surface agrees with the module graph:

```bash
node tests/scripts/npm-publish-surface.test.js
```

Expected: `Failed: 0`. If it reports a mismatch, add exactly the entries the assertion
diff names — that test is the source of truth for this array, not this plan.

- [ ] **Step 7: Run the tests and make sure they pass**

Run: `node tests/graph-cli.test.js`
Expected: PASS, 7 passed / 0 failed.

Then verify registration: `node scripts/ecc.js --help` lists `graph`.

- [ ] **Step 8: Commit**

```bash
git add scripts/graph.js scripts/lib/graph/format.js scripts/ecc.js .gitignore tests/graph-cli.test.js
git commit -m "feat(graph): add ecc graph CLI with exit-code contract"
```

---

### Task 11: PostToolUse incremental hook

**Files:**
- Create: `scripts/hooks/graph-update.js`
- Modify: `hooks/hooks.json`
- Test: `tests/hooks/graph-update.test.js`

**Interfaces:**
- Consumes: `verifyFresh(repoRoot, relPath)` from Task 9
- Produces: a hook module exporting `async run(rawInput): Promise<void>` for `run-with-flags.js`, and a standalone stdin path

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/graph-update.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/hooks/graph-update.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `scripts/hooks/graph-update.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook: keep the code graph shard for an edited file current.
 *
 * Never blocks an edit. Always exits 0.
 */

const path = require('path');
const detector = require('../lib/graph/detector');
const query = require('../lib/graph/query');

const MAX_STDIN = 1024 * 1024;

function repoRoot() {
  return process.env.ECC_GRAPH_ROOT || process.cwd();
}

async function run(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return;
  }

  const toolName = input && input.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return;

  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;

  const root = repoRoot();
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return;
  if (!detector.languageForFile(rel)) return;

  await query.verifyFresh(root, rel);
}

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (data.length < MAX_STDIN) data += chunk.slice(0, MAX_STDIN - data.length);
  }
  await run(data);
}

if (require.main === module) {
  main()
    .catch(err => {
      process.stderr.write(`[GraphUpdate] ${err.message}\n`);
    })
    .finally(() => process.exit(0));
}

module.exports = { run };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node tests/hooks/graph-update.test.js`
Expected: PASS, 5 passed / 0 failed.

- [ ] **Step 5: Register the hook**

In `hooks/hooks.json`, add a `PostToolUse` entry matching `Edit|Write|MultiEdit`, routed through `run-with-flags.js` exactly like the existing `pre:observe` entry at line 43. Copy that entry's plugin-root bootstrap wrapper verbatim, changing only the trailing arguments to:

```
node scripts/hooks/run-with-flags.js post:graph-update scripts/hooks/graph-update.js standard,strict
```

and set `"id": "post:graph-update"`.

- [ ] **Step 6: Validate the hook config**

Run: `node scripts/ci/validate-hooks.js`
Expected: exits 0 with no schema errors. (Requires `npm install` to have provided `ajv`.)

- [ ] **Step 7: Commit**

```bash
git add scripts/hooks/graph-update.js hooks/hooks.json tests/hooks/graph-update.test.js
git commit -m "feat(graph): add PostToolUse incremental index update hook"
```

---

### Task 12: Skill, SessionStart line, and documentation

**Files:**
- Create: `skills/code-graph/SKILL.md`
- Modify: `scripts/hooks/session-start.js` (append the status line)
- Modify: `README.md` (component counts), `package.json` (`files` array)
- Test: `tests/lib/graph/session-line.test.js`

**Interfaces:**
- Consumes: `status(repoRoot)` from Task 9
- Produces: a SessionStart line under 60 tokens, emitted only when an index exists

- [ ] **Step 1: Write the failing test**

Create `tests/lib/graph/session-line.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails or passes**

Run: `node tests/lib/graph/session-line.test.js`
Expected: PASS if Task 9 is correct. If the line exceeds 240 characters, shorten it in `query.status` — do not raise the budget.

- [ ] **Step 3: Write the skill**

Create `skills/code-graph/SKILL.md`:

```markdown
---
name: code-graph
description: "Use when you need to know whether a symbol exists, what a file contains, what imports it, or what breaks if you change it — query the local code graph index instead of reading source files."
metadata:
  origin: ECC
---

# Code Graph

A deterministic local index of the repository's structure. Built by parsers, not
by a model, so building it costs no tokens. Querying costs roughly 35–90 tokens
where reading the equivalent files costs 1,200 or more.

## When to Use

- Before reading a file to check whether a function, class or type exists.
- To learn what a file contains without opening it.
- To find every importer of a file before changing it.
- To list all symbols of a kind: routes, components, hooks, tests.

## When Not to Use

- You need the actual implementation body. Read the file.
- The language is not indexed. The index tells you when this is the case.

## How It Works

```bash
ecc graph build                     # once per repo
ecc graph find parseConfig          # does it exist, where, what signature
ecc graph file src/config.ts        # what does this file contain
ecc graph deps src/main.ts          # what it imports
ecc graph deps src/auth.ts --reverse   # who imports it
ecc graph impact src/auth.ts        # what breaks if I change this
ecc graph list --kind http-route    # all routes
ecc graph history parseConfig       # when did this change
```

Every answer is verified against the file's current content hash before it is
returned, so the index cannot give a confidently wrong answer.

## Exit Codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Answered | Trust it |
| 1 | Definitively absent | Trust it — the symbol does not exist |
| 2 | Index unavailable or stale | Read the files instead |
| 3 | Not indexed, or a heuristic-kind query with no hits | Read the files instead |

Never treat exit 2 or 3 as "it does not exist". Those mean "unknown".

## Examples

Checking before editing:

```bash
$ ecc graph find validateToken
src/auth.ts:88  function  validateToken(token: string) => boolean  [exported]
  Verify a bearer token against the current signing key.
```

Assessing blast radius:

```bash
$ ecc graph impact src/auth.ts
direct (3): src/routes/user.ts, src/middleware/session.ts, tests/auth.test.ts
transitive (7): src/main.ts, src/cli.ts, ...
tests: tests/auth.test.ts
```
```

- [ ] **Step 4: Emit the status line at SessionStart**

In `scripts/hooks/session-start.js`, after the existing context output, append:

```js
// Code graph pointer: ~40 tokens, emitted only when an index exists.
try {
  const graphQuery = require('../lib/graph/query');
  graphQuery.status(process.env.CLAUDE_PROJECT_DIR || process.cwd())
    .then(result => {
      if (result.code === graphQuery.EXIT.ANSWERED && result.line) {
        console.log(result.line);
      }
    })
    .catch(() => {});
} catch {
  // Graph module unavailable; session start must not fail.
}
```

- [ ] **Step 5: Add the skill to the published package**

In `package.json`, add `"skills/code-graph/",` to the `files` array, keeping the array's existing alphabetical grouping.

- [ ] **Step 6: Update the README component counts**

In `README.md`, the "What's Inside" tree (near line 965) says `skills/ # 282 reusable workflows`. Update the skill count to the value printed by:

```bash
find skills -mindepth 1 -maxdepth 1 -type d | wc -l
```

This count is currently stale (the tree says 282, the real count is 284, and this task adds one more).

- [ ] **Step 7: Run the full suite and linters**

```bash
node tests/run-all.js
npx eslint scripts/ tests/
npx markdownlint-cli 'skills/code-graph/SKILL.md' 'docs/superpowers/**/*.md'
```

Expected: all tests pass, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add skills/code-graph/SKILL.md scripts/hooks/session-start.js package.json README.md tests/lib/graph/session-line.test.js
git commit -m "feat(graph): add code-graph skill and SessionStart pointer"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: languages and parser pinning → Tasks 1, 3, 4; detector → Task 2; taxonomy with tiers → Task 5; shard schema and hashing → Task 6; derived indexes and manifest coverage accounting → Task 7; history events with the `decision: null` forward-compat field → Task 8; fail-closed staleness, exit codes, and all nine verbs → Tasks 9, 10; integration surface (CLI, hook, SessionStart, skill, no MCP) → Tasks 10, 11, 12; error handling → distributed across the tasks that own each failure path; testing → the eight suites named in the spec map onto the per-task tests, with the incremental-equivalence property in Task 9 Step 5.

**Known gaps, deliberately deferred.** The spec's `graph list --kind test --covers <symbol>` filter is not implemented; `impact` reports covering tests instead, which serves the same need. Windows path handling is exercised through `path.sep` normalisation in the CLI and hook but has no dedicated suite — add one when CI runs on Windows.

**Type consistency.** `parseSource(lang, source)` has one shape across Tasks 3 and 4. `Symbol.line` is 1-indexed everywhere. Shard field names (`path`, `lang`, `hash`, `rev`, `status`, `doc`, `imports`, `exports`, `symbols`) are identical in Tasks 6–9 and in the spec. `EXIT` constants are defined once in Task 9 and imported by Tasks 10 and 11. `store.graphDir(repoRoot)` is the single source of the index location.

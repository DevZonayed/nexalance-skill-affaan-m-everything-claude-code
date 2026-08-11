/**
 * Tests for scripts/lib/soul/{store,analyze,ingest}.js
 *
 * Run with: node tests/lib/soul.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../../scripts/lib/soul/store');
const { analyze } = require('../../scripts/lib/soul/analyze');
const { fromTranscripts } = require('../../scripts/lib/soul/ingest');

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-soul-'));
}

function prompt(text, at, project) {
  return store.makePrompt({
    id: store.eventId('test', text + (at || '')),
    at: at || '2026-08-01T10:00:00Z',
    text,
    project: project || null,
  });
}

function runTests() {
  console.log('\n=== Testing soul store, analyzer and ingest ===\n');
  let passed = 0;
  let failed = 0;

  if (test('eventId is deterministic and source-scoped', () => {
    assert.strictEqual(store.eventId('a', '1'), store.eventId('a', '1'));
    assert.notStrictEqual(store.eventId('a', '1'), store.eventId('b', '1'));
  })) passed++; else failed++;

  if (test('appendUnique is idempotent — re-ingest never duplicates', () => {
    const dir = tmpDir();
    const rows = [prompt('build the thing'), prompt('ship it')];
    const first = store.appendUnique('prompts', rows, dir);
    assert.strictEqual(first.added, 2);
    const second = store.appendUnique('prompts', rows, dir);
    assert.strictEqual(second.added, 0, 'second run must add nothing');
    assert.strictEqual(second.skipped, 2);
    assert.strictEqual(store.readJsonl(store.fileFor('prompts', dir)).length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('a torn line does not lose the rest of the log', () => {
    const dir = tmpDir();
    store.appendUnique('prompts', [prompt('one'), prompt('two')], dir);
    fs.appendFileSync(store.fileFor('prompts', dir), '{"broken":\n', 'utf8');
    store.appendUnique('prompts', [prompt('three')], dir);
    const rows = store.readJsonl(store.fileFor('prompts', dir));
    assert.strictEqual(rows.length, 3, `expected 3 intact records, got ${rows.length}`);
    fs.rmSync(dir, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('analyze counts trait hits and shares', () => {
    const p = [
      prompt('build the parser and deploy it'),
      prompt('why does this fail, explain it'),
      prompt('no, that is wrong, revert it'),
    ];
    const r = analyze(p, []);
    assert.strictEqual(r.evidence.prompts, 3);
    const directive = r.traits.find(t => t.id === 'directive');
    const corrective = r.traits.find(t => t.id === 'corrective');
    assert.ok(directive.hits >= 1, 'directive should match "build"/"deploy"');
    assert.ok(corrective.hits >= 1, 'corrective should match "no,"/"wrong"/"revert"');
    assert.strictEqual(directive.share, Math.round((directive.hits / 3) * 1000) / 10);
  })) passed++; else failed++;

  if (test('confidence is low on thin evidence', () => {
    const r = analyze([prompt('do the thing')], []);
    assert.strictEqual(r.traits[0].confidence, 'low');
    assert.strictEqual(r.posture.confidence, 'low');
  })) passed++; else failed++;

  if (test('posture never escalates on thin evidence', () => {
    // Even a perfectly non-corrective operator stays at ask-often until there
    // is enough history. The profile must not hand out autonomy cheaply.
    const p = Array.from({ length: 5 }, (_, i) => prompt('go ahead by yourself ' + i));
    const r = analyze(p, []);
    assert.strictEqual(r.posture.value, 'ask-often');
  })) passed++; else failed++;

  if (test('focus and cadence come out of the log', () => {
    const p = [
      prompt('a', '2026-08-01T10:00:00Z', 'alpha'),
      prompt('b', '2026-08-01T11:00:00Z', 'alpha'),
      prompt('c', '2026-08-02T10:00:00Z', 'beta'),
    ];
    const r = analyze(p, []);
    assert.strictEqual(r.evidence.active_days, 2);
    assert.strictEqual(r.cadence.per_active_day, 1.5);
    assert.strictEqual(r.focus[0].project, 'alpha');
    assert.strictEqual(r.focus[0].count, 2);
  })) passed++; else failed++;

  if (test('vocabulary drops stopwords and short tokens', () => {
    const r = analyze([prompt('the graph and the graph of it is a graph')], []);
    const words = r.vocabulary.map(v => v.word);
    assert.ok(words.includes('graph'));
    assert.ok(!words.includes('the'), 'stopwords must be excluded');
    assert.ok(!words.includes('is'));
  })) passed++; else failed++;

  if (test('profile round-trips through disk', () => {
    const dir = tmpDir();
    const r = analyze([prompt('deploy it')], []);
    store.writeProfile(r, dir);
    assert.deepStrictEqual(store.readProfile(dir), r);
    fs.rmSync(dir, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('transcript ingest reads typed prompts and skips injected blocks', () => {
    const root = tmpDir();
    const proj = path.join(root, 'projects-demo');
    fs.mkdirSync(proj, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T10:00:00Z', message: { content: 'real operator prompt' } }),
      JSON.stringify({ type: 'user', message: { content: '<system-reminder>ignore me</system-reminder>' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'not intent' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: 'not a prompt' } }),
    ];
    fs.writeFileSync(path.join(proj, 'session.jsonl'), lines.join('\n') + '\n');
    const out = fromTranscripts(root);
    assert.strictEqual(out.prompts.length, 1, `expected 1 typed prompt, got ${out.prompts.length}`);
    assert.strictEqual(out.prompts[0].text, 'real operator prompt');
    fs.rmSync(root, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('missing sources degrade to empty, not a throw', () => {
    const out = fromTranscripts(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()));
    assert.strictEqual(out.available, false);
    assert.deepStrictEqual(out.prompts, []);
  })) passed++; else failed++;

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

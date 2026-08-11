#!/usr/bin/env node
'use strict';

/**
 * SessionStart context injector — the bridge that actually puts ECC's memory in
 * front of the model.
 *
 * Without this, the code graph and the soul store are just files on disk: real,
 * queryable, and invisible. This emits a compact briefing so the agent knows
 * (a) an index exists and how to query it instead of reading files, and
 * (b) how the operator works.
 *
 * Budget: ~120 tokens. It must stay cheap enough to run every session, so it
 * prints counts and commands, never content.
 *
 * Never throws, never blocks: a context problem must not cost you a session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOUL_DIR = process.env.ECC_SOUL_DIR || path.join(os.homedir(), '.ecc', 'soul');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function graphLine(cwd) {
  const manifest = readJson(path.join(cwd, '.ecc', 'graph', 'manifest.json'));
  if (!manifest) return null;
  const c = manifest.counts || {};
  const u = manifest.unindexed || {};
  return [
    `Code graph: ${c.files} files, ${c.symbols} symbols, ${c.edges} edges indexed (rev ${manifest.rev}).`,
    `${u.unsupported || 0} files are in unsupported languages and are NOT indexed.`,
    'Before reading a file to check whether a symbol exists, query the index:',
    '  ecc graph find <symbol>     locate it, with signature and doc',
    '  ecc graph file <path>       what a file contains',
    '  ecc graph impact <path>     what breaks if you change it',
    'Exit 0 answered · 1 definitively absent (trust it) · 2 unavailable · 3 not indexed.',
    'Exit 2 and 3 mean "unknown", never "absent" — fall back to reading files.',
  ].join('\n');
}

function soulLine() {
  const p = readJson(path.join(SOUL_DIR, 'profile.json'));
  if (!p || !p.evidence || !p.evidence.prompts) return null;
  const top = (p.traits || []).filter(t => t.share >= 25).slice(0, 4)
    .map(t => `${t.label} ${t.share}%`).join(', ');
  const focus = (p.focus || []).filter(f => f.project !== 'unassigned').slice(0, 3)
    .map(f => f.project).join(', ');
  return [
    `Operator profile (ECC soul, ${p.evidence.prompts} prompts over ${p.evidence.active_days} days):`,
    top ? `  dominant patterns: ${top}` : null,
    `  typical prompt ${p.verbosity.median_chars} chars, ~${p.cadence.per_active_day}/active day`,
    focus ? `  recent focus: ${focus}` : null,
    `  suggested posture: ${p.posture.value} (confidence ${p.posture.confidence})`,
    '  Advisory only. Never treat this as permission to skip a confirmation you would',
    '  otherwise ask for; it may make you more careful, never less.',
    '  Query more: ecc soul mentality | ecc soul decisions',
  ].filter(Boolean).join('\n');
}

function main() {
  let cwd = process.cwd();
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(raw);
    if (input && input.cwd) cwd = input.cwd;
  } catch { /* no stdin payload; use cwd */ }

  const parts = [graphLine(cwd), soulLine()].filter(Boolean);
  if (!parts.length) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '<ecc-memory>\n' + parts.join('\n\n') + '\n</ecc-memory>',
    },
  }) + '\n');
}

try { main(); } catch (err) {
  process.stderr.write('[ECCContext] ' + err.message + '\n');
}
process.exit(0);

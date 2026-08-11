#!/usr/bin/env node
'use strict';

/**
 * ecc soul — ECC's own operator-mentality store.
 *
 *   ecc soul ingest     import existing history into the ECC store (idempotent)
 *   ecc soul build      recompute profile.json from the log
 *   ecc soul status     what the store holds
 *   ecc soul mentality  print the derived profile
 *   ecc soul decisions  list recorded decisions
 *   ecc soul capture    append one prompt (used by the hook; reads stdin JSON)
 *
 * All verbs accept --json.
 */

const store = require('./lib/soul/store');
const { analyze } = require('./lib/soul/analyze');
const { ingest } = require('./lib/soul/ingest');

const USAGE = `Usage: ecc soul <verb> [--json]

  ingest      Import existing history into the ECC soul store (safe to repeat)
  build       Recompute the mentality profile from the log
  status      Show what the store holds
  mentality   Print the derived mentality profile
  decisions   List recorded decisions
  capture     Append one prompt from stdin JSON (used by the hook)
`;

function out(asJson, payload, human) {
  if (asJson) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

function buildProfile() {
  const prompts = store.readPrompts();
  const decisions = store.readDecisions();
  const profile = analyze(prompts, decisions);
  store.writeProfile(profile);
  return profile;
}

async function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  const asJson = args.includes('--json');

  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(USAGE);
    process.exit(verb ? 0 : 2);
  }

  switch (verb) {
    case 'ingest': {
      const r = ingest();
      const profile = buildProfile();
      out(asJson, { ingest: r, evidence: profile.evidence },
        `imported → prompts +${r.prompts.added} (${r.prompts.skipped} already present), ` +
        `decisions +${r.decisions.added} (${r.decisions.skipped} already present)\n` +
        `store: ${r.soulDir}\n` +
        `profile: ${profile.evidence.prompts} prompts, ${profile.evidence.decisions} decisions, ` +
        `${profile.evidence.active_days} active days`);
      break;
    }
    case 'build': {
      const p = buildProfile();
      out(asJson, p, `profile rebuilt from ${p.evidence.prompts} prompts, ${p.evidence.decisions} decisions`);
      break;
    }
    case 'status': {
      const prompts = store.readPrompts();
      const decisions = store.readDecisions();
      const profile = store.readProfile();
      out(asJson, {
        dir: store.soulDir(),
        prompts: prompts.length,
        decisions: decisions.length,
        profile_generated_at: profile ? profile.generated_at : null,
      }, `soul: ${prompts.length} prompts, ${decisions.length} decisions\n` +
         `dir:  ${store.soulDir()}\n` +
         `profile: ${profile ? profile.generated_at : 'not built yet — run: ecc soul build'}`);
      break;
    }
    case 'mentality': {
      const p = store.readProfile() || buildProfile();
      if (asJson) { out(true, p); break; }
      const lines = [];
      lines.push(`evidence   ${p.evidence.prompts} prompts · ${p.evidence.decisions} decisions · ${p.evidence.active_days} active days`);
      lines.push(`cadence    ${p.cadence.per_active_day} prompts per active day`);
      lines.push(`verbosity  median ${p.verbosity.median_chars} chars`);
      lines.push(`posture    ${p.posture.value}  (correction rate ${p.posture.correction_rate}%, confidence ${p.posture.confidence})`);
      lines.push('traits');
      for (const t of p.traits) lines.push(`  ${String(t.share + '%').padStart(6)}  ${t.label}  (${t.hits})`);
      lines.push('focus');
      for (const f of p.focus.slice(0, 6)) lines.push(`  ${String(f.share + '%').padStart(6)}  ${f.project}  (${f.count})`);
      out(false, p, lines.join('\n'));
      break;
    }
    case 'decisions': {
      const d = store.readDecisions();
      out(asJson, { decisions: d },
        d.length
          ? d.map(x => `${(x.project || '-').padEnd(22)} ${x.title || x.body.slice(0, 70)}`).join('\n')
          : 'no decisions recorded yet');
      break;
    }
    case 'capture': {
      // Reads the harness hook payload on stdin. Never fails loudly: a capture
      // problem must not disturb the operator's session.
      let raw = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) raw += chunk;
      let input = {};
      try { input = JSON.parse(raw); } catch { process.exit(0); }
      const text = input.prompt || input.user_prompt || '';
      if (!text.trim()) process.exit(0);
      const rec = store.makePrompt({
        id: store.eventId('ecc:capture', (input.session_id || '') + ':' + (input.timestamp || Date.now()) + ':' + text.length),
        at: input.timestamp || new Date().toISOString(),
        session: input.session_id || null,
        project: input.cwd ? require('path').basename(input.cwd) : null,
        text,
        source: 'ecc:hook',
      });
      const r = store.appendUnique('prompts', [rec]);
      // Rebuilding costs ~26ms at this corpus size, so keep the profile current
      // rather than letting /mind drift. Never let it break the capture.
      if (r.added) {
        try { buildProfile(); } catch { /* the log is what matters */ }
      }
      out(asJson, r, `captured ${r.added}`);
      break;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write('[soul] ' + err.message + '\n');
  process.exit(1);
});

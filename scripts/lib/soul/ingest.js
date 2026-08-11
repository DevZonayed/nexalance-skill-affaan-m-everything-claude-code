'use strict';

/**
 * Bootstrap the ECC soul store from signal that already exists on this machine.
 *
 * ECC owns the store. These are import adapters only — they seed history so the
 * profile is useful on day one. Going forward ECC captures its own prompts via
 * scripts/hooks/soul-capture.js and does not depend on any of these sources.
 *
 * Every record gets a deterministic id derived from (source, natural key), so
 * ingest is idempotent: run it as often as you like without duplicating.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');

/* ---------------------------------------------------------------- helpers */

function sqliteRows(dbPath, sql) {
  // -readonly plus a separator we can split safely. sqlite3 handles WAL, which
  // a raw file read would silently miss.
  const res = spawnSync('sqlite3', ['-readonly', '-newline', '', '-separator', '', dbPath, sql],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout.split('').filter(Boolean).map(r => r.split(''));
}

function projectFromPath(p) {
  if (!p) return null;
  const m = String(p).match(/projects[/-]([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

/* -------------------------------------------------- source: claude-mem db */

function fromClaudeMem(dbPath) {
  const prompts = [];
  const decisions = [];
  if (!dbPath || !fs.existsSync(dbPath)) return { prompts, decisions, available: false };

  const pr = sqliteRows(dbPath,
    "SELECT id, content_session_id, prompt_text, created_at FROM user_prompts ORDER BY id");
  if (pr) {
    for (const [id, session, text, at] of pr) {
      if (!text) continue;
      prompts.push(store.makePrompt({
        id: store.eventId('claude-mem:prompt', String(id)),
        at, session, text, source: 'import:claude-mem',
        project: null,
      }));
    }
  }

  const dr = sqliteRows(dbPath,
    "SELECT id, project, title, COALESCE(narrative, text, ''), concepts, files_modified, type " +
    "FROM observations WHERE type IN ('decision','milestone') ORDER BY id");
  if (dr) {
    for (const [id, project, title, body, concepts, files] of dr) {
      let c = [], f = [];
      try { c = concepts ? JSON.parse(concepts) : []; } catch { c = []; }
      try { f = files ? JSON.parse(files) : []; } catch { f = []; }
      decisions.push(store.makeDecision({
        id: store.eventId('claude-mem:decision', String(id)),
        at: null, project, title, body,
        concepts: Array.isArray(c) ? c : [],
        files: Array.isArray(f) ? f : [],
        source: 'import:claude-mem',
      }));
    }
  }
  return { prompts, decisions, available: true };
}

/* ------------------------------------------- source: harness transcripts */

function fromTranscripts(rootDir) {
  const prompts = [];
  const root = rootDir || path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return { prompts, available: false };
  }

  for (const d of dirs) {
    const project = projectFromPath(d.name);
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, d.name)).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const f of files) {
      let raw;
      try {
        raw = fs.readFileSync(path.join(root, d.name, f), 'utf8');
      } catch { continue; }

      let idx = 0;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type !== 'user' || !j.message) continue;

        // Only real typed prompts: a string content block. Tool results and
        // system reminders arrive as arrays and are not operator intent.
        const text = typeof j.message.content === 'string' ? j.message.content : null;
        if (!text || !text.trim()) continue;
        if (text.startsWith('<')) continue;             // injected system blocks

        idx++;
        prompts.push(store.makePrompt({
          id: store.eventId('transcript:' + f, String(idx)),
          at: j.timestamp || null,
          session: j.sessionId || f.replace(/\.jsonl$/, ''),
          project,
          text,
          source: 'import:transcript',
        }));
      }
    }
  }
  return { prompts, available: true };
}

/* ------------------------------------------------------------------ main */

function ingest(opts) {
  const options = opts || {};
  const dir = options.soulDir || store.soulDir();
  const memDb = options.memDb ||
    process.env.ECC_SOUL_IMPORT_DB ||
    path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
  const transcripts = options.transcripts ||
    process.env.ECC_SOUL_IMPORT_TRANSCRIPTS ||
    path.join(os.homedir(), '.claude', 'projects');

  const cm = fromClaudeMem(memDb);
  const tr = fromTranscripts(transcripts);

  const allPrompts = cm.prompts.concat(tr.prompts)
    .filter(p => p.at || p.text)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  const p = store.appendUnique('prompts', allPrompts, dir);
  const d = store.appendUnique('decisions', cm.decisions, dir);

  return {
    sources: {
      'claude-mem': { available: cm.available, prompts: cm.prompts.length, decisions: cm.decisions.length },
      transcripts: { available: tr.available, prompts: tr.prompts.length },
    },
    prompts: p,
    decisions: d,
    soulDir: dir,
  };
}

module.exports = { ingest, fromClaudeMem, fromTranscripts };

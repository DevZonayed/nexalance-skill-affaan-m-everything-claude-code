'use strict';

/**
 * Derive the operator's mentality profile from the ECC soul log.
 *
 * Every number here is computed from recorded prompts and decisions — no model
 * is invoked, so the profile is reproducible and auditable. Each trait carries
 * the evidence count behind it, and a trait with too little evidence reports
 * `confidence: "low"` rather than pretending.
 */

const store = require('./store');

const STOP = new Set(('the a an and or but if then than that this these those is are was were be been being ' +
  'do does did doing have has had having i you we they it he she of to in on at for with from by as so ' +
  'not no yes can could should would will just now also very more most some any all what which who whom ' +
  'when where why how me my our your their its there here them us please need needs want make made get ' +
  'got let lets like about into over under out up down off again still even only same other new old').split(' '));

/* Signals we can detect from prompt text alone, deterministically. */
const SIGNALS = [
  { id: 'directive',   label: 'Directive',            re: /\b(do|make|build|fix|deploy|add|create|run|implement|change|update|remove)\b/i },
  { id: 'exploratory', label: 'Exploratory',          re: /\b(what|why|how|explain|tell me|show me|can we|could we|is it|does it)\b/i },
  { id: 'corrective',  label: 'Corrective',           re: /\b(no,|not |wrong|isn'?t|doesn'?t|instead|actually|but it|should not|shouldn'?t|revert|undo)\b/i },
  { id: 'urgency',     label: 'Urgency',              re: /\b(fast|faster|quick|quickly|asap|now|hurry|immediately|super)\b/i },
  { id: 'quality',     label: 'Quality bar',          re: /\b(perfect|perfectly|properly|complete|completely|thorough|attractive|nicely|beautiful|great)\b/i },
  { id: 'verify',      label: 'Verification',         re: /\b(verify|confirm|check|test|prove|make sure|status|is it working|are we)\b/i },
  { id: 'autonomy',    label: 'Delegating autonomy',  re: /\b(go ahead|by your ?self|do whatever|you decide|handle it|take care|on your own)\b/i },
];

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 24 && !STOP.has(w) && !/^\d+$/.test(w));
}

function confidenceFor(n) {
  if (n >= 60) return 'high';
  if (n >= 20) return 'medium';
  return 'low';
}

function pct(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function analyze(prompts, decisions) {
  const P = prompts || [];
  const D = decisions || [];
  const n = P.length;

  // ---- signal strengths -------------------------------------------------
  const traits = SIGNALS.map(sig => {
    const hits = P.filter(p => sig.re.test(p.text || '')).length;
    return {
      id: sig.id,
      label: sig.label,
      hits,
      share: pct(hits, n),
      confidence: confidenceFor(n),
    };
  }).sort((a, b) => b.hits - a.hits);

  // ---- verbosity --------------------------------------------------------
  const lens = P.map(p => p.chars || (p.text || '').length).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const mean = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;

  // ---- cadence: prompts per active day ----------------------------------
  const byDay = {};
  for (const p of P) {
    const d = String(p.at || '').slice(0, 10);
    if (d) byDay[d] = (byDay[d] || 0) + 1;
  }
  const days = Object.keys(byDay).sort();
  const perDay = days.length ? Math.round((n / days.length) * 10) / 10 : 0;

  // ---- hour-of-day rhythm ----------------------------------------------
  const byHour = new Array(24).fill(0);
  for (const p of P) {
    const t = new Date(p.at);
    if (!Number.isNaN(t.getTime())) byHour[t.getUTCHours()]++;
  }

  // ---- focus: which projects the attention goes to ----------------------
  const byProject = {};
  for (const p of P) {
    const k = p.project || 'unassigned';
    byProject[k] = (byProject[k] || 0) + 1;
  }
  const focus = Object.entries(byProject)
    .map(([project, count]) => ({ project, count, share: pct(count, n) }))
    .sort((a, b) => b.count - a.count);

  // ---- vocabulary -------------------------------------------------------
  const freq = {};
  for (const p of P) for (const w of tokenize(p.text)) freq[w] = (freq[w] || 0) + 1;
  const vocabulary = Object.entries(freq)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  // ---- decisions --------------------------------------------------------
  const decByProject = {};
  for (const d of D) {
    const k = d.project || 'unassigned';
    decByProject[k] = (decByProject[k] || 0) + 1;
  }

  // ---- autonomy recommendation -----------------------------------------
  // Deliberately conservative: this only ever SUGGESTS. Raising an agent's
  // autonomy is a human act, never something the profile grants itself.
  const corrective = traits.find(t => t.id === 'corrective');
  const autonomy = traits.find(t => t.id === 'autonomy');
  const verify = traits.find(t => t.id === 'verify');
  const correctionRate = corrective ? corrective.share : 0;

  let posture = 'ask-often';
  if (n >= 20) {
    if (correctionRate < 12 && autonomy && autonomy.hits >= 2) posture = 'act-then-report';
    else if (correctionRate < 25) posture = 'act-on-routine-ask-on-risk';
  }

  return {
    schema: store.SCHEMA_PROFILE,
    generated_at: new Date().toISOString(),
    evidence: {
      prompts: n,
      decisions: D.length,
      active_days: days.length,
      first: days[0] || null,
      last: days[days.length - 1] || null,
    },
    cadence: { per_active_day: perDay, by_day: byDay, by_hour_utc: byHour },
    verbosity: { median_chars: median, mean_chars: mean },
    traits,
    focus,
    vocabulary,
    decisions: {
      total: D.length,
      by_project: Object.entries(decByProject).map(([project, count]) => ({ project, count }))
        .sort((a, b) => b.count - a.count),
    },
    posture: {
      value: posture,
      correction_rate: correctionRate,
      verification_rate: verify ? verify.share : 0,
      confidence: confidenceFor(n),
      note: 'Advisory only. ECC never raises its own autonomy from this profile; ' +
            'a human decides that. The profile may lower it freely.',
    },
  };
}

module.exports = { analyze, tokenize, SIGNALS };

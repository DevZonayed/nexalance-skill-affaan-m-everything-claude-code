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

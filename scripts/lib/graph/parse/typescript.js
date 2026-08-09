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

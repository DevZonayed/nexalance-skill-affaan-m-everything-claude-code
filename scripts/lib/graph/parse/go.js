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

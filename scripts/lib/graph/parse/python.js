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

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

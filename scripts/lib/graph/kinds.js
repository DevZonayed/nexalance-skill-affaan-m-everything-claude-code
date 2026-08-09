'use strict';

const STRUCTURAL_KINDS = new Set([
  'function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'module',
]);

const HEURISTIC_KINDS = new Set([
  'react-component', 'react-hook', 'http-route', 'cli-command', 'test', 'error-type',
]);

function isHeuristic(kind) {
  return HEURISTIC_KINDS.has(kind);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|test_.*\.py$/i;

function looksLikeTest(symbol, ctx) {
  if (TEST_PATH.test(ctx.relPath) || TEST_FILE.test(ctx.relPath)) return true;
  if (ctx.lang === 'rust' && /#\[test\]/.test(ctx.source || '')) return true;
  if (ctx.lang === 'python' && /^test_/.test(symbol.name)) return true;
  if (ctx.lang === 'go' && /^Test[A-Z]/.test(symbol.name)) return true;
  return false;
}

function refineKind(symbol, ctx) {
  const context = ctx || {};
  const relPath = context.relPath || '';
  const lang = context.lang || '';
  const source = context.source || '';

  if (looksLikeTest(symbol, { relPath, lang, source })) {
    return { kind: 'test', label: null };
  }

  if (/Error$|Exception$/.test(symbol.name) &&
      (symbol.kind === 'class' || symbol.kind === 'type')) {
    return { kind: 'error-type', label: null };
  }

  if ((lang === 'typescript' || lang === 'tsx' || lang === 'javascript')) {
    if (/^use[A-Z]/.test(symbol.name) && symbol.kind === 'function') {
      return { kind: 'react-hook', label: null };
    }
    if (/^[A-Z]/.test(symbol.name) && symbol.kind === 'function' && /\.[jt]sx$/.test(relPath)) {
      return { kind: 'react-component', label: null };
    }
  }

  return { kind: symbol.kind, label: null };
}

module.exports = {
  STRUCTURAL_KINDS,
  HEURISTIC_KINDS,
  isHeuristic,
  refineKind,
};

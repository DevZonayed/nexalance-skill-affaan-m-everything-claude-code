#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook: keep the code graph shard for an edited file current.
 *
 * Never blocks an edit. Always exits 0.
 */

const path = require('path');
const detector = require('../lib/graph/detector');
const query = require('../lib/graph/query');

const MAX_STDIN = 1024 * 1024;

function repoRoot() {
  return process.env.ECC_GRAPH_ROOT || process.cwd();
}

async function run(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return;
  }

  const toolName = input && input.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return;

  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;

  const root = repoRoot();
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return;
  if (!detector.languageForFile(rel)) return;

  await query.verifyFresh(root, rel);
}

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (data.length < MAX_STDIN) data += chunk.slice(0, MAX_STDIN - data.length);
  }
  await run(data);
}

if (require.main === module) {
  main()
    .catch(err => {
      process.stderr.write(`[GraphUpdate] ${err.message}\n`);
    })
    .finally(() => process.exit(0));
}

module.exports = { run };

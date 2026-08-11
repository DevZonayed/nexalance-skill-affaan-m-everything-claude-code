'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXTENSIONS = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target',
  '__pycache__', '.venv', 'venv', 'vendor', '.ecc',
]);

function languageForFile(relPath) {
  return EXTENSIONS[path.extname(String(relPath || '')).toLowerCase()] || null;
}

function walk(dir, repoRoot, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, repoRoot, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      const lang = languageForFile(rel);
      if (lang) acc.push({ path: rel, lang });
    }
  }
  return acc;
}

// Working-tree files git would keep: tracked plus untracked-but-not-ignored.
// Returns null when repoRoot is not a git repository.
function gitListFiles(repoRoot) {
  const result = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' }
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\n').filter(Boolean);
}

function isSkipped(relPath) {
  return relPath.split('/').some(segment => SKIP_DIRS.has(segment));
}

function listSourceFiles(repoRoot) {
  const tracked = gitListFiles(repoRoot);
  if (tracked) {
    const seen = new Set();
    const files = [];
    for (const rel of tracked) {
      if (seen.has(rel) || isSkipped(rel)) continue;
      const lang = languageForFile(rel);
      if (!lang) continue;
      if (!fs.existsSync(path.join(repoRoot, rel))) continue;
      seen.add(rel);
      files.push({ path: rel, lang });
    }
    return files;
  }
  // Not a git repository (temp dirs in tests): fall back to a filesystem walk.
  return walk(repoRoot, repoRoot, []);
}

function detectLanguages(repoRoot) {
  const counts = new Map();
  for (const file of listSourceFiles(repoRoot)) {
    counts.set(file.lang, (counts.get(file.lang) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([lang, files]) => ({ lang, files }))
    .sort((a, b) => b.files - a.files);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findEntrypoints(repoRoot) {
  const found = new Set();

  const pkg = readJson(path.join(repoRoot, 'package.json'));
  if (pkg) {
    if (typeof pkg.main === 'string') found.add(pkg.main.replace(/^\.\//, ''));
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const target of Object.values(pkg.bin)) {
        if (typeof target === 'string') found.add(target.replace(/^\.\//, ''));
      }
    }
  }

  for (const candidate of ['src/main.rs', 'src/lib.rs', 'main.go', 'src/main.py', '__main__.py']) {
    if (fs.existsSync(path.join(repoRoot, candidate))) found.add(candidate);
  }

  return [...found].filter(rel => fs.existsSync(path.join(repoRoot, rel)));
}

module.exports = {
  languageForFile,
  listSourceFiles,
  detectLanguages,
  findEntrypoints,
};

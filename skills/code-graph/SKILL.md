---
name: code-graph
description: "Use when you need to know whether a symbol exists, what a file contains, what imports it, or what breaks if you change it — query the local code graph index instead of reading source files."
metadata:
  origin: ECC
---

# Code Graph

A deterministic local index of the repository's structure. Built by parsers, not
by a model, so building it costs no tokens. Querying costs roughly 35–90 tokens
where reading the equivalent files costs 1,200 or more.

## When to Use

- Before reading a file to check whether a function, class or type exists.
- To learn what a file contains without opening it.
- To find every importer of a file before changing it.
- To list all symbols of a kind: routes, components, hooks, tests.

## When Not to Use

- You need the actual implementation body. Read the file.
- The language is not indexed. The index tells you when this is the case.

## How It Works

```bash
ecc graph build                     # once per repo
ecc graph find parseConfig          # does it exist, where, what signature
ecc graph file src/config.ts        # what does this file contain
ecc graph deps src/main.ts          # what it imports
ecc graph deps src/auth.ts --reverse   # who imports it
ecc graph impact src/auth.ts        # what breaks if I change this
ecc graph list --kind http-route    # all routes
ecc graph history parseConfig       # when did this change
```

Every answer is verified against the file's current content hash before it is
returned, so the index cannot give a confidently wrong answer.

## Exit Codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Answered | Trust it |
| 1 | Definitively absent | Trust it — the symbol does not exist |
| 2 | Index unavailable or stale | Read the files instead |
| 3 | Not indexed, or a heuristic-kind query with no hits | Read the files instead |

Never treat exit 2 or 3 as "it does not exist". Those mean "unknown".

## Examples

Checking before editing:

```bash
$ ecc graph find validateToken
src/auth.ts:88  function  validateToken(token: string) => boolean  [exported]
  Verify a bearer token against the current signing key.
```

Assessing blast radius:

```bash
$ ecc graph impact src/auth.ts
direct (3): src/routes/user.ts, src/middleware/session.ts, tests/auth.test.ts
transitive (7): src/main.ts, src/cli.ts, ...
tests: tests/auth.test.ts
```

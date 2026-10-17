#!/usr/bin/env node
// Start the code-index MCP server, after judging the index it is about to open
// (alexander-shamray/blueprint-frontend#138).
//
// A branch can force-track files under .claude/cache/codebase-index/, and the
// first connection to a rollback-mode database replays a journal it finds
// beside it. `run-index` and `cbx` ask `index_openable` before they start the
// CLI; the server was started straight from `.mcp.json` and asked nothing.
// This file is the seam: it runs `gate-index.py`, which loads the hook and asks
// the same function, and starts the server only if that passes.
//
// Node, because Claude Code starts a stdio server with the Windows PATH and
// not inside Git Bash, where the first `bash` is WSL's launcher (#134), and
// because the project needs Node on every machine already (`.nvmrc`). It
// judges nothing itself: the rule has one owner, and a second copy in this
// language would drift from it.
//
// Fail closed and visibly. A refusal exits 3 with the reason on stderr, which
// is where the server's "failed" status in `/mcp` shows it; no Python 3.12
// exits 4 for the reason `gate.sh` gives. The CLI is the binary on PATH, then
// `python -m codebase_index`, the order `run-index` uses. Stdout is the
// protocol and carries nothing of this file's.
//
// What this does not cover: an index a branch changes after the server
// started, and the instant between the gate's look and the server's own open,
// the window `docs/harness-boundaries.md` records for every check here.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const floor = 'import sys; sys.exit(sys.version_info < (3, 12))';
const candidates = [['py', '-3.12'], ['python3'], ['python']];

function refuse(code, message) {
  process.stderr.write(`mcp-launch: ${message}\n`);
  process.exit(code);
}

// The first interpreter meeting the hooks' floor, probed as `run-guard.sh`
// probes it: `python3` on Windows can be the Store alias, which fails here.
function interpreter() {
  for (const [command, ...rest] of candidates) {
    const probe = spawnSync(command, [...rest, '-c', floor], { stdio: 'ignore' });
    if (probe.status === 0) return [command, ...rest];
  }
  return null;
}

const python = interpreter();
if (python === null) {
  refuse(4, 'no Python 3.12 or newer, so the index cannot be judged; not starting the server');
}

const gate = spawnSync(python[0], [...python.slice(1), '-I', join(here, 'gate-index.py')], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
if (gate.status !== 0) {
  refuse(gate.status ?? 1, 'the index failed its check; not starting the server');
}

const env = { ...process.env, CBX_NO_SKILL_AUTO_UPDATE: '1' };
const args = ['mcp', '--root', '.'];

function start(command, argv, onMissing) {
  const child = spawn(command, argv, { stdio: 'inherit', env });
  child.on('error', (error) => {
    if (error.code === 'ENOENT' && onMissing) return onMissing();
    refuse(127, `cannot start ${command}: ${error.message}`);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

start('codebase-index', args, () =>
  start(python[0], [...python.slice(1), '-m', 'codebase_index', ...args], null));

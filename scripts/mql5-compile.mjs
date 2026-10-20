#!/usr/bin/env node
// mql5-compile.mjs — a thin, deterministic verdict wrapper around MetaEditor's CLI compiler, used
// as a benchmark `command` check for MQL5 cases. We need a wrapper because MetaEditor64.exe returns
// an UNRELIABLE process exit code (it often exits 1 even on a clean compile) and compiles
// asynchronously, writing its result to a UTF-16 log. The authoritative success signal is the log
// line `Result: 0 errors, ...` (and the produced .ex5). This script turns that into a clean
// exit 0 (success) / 1 (compile errors) / 2 (environment: MetaEditor not found) so the check
// supervisor reads a normal pass/fail.
//
// Usage (cwd = the workspace the agent built in):
//   node <repo>/scripts/mql5-compile.mjs <relative-or-absolute .mq5 path>
//
// MetaEditor path resolution (first hit wins):
//   1. env METAEDITOR  (explicit override)
//   2. the conventional install: C:\Program Files\MetaTrader 5\MetaEditor64.exe
// On non-Windows there is no MetaEditor → exit 2 (skip/invalid), never a false FAIL.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

function fail(code, msg) { console.error(`[mql5-compile] ${msg}`); process.exit(code); }

const srcArg = process.argv[2];
if (srcArg === undefined || srcArg.trim() === '') fail(2, 'usage: mql5-compile.mjs <file.mq5>');
const src = resolve(process.cwd(), srcArg);
if (!existsSync(src)) fail(2, `source not found: ${src}`);

if (process.platform !== 'win32') fail(2, 'MetaEditor is Windows-only; cannot verify MQL5 here');

// Defensive: a leading UTF-8 BOM (EF BB BF) in a .mq5 can trip the MetaEditor compiler. Strip it
// in place so a BOM a model happened to write is not misreported as a compile error.
try {
  const buf = readFileSync(src);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    writeFileSync(src, buf.subarray(3));
  }
} catch { /* non-fatal: let the compiler surface any real read error */ }

const editor = process.env.METAEDITOR ?? 'C:\\Program Files\\MetaTrader 5\\MetaEditor64.exe';
if (!existsSync(editor)) fail(2, `MetaEditor not found at ${editor} (set METAEDITOR to override)`);

const log = resolve(dirname(src), basename(src).replace(/\.mq5$/i, '') + '.compile.log');
try { rmSync(log, { force: true }); } catch { /* ignore */ }

// shell:false, argv array — no shell interpolation of the path.
spawnSync(editor, [`/compile:${src}`, `/log:${log}`], { windowsHide: true, timeout: 180_000 });

// The log is UTF-16LE. Read it and look for the authoritative result line.
let text = '';
if (existsSync(log)) {
  try { text = readFileSync(log, 'utf16le'); }
  catch { try { text = readFileSync(log, 'utf8'); } catch { /* leave empty */ } }
}

const m = text.match(/Result:\s*(\d+)\s*errors?/i);
if (m === null) fail(1, `no result line in MetaEditor log:\n${text.slice(-500)}`);
const errors = Number(m[1]);
if (errors === 0) {
  console.log(`[mql5-compile] OK — 0 errors (${basename(src)})`);
  process.exit(0);
}
fail(1, `${errors} compile error(s):\n${text.slice(-1000)}`);

#!/usr/bin/env node
/**
 * secret-guard — refuse to let a credential enter git history.
 *
 * `.gitignore` is itself a committed, public file. It hides nothing; it only
 * keeps named paths out of the index, and `git add -f` walks straight past it.
 * This guard is the part that actually fails closed.
 *
 * Three modes:
 *   node scripts/secret-guard.mjs             scan every tracked file (runs in `npm run check`)
 *   node scripts/secret-guard.mjs hook        scan only staged additions (.githooks/pre-commit)
 *   node scripts/secret-guard.mjs scan FILE…  scan named files (how the tests drive the rules)
 *
 * Exit 1 on any hit. To accept a line that is genuinely not a credential —
 * a fixture, a documented example — put `secret-guard:allow` on that line.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const ALLOW_MARKER = 'secret-guard' + ':allow';

/** This guard and its test necessarily contain the patterns they hunt for. */
const SELF_EXEMPT = new Set(['scripts/secret-guard.mjs', 'tests/secret-guard.test.ts']);

/** Paths that must never be committed, whatever their contents. */
const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.dev\.vars(\..*)?$/i,
  /(^|\/)wrangler\.deploy\.jsonc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|ppk)$/i,
];
/** The one file whose whole point is to be committed with empty values. */
const PATH_EXCEPTIONS = [/(^|\/)\.env\.example$/i];

/** Vendor tokens whose shape is unmistakable. No context needed. */
const TOKEN_RULES = [
  ['private key block', /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{24,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['URL with embedded password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@/i],
];

/** A named credential assigned a literal value. Needs a placeholder filter. */
const ASSIGNMENT_RE =
  /\b(pass(?:word|wd|phrase)|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{8,})\2/i;

/** Values that are obviously stand-ins, not credentials. */
const PLACEHOLDER_RE =
  /^(?:\s*$|.*(?:\$\{|process\.env|import\.meta\.env|env\.|<[^>]+>|\.\.\.|example|sample|placeholder|your[-_ ]|my[-_ ]|dummy|fake|changeme|redacted|xxx+|\*{3,}|todo|replace[-_ ]?me|null|undefined|none))/i;

function isPlaceholder(value) {
  if (PLACEHOLDER_RE.test(value)) return true;
  if (/^(.)\1*$/.test(value)) return true; // "aaaaaaaa"
  // Readable words joined by - or _ are names, not entropy: "content-length", "test_token".
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(value) && !/\d{4}/.test(value);
}

function scanLine(line) {
  if (line.includes(ALLOW_MARKER)) return null;
  for (const [label, re] of TOKEN_RULES) {
    if (re.test(line)) return label;
  }
  const assigned = ASSIGNMENT_RE.exec(line);
  if (assigned && !isPlaceholder(assigned[3])) return `hard-coded ${assigned[1].toLowerCase()}`;
  return null;
}

function checkPath(path) {
  // git always reports forward slashes; a path typed on Windows may not.
  const normalised = path.replace(/\\/g, '/');
  if (PATH_EXCEPTIONS.some((re) => re.test(normalised))) return null;
  return FORBIDDEN_PATHS.some((re) => re.test(normalised)) ? 'credential file' : null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Staged additions only: every `+` line in the cached diff, plus forbidden paths. */
export function stagedFindings() {
  const findings = [];
  for (const path of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n')) {
    if (!path) continue;
    const reason = checkPath(path);
    if (reason) findings.push({ path, line: null, reason });
  }
  const diff = git(['diff', '--cached', '-U0', '--diff-filter=ACMR']);
  let path = null;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      path = raw.slice(6);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (path && !SELF_EXEMPT.has(path)) {
      const reason = scanLine(raw.slice(1));
      if (reason) findings.push({ path, line: lineNo, reason });
    }
    lineNo += 1;
  }
  return findings;
}

/** Every tracked file, so a secret cannot survive by never being re-staged. */
export function trackedFindings() {
  const findings = [];
  for (const path of git(['ls-files']).split('\n')) {
    if (!path) continue;
    const reason = checkPath(path);
    if (reason) findings.push({ path, line: null, reason });
    if (SELF_EXEMPT.has(path)) continue;
    let body;
    try {
      if (statSync(path).size > 2 * 1024 * 1024) continue;
      body = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (/\u0000/.test(body)) continue; // binary
    body.split('\n').forEach((line, i) => {
      const hit = scanLine(line);
      if (hit) findings.push({ path, line: i + 1, reason: hit });
    });
  }
  return findings;
}

/** Named files, ignoring git entirely. Lets the tests exercise the rules directly. */
export function fileFindings(paths) {
  const findings = [];
  for (const path of paths) {
    const reason = checkPath(path);
    if (reason) findings.push({ path, line: null, reason });
    let body;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    body.split('\n').forEach((line, i) => {
      const hit = scanLine(line);
      if (hit) findings.push({ path, line: i + 1, reason: hit });
    });
  }
  return findings;
}

export function report(findings, mode) {
  if (findings.length === 0) {
    if (mode === 'tracked') console.log('secret-guard: clean — no credentials in tracked files.');
    return 0;
  }
  console.error(
    `\nsecret-guard: ${findings.length} possible credential${findings.length === 1 ? '' : 's'} blocked.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.path}${f.line ? `:${f.line}` : ''}  — ${f.reason}`);
  }
  console.error(
    [
      '',
      'Secrets never belong in a tracked file. Put them in .dev.vars or .env (both',
      'ignored), or send them live with `wrangler secret put NAME` — and record the',
      'value in MyVault first, because that store cannot be read back.',
      '',
      `If a line above is genuinely not a credential, append ${ALLOW_MARKER} to it.`,
      'If a real secret already reached a commit, rotate it. Deleting it does not',
      'remove it from history.',
      '',
    ].join('\n'),
  );
  return 1;
}

/** Exported for the test suite, which drives the rules without touching git. */
export const _internals = { scanLine, checkPath, isPlaceholder, ALLOW_MARKER };

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('secret-guard.mjs');
if (invokedDirectly) {
  const [, , verb, ...rest] = process.argv;
  const mode = verb === 'hook' || verb === 'scan' ? verb : 'tracked';
  const findings =
    mode === 'hook' ? stagedFindings() : mode === 'scan' ? fileFindings(rest) : trackedFindings();
  process.exit(report(findings, mode));
}

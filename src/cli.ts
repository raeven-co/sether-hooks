#!/usr/bin/env node
// sether-hook: stops prompts that carry personal data or secrets before a
// coding agent sends them. The hook runs locally and makes no network calls;
// `sether-hook gateway` cleans Claude Code's requests and forwards only the
// clean version.

import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_NAMES, isAgent, type Agent } from './agents.js';
import { check } from './check.js';
import { copyToClipboard } from './clipboard.js';
import { configFingerprint, configFromEnv, failOpenFromEnv } from './config.js';
import { createDetect } from './engine/engine.js';
import { cleanRequest, FindingCache, PlaceholderBook } from './gateway/clean.js';
import { gatewayAnswers, gatewayCandidate } from './gateway/probe.js';
import { createGateway, DEFAULT_PORT, DEFAULT_UPSTREAM } from './gateway/server.js';
import { labelFor } from './engine/labels.js';
import { maskValue } from './engine/mask.js';
import {
  hookCommand,
  inspectAll,
  install,
  settingsPath,
  uninstall,
  type HookStatus,
  type Scope,
} from './install.js';
import { scrubPrompt } from './scrub.js';
import { VERSION } from './version.js';

const USAGE = `sether-hook ${VERSION}: stop prompts with personal data or secrets before a coding agent sends them.

Usage:
  sether-hook install <claude|codex|gemini> [--project] [--portable] [--copy]
  sether-hook uninstall <claude|codex|gemini> [--project]
  sether-hook status               show where the hook is installed and whether it will run
  sether-hook scan [text]          check text (or stdin) and print the clean version
  sether-hook check --agent <a>    what the agent runs: hook JSON on stdin
  sether-hook gateway [--port N] [--upstream URL]
                                   clean Claude Code's requests instead of stopping
                                   prompts (API keys and company gateways only)

Options:
  --project   use the settings file in this directory instead of your home
  --portable  run "sether-hook" from PATH instead of this machine's absolute
              paths (for a settings file committed to a repo)
  --copy      also put the clean version of a stopped prompt on the clipboard

Settings (environment): SETHER_PHONE_REGIONS, SETHER_NETWORK=0, SETHER_IDENTITY=1,
SETHER_HIGH_ENTROPY=1, SETHER_IGNORE, SETHER_HOOK_FAIL_OPEN=1. See the README.
`;

class UsageError extends Error {}

/** Positional arguments, after rejecting any option not in `allowed`. A
 *  mistyped --project must not silently install into the home directory. */
function parse(
  args: string[],
  allowed: readonly string[],
): { positional: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of args) {
    if (!a.startsWith('--')) positional.push(a);
    else if (allowed.includes(a)) flags.add(a);
    else throw new UsageError(`unknown option ${a}`);
  }
  return { positional, flags };
}

function agentArg(value: string | undefined): Agent {
  if (!isAgent(value)) {
    throw new UsageError(`expected an agent: claude, codex or gemini (got ${value ?? 'nothing'})`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** True when `cmd` is an executable somewhere on PATH. */
function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, cmd + ext), constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

async function runCheck(args: string[]): Promise<number> {
  const at = args.indexOf('--agent');
  const agent = agentArg(at >= 0 ? args[at + 1] : undefined);
  const stdin = await readStdin();
  const config = configFromEnv(process.env);
  const base = agent === 'claude' ? gatewayCandidate(process.env) : null;
  const res = check(stdin, {
    agent,
    config,
    copy: args.includes('--copy'),
    failOpen: failOpenFromEnv(process.env),
    now: Date.now(),
    stateDir: process.env.SETHER_HOOK_STATE_DIR,
    copyToClipboard: (text) => copyToClipboard(text),
    gatewayActive: base ? await gatewayAnswers(base, configFingerprint(config)) : false,
  });
  if (res.stdout) process.stdout.write(`${res.stdout}\n`);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.code;
}

async function runScan(args: string[]): Promise<number> {
  const text = args.length > 0 ? args.join(' ') : await readStdin();
  const findings = createDetect(configFromEnv(process.env))(text);
  if (findings.length === 0) {
    process.stdout.write('Nothing sensitive found.\n');
    return 0;
  }
  for (const f of findings) {
    process.stdout.write(`${labelFor(f.type)}: ${maskValue(f.value, f.type)}\n`);
  }
  process.stdout.write(`\n${scrubPrompt(text, findings)}\n`);
  return 1;
}

/** Version managers install each Node release at its own path, and an
 *  upgrade or uninstall removes the old one. */
const VERSIONED_NODE = /[\\/](?:\.nvm|\.volta|\.fnm|fnm|\.asdf|\.nodenv|\.n|n)[\\/]/;

function runInstall(args: string[]): number {
  const { positional, flags } = parse(args, ['--project', '--portable', '--copy']);
  const agent = agentArg(positional[0]);
  const scope: Scope = flags.has('--project') ? 'project' : 'user';
  const file = settingsPath(agent, scope, homedir(), process.cwd());
  const portable = flags.has('--portable');

  if (process.platform === 'win32') {
    // How each agent runs a hook command on Windows, and how it quotes paths,
    // is untested; a wrong guess would break every prompt. Refuse instead.
    process.stderr.write(
      'sether-hook install does not support Windows yet. "sether-hook scan" works; see the README to add the hook by hand.\n',
    );
    return 1;
  }

  const cli = fileURLToPath(import.meta.url);
  if (!portable && /[\\/]_npx[\\/]/.test(cli)) {
    process.stderr.write(
      'sether-hook is running from the npx cache, which gets cleared. Install it first so the hook keeps working:\n' +
        '  npm install -g @raeven-co/sether-hooks\n',
    );
    return 1;
  }
  if (portable && !onPath('sether-hook')) {
    process.stderr.write(
      'Warning: sether-hook is not on PATH here, so a portable hook would fail on this machine.\n',
    );
  }

  const res = install(
    agent,
    file,
    hookCommand(agent, portable ? undefined : process.execPath, cli, flags.has('--copy')),
  );
  const lines = [
    `${res.removed > 0 ? 'Updated' : 'Added'} the Sether hook for ${AGENT_NAMES[agent]} in ${file}.`,
    ...(res.backup ? [`Previous version kept at ${res.backup}.`] : []),
  ];
  if (scope === 'project' && !portable) {
    lines.push(
      'This entry uses paths on this machine. If the file is committed, install with --portable instead.',
    );
  }
  if (!portable && VERSIONED_NODE.test(process.execPath)) {
    lines.push(
      `Node is managed by a version manager (${process.execPath}). After you upgrade or switch Node, run "sether-hook status".`,
    );
  }
  if (agent === 'codex') {
    lines.push('Codex runs new hooks only after you trust them: open Codex and run /hooks.');
  }
  if (agent === 'claude') {
    lines.push('Run /hooks in Claude Code to confirm it is listed under UserPromptSubmit.');
  }
  lines.push('Try it: send a prompt containing a made-up email such as ada.test.person@gmail.com.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function runUninstall(args: string[]): number {
  const { positional, flags } = parse(args, ['--project']);
  const agent = agentArg(positional[0]);
  const file = settingsPath(
    agent,
    flags.has('--project') ? 'project' : 'user',
    homedir(),
    process.cwd(),
  );
  const res = uninstall(agent, file);
  process.stdout.write(
    res.removed > 0
      ? `Removed the Sether hook from ${file}${res.backup ? ` (previous version kept at ${res.backup})` : ''}.\n`
      : `No Sether hook found in ${file}.\n`,
  );
  return 0;
}

function describe(s: HookStatus): string {
  if (s.entries === 0 && s.problems.length === 0)
    return `  ${AGENT_NAMES[s.agent]}: not installed (${s.file})`;
  const state = s.problems.length === 0 ? 'OK' : 'PROBLEM';
  return [
    `  ${AGENT_NAMES[s.agent]}: ${state} (${s.file})`,
    ...s.problems.map((p) => `    - ${p}`),
  ].join('\n');
}

function runStatus(args: string[]): number {
  parse(args, []);
  const all = inspectAll(homedir(), process.cwd(), onPath);
  const lines = ['sether-hook ' + VERSION];
  if (all.length === 0) lines.push('  No agent settings files found.');
  lines.push(...all.map(describe));
  const broken = all.filter((s) => s.problems.length > 0);
  if (broken.length > 0) {
    lines.push(
      '',
      'Fix: run "sether-hook install <agent>" again (add --project for a project file).',
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return broken.length > 0 ? 1 : 0;
}

/** `--port N` and `--upstream URL`; anything else is a usage error. */
function gatewayArgs(args: string[]): { port: number; upstream: URL } {
  let port = DEFAULT_PORT;
  let upstream = DEFAULT_UPSTREAM;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag === '--port' || flag === '--upstream') && value !== undefined) {
      if (flag === '--port') port = Number(value);
      else upstream = value;
      i += 1;
    } else {
      throw new UsageError(`unknown or incomplete option ${flag ?? ''}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UsageError('--port must be 1-65535');
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new UsageError(`--upstream is not a URL: ${upstream}`);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new UsageError('--upstream must use https:// (http:// only for 127.0.0.1 or localhost)');
  }
  return { port, upstream: url };
}

async function runGateway(args: string[]): Promise<number> {
  const { port, upstream } = gatewayArgs(args);
  const config = configFromEnv(process.env);
  const detect = createDetect(config);
  // One cache and one placeholder book for the gateway's lifetime: a value
  // keeps its placeholder from turn to turn, and in every conversation.
  const cache = new FindingCache();
  const book = new PlaceholderBook();
  const server = createGateway({
    upstream,
    version: VERSION,
    configFingerprint: configFingerprint(config),
    clean: (body) => cleanRequest(body, { detect, cache, book }),
    log: (line) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EADDRINUSE' ? `port ${port} is in use; pass --port with another one` : String(err),
      { cause: err },
    );
  }
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(
    [
      `Sether gateway is running on ${base} and sends only clean requests to ${upstream.origin}.`,
      'Start Claude Code with:',
      `  ANTHROPIC_BASE_URL=${base} claude`,
      'It needs an API key (ANTHROPIC_API_KEY) or a company gateway token. Claude plan logins are refused.',
      'Leave this running. If it stops, Claude Code requests fail instead of going out uncleaned.',
      '',
    ].join('\n'),
  );
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'check':
      return runCheck(args);
    case 'scan':
      return runScan(args);
    case 'install':
      return runInstall(args);
    case 'uninstall':
      return runUninstall(args);
    case 'status':
      return runStatus(args);
    case 'gateway':
      return runGateway(args);
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`sether-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof UsageError) process.stderr.write(`\n${USAGE}`);
    process.exitCode = err instanceof UsageError ? 64 : 1;
  },
);

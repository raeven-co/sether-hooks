// Adds or removes the hook in an agent's own settings file.
//
// Rules, because these are the user's files and other hooks live there too:
// - A file that is not valid JSON is never touched; the user gets the error.
// - The original is copied aside before the first change in each run.
// - Only Sether's own handler is added, replaced or removed. Running install
//   twice leaves one entry.
// - Writes go to a temp file first and are renamed into place. A settings
//   file that is a symlink (dotfiles repos) is written through to its target,
//   so the link survives.

import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { AGENTS, PROMPT_EVENT, type Agent } from './agents.js';

export type Scope = 'user' | 'project';

type Json = Record<string, unknown>;

const SETTINGS_FILE: Readonly<Record<Agent, readonly [dir: string, file: string]>> = {
  claude: ['.claude', 'settings.json'],
  codex: ['.codex', 'hooks.json'],
  gemini: ['.gemini', 'settings.json'],
};

export function settingsPath(agent: Agent, scope: Scope, home: string, cwd: string): string {
  const [dir, file] = SETTINGS_FILE[agent];
  return join(scope === 'user' ? home : cwd, dir, file);
}

const quote = (s: string): string => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
const unquote = (s: string): string => s.replace(/\\(["\\$`])/g, '$1');

/** The command the agent runs. By default absolute node and script paths, so
 *  it works whatever PATH the agent starts hooks with (nvm, Homebrew, Volta).
 *  Portable (`node` omitted): plain `sether-hook`, found on PATH, for settings
 *  files committed to a repo and used on other machines. */
export function hookCommand(
  agent: Agent,
  node: string | undefined,
  cli: string,
  copy: boolean,
): string {
  const program = node === undefined ? 'sether-hook' : `${quote(node)} ${quote(cli)}`;
  return `${program} check --agent ${agent}${copy ? ' --copy' : ''}`;
}

/** `VAR=value ` assignments before the command (per-agent settings such as
 *  SETHER_PHONE_REGIONS=DE). Recognised, and kept when installing again. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+/;

/** Leading `VAR=value ` assignments, matched one at a time (no nested quantifier). */
function envPrefix(command: string): string {
  let length = 0;
  for (let i = 0; i < 32; i++) {
    const m = ENV_ASSIGNMENT.exec(command.slice(length));
    if (!m) break;
    length += m[0].length;
  }
  return command.slice(0, length);
}
const ABSOLUTE_COMMAND =
  /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*[\\/]sether-hooks[^"\\/]*[\\/]dist[\\/]cli\.js)" check --agent (claude|codex|gemini)(?: --copy)?$/;
const PORTABLE_COMMAND = /^sether-hook check --agent (claude|codex|gemini)(?: --copy)?$/;

export interface ParsedCommand {
  env: string;
  agent: string;
  /** Absolute form only. */
  node?: string;
  cli?: string;
}

/** The parts of a command this tool wrote, or undefined for anyone else's.
 *  Exact shapes only: a user's own `my-sether-wrapper.sh check --agent claude`
 *  is not ours and must never be replaced or removed. */
export function parseHookCommand(command: string): ParsedCommand | undefined {
  const env = envPrefix(command);
  const rest = command.slice(env.length);
  const absolute = ABSOLUTE_COMMAND.exec(rest);
  if (absolute) {
    return {
      env,
      agent: absolute[3] ?? '',
      node: unquote(absolute[1] ?? ''),
      cli: unquote(absolute[2] ?? ''),
    };
  }
  const portable = PORTABLE_COMMAND.exec(rest);
  return portable ? { env, agent: portable[1] ?? '' } : undefined;
}

function handlerFor(agent: Agent, command: string): Json {
  switch (agent) {
    case 'claude':
      // onFailure "block": a crashed or timed-out hook stops the prompt
      // instead of waving it through (Claude Code 2.1.295+; older versions
      // ignore the field and fall back to their default).
      return { type: 'command', command, onFailure: 'block' };
    case 'codex':
      return { type: 'command', command, timeout: 30 }; // seconds
    case 'gemini':
      return { name: 'sether', type: 'command', command, timeout: 30_000 }; // milliseconds
  }
}

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A handler this tool wrote (see parseHookCommand). */
export function isSetherHandler(h: unknown): boolean {
  return isObject(h) && typeof h.command === 'string' && parseHookCommand(h.command) !== undefined;
}

/** Sether handlers for this agent's prompt event, in file order. */
function setherHandlers(doc: Json, agent: Agent): Json[] {
  const hooks = isObject(doc.hooks) ? doc.hooks : {};
  const groups = Array.isArray(hooks[PROMPT_EVENT[agent]])
    ? (hooks[PROMPT_EVENT[agent]] as unknown[])
    : [];
  return groups.flatMap((g) =>
    isObject(g) && Array.isArray(g.hooks) ? (g.hooks.filter(isSetherHandler) as Json[]) : [],
  );
}

/** `doc` without Sether's handler for this event. Returns how many were removed. */
export function withoutHook(doc: Json, agent: Agent): { doc: Json; removed: number } {
  const event = PROMPT_EVENT[agent];
  const hooks = isObject(doc.hooks) ? doc.hooks : undefined;
  const groups = hooks && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : undefined;
  if (!hooks || !groups) return { doc, removed: 0 };

  let removed = 0;
  const kept: unknown[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) {
      kept.push(g);
      continue;
    }
    const handlers = g.hooks.filter((h) => !isSetherHandler(h));
    removed += g.hooks.length - handlers.length;
    if (handlers.length > 0) kept.push({ ...g, hooks: handlers });
  }
  const nextHooks: Json = { ...hooks };
  if (kept.length > 0) nextHooks[event] = kept;
  else delete nextHooks[event];
  const next: Json = { ...doc };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return { doc: next, removed };
}

/** `doc` with exactly one Sether handler for this agent's prompt event. An
 *  environment prefix on the entry being replaced is carried over. */
export function withHook(doc: Json, agent: Agent, command: string): Json {
  const previous = setherHandlers(doc, agent)[0];
  const env =
    typeof previous?.command === 'string' ? (parseHookCommand(previous.command)?.env ?? '') : '';
  const full = env && !command.startsWith(env) ? env + command : command;
  const { doc: base } = withoutHook(doc, agent);
  const event = PROMPT_EVENT[agent];
  const hooks = isObject(base.hooks) ? base.hooks : {};
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  return {
    ...base,
    hooks: { ...hooks, [event]: [...groups, { hooks: [handlerFor(agent, full)] }] },
  };
}

function readSettings(file: string): Json {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON, so it was left untouched (${(err as Error).message})`,
      {
        cause: err,
      },
    );
  }
  if (!isObject(parsed)) throw new Error(`${file} is not a JSON object, so it was left untouched`);
  return parsed;
}

function writeSettings(path: string, doc: Json): string | undefined {
  const file = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  let mode = 0o644;
  if (existsSync(file)) {
    backup = `${file}.sether-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    mode = statSync(file).mode & 0o777;
  }
  const tmp = `${file}.sether-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
  renameSync(tmp, file);
  return backup;
}

export interface ChangeResult {
  file: string;
  backup?: string;
  /** Handlers removed (uninstall), or replaced (install). */
  removed: number;
}

export function install(agent: Agent, file: string, command: string): ChangeResult {
  const doc = readSettings(file);
  const { removed } = withoutHook(doc, agent);
  const backup = writeSettings(file, withHook(doc, agent, command));
  return { file, backup, removed };
}

export function uninstall(agent: Agent, file: string): ChangeResult {
  if (!existsSync(file)) return { file, removed: 0 };
  const { doc, removed } = withoutHook(readSettings(file), agent);
  if (removed === 0) return { file, removed: 0 };
  return { file, backup: writeSettings(file, doc), removed };
}

export interface HookStatus {
  agent: Agent;
  file: string;
  /** Sether entries found: 0 = not installed. */
  entries: number;
  command?: string;
  /** Anything that will make the hook fail or behave unexpectedly. */
  problems: string[];
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether the hook in `file` will actually run. The usual breakage: Node
 *  was upgraded or moved (nvm, Volta), so the absolute path in the command
 *  no longer exists. Claude Code then stops every prompt; Codex and Gemini
 *  CLI let every prompt through unchecked. */
export function inspect(agent: Agent, file: string, onPath: (cmd: string) => boolean): HookStatus {
  const status: HookStatus = { agent, file, entries: 0, problems: [] };
  let doc: Json;
  try {
    doc = readSettings(file);
  } catch (err) {
    status.problems.push((err as Error).message);
    return status;
  }
  const handlers = setherHandlers(doc, agent);
  status.entries = handlers.length;
  if (handlers.length === 0) return status;
  if (handlers.length > 1)
    status.problems.push(`${handlers.length} Sether entries; run install again to keep one`);

  const command = String(handlers[0]?.command);
  status.command = command;
  // setherHandlers only returns commands parseHookCommand accepts.
  const parsed = parseHookCommand(command) as ParsedCommand;
  if (parsed.agent !== agent) {
    status.problems.push(`the entry checks for "${parsed.agent}", not "${agent}"`);
  }
  if (parsed.node !== undefined && parsed.cli !== undefined) {
    if (!isExecutable(parsed.node)) {
      status.problems.push(`Node is no longer at ${parsed.node} (upgraded or moved?)`);
    }
    if (!existsSync(parsed.cli)) status.problems.push(`sether-hook is no longer at ${parsed.cli}`);
  } else if (!onPath('sether-hook')) {
    status.problems.push('sether-hook is not on PATH here');
  }
  return status;
}

export function inspectAll(
  home: string,
  cwd: string,
  onPath: (cmd: string) => boolean,
): HookStatus[] {
  const out: HookStatus[] = [];
  for (const agent of AGENTS) {
    for (const scope of ['user', 'project'] as const) {
      const file = settingsPath(agent, scope, home, cwd);
      if (scope === 'project' && file === settingsPath(agent, 'user', home, cwd)) continue;
      if (existsSync(file)) out.push(inspect(agent, file, onPath));
    }
  }
  return out;
}

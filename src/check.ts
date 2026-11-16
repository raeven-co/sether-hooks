// The hook itself: one prompt in, allow or block out.
//
// Pure apart from the resend state file and the optional clipboard copy, both
// injectable, so the tests drive it without spawning processes.

import { blockOutput, readPrompt, type Agent } from './agents.js';
import {
  createDetect,
  DEFAULT_LIMITS,
  type EngineConfig,
  type Finding,
  type ScanLimits,
} from './engine/engine.js';
import { labelFor } from './engine/labels.js';
import { maskValue } from './engine/mask.js';
import { rememberBlocked, resendAllowed } from './resend.js';
import { scrubPrompt } from './scrub.js';

export interface CheckOptions {
  agent: Agent;
  config: EngineConfig;
  /** Put the clean version on the clipboard. */
  copy: boolean;
  /** Let prompts through when the check itself fails. Default: block. */
  failOpen: boolean;
  now: number;
  stateDir?: string;
  /** Returns true when the text landed on the clipboard. */
  copyToClipboard?: (text: string) => boolean;
  /** Scan time budget and chunking (tests shorten the budget). */
  limits?: ScanLimits;
}

export interface CheckResult {
  stdout: string;
  stderr: string;
  code: number;
}

const ALLOW: CheckResult = { stdout: '', stderr: '', code: 0 };

/** Shown in full up to this length; longer clean versions are cut. */
const MAX_CLEAN_SHOWN = 4000;
const MAX_ROWS = 10;

/** Larger prompts are stopped unchecked. Every agent gives a hook about 30 s,
 *  and on a timeout Codex and Gemini CLI let the prompt through, so a paste
 *  too big to scan in time must never reach that point. 2M characters scan in
 *  about 10 s on an M-series Mac. */
export const MAX_PROMPT_CHARS = 2_000_000;

function findingRows(findings: readonly Finding[]): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const f of findings) {
    const key = `${f.type}\u0000${f.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`  - ${labelFor(f.type)}: ${maskValue(f.value, f.type)}`);
  }
  if (rows.length > MAX_ROWS) {
    const more = rows.length - MAX_ROWS;
    return [...rows.slice(0, MAX_ROWS), `  - and ${more} more`];
  }
  return rows;
}

export function blockMessage(
  findings: readonly Finding[],
  clean: string,
  copied: boolean | undefined,
  stateError?: string,
): string {
  const unique = new Set(findings.map((f) => `${f.type}\u0000${f.value}`)).size;
  const shown =
    clean.length > MAX_CLEAN_SHOWN
      ? `${clean.slice(0, MAX_CLEAN_SHOWN)}\n… (${clean.length - MAX_CLEAN_SHOWN} more characters${copied ? '' : '; install with --copy to get the full clean version'})`
      : clean;
  return [
    `Sether stopped this prompt before it was sent: ${unique === 1 ? '1 sensitive item' : `${unique} sensitive items`}.`,
    ...findingRows(findings),
    '',
    'Clean version, with placeholders instead of the values:',
    '',
    shown,
    '',
    ...(copied === true ? ['The clean version is on your clipboard.'] : []),
    ...(copied === false ? ['Could not copy the clean version to the clipboard.'] : []),
    stateError === undefined
      ? 'To send the original anyway, send it again within 2 minutes.'
      : `Sending it again will not get it through: the hook could not save its state (${stateError}). Fix that, or set SETHER_HOOK_STATE_DIR to a folder only you can write to.`,
  ].join('\n');
}

function failure(err: unknown, opts: CheckOptions): CheckResult {
  const why = messageOf(err);
  if (opts.failOpen) {
    return {
      stdout: '',
      stderr: `sether-hook: check failed, prompt allowed (SETHER_HOOK_FAIL_OPEN): ${why}\n`,
      code: 0,
    };
  }
  const reason =
    `Sether could not check this prompt, so it was not sent (${why}).\n` +
    `Set SETHER_HOOK_FAIL_OPEN=1 to let prompts through when the check fails, or remove the hook with: sether-hook uninstall ${opts.agent}`;
  return { stdout: blockOutput(opts.agent, reason), stderr: '', code: 0 };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function check(stdin: string, opts: CheckOptions): CheckResult {
  // Only a failure to read or scan the prompt goes through `failure` (where
  // fail-open may apply). Once findings exist the prompt is stopped, whatever
  // else goes wrong: a state file that cannot be written must never turn a
  // detected secret into an allowed prompt.
  let prompt: string;
  let findings: Finding[];
  try {
    prompt = readPrompt(stdin);
    if (!prompt.trim()) return ALLOW;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `the prompt is ${(prompt.length / 1e6).toFixed(1)}M characters, more than the ${MAX_PROMPT_CHARS / 1e6}M it can check in time; split it up`,
      );
    }
    findings = createDetect(opts.config, opts.limits ?? DEFAULT_LIMITS)(prompt);
  } catch (err) {
    return failure(err, opts);
  }
  if (findings.length === 0) return ALLOW;

  let stateError: string | undefined;
  try {
    if (resendAllowed(prompt, opts.now, opts.stateDir)) return ALLOW;
  } catch (err) {
    stateError = messageOf(err);
  }
  const clean = scrubPrompt(prompt, findings);
  let copied: boolean | undefined;
  try {
    copied = opts.copy ? (opts.copyToClipboard?.(clean) ?? false) : undefined;
  } catch {
    copied = false;
  }
  if (stateError === undefined) {
    try {
      rememberBlocked(prompt, opts.now, opts.stateDir);
    } catch (err) {
      stateError = messageOf(err);
    }
  }
  return {
    stdout: blockOutput(opts.agent, blockMessage(findings, clean, copied, stateError)),
    stderr: '',
    code: 0,
  };
}

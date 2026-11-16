import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { blockOutput, readPrompt, type Agent } from '../src/agents.js';
import { check, MAX_PROMPT_CHARS, type CheckOptions } from '../src/check.js';
import { configFromEnv } from '../src/config.js';
import { DEFAULT_CONFIG, DEFAULT_LIMITS } from '../src/engine/engine.js';
import { RESEND_WINDOW_MS } from '../src/resend.js';

const PII = 'email ngozi.adeyemi@gmail.com about the deploy';
const input = (prompt: string, extra: object = {}): string =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, ...extra });

let stateDir: string;
const opts = (over: Partial<CheckOptions> = {}): CheckOptions => ({
  agent: 'claude',
  config: DEFAULT_CONFIG,
  copy: false,
  failOpen: false,
  now: 1_000_000,
  stateDir,
  ...over,
});
const decisionOf = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'sether-hook-test-'));
});

describe('each agent gets exactly its documented block shape', () => {
  it('Claude Code: block, and the original prompt is left out of the message', () => {
    expect(decisionOf(blockOutput('claude', 'r'))).toEqual({
      decision: 'block',
      reason: 'r',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    });
  });

  it('Codex: block with nothing extra (an unknown field makes Codex fail open)', () => {
    expect(decisionOf(blockOutput('codex', 'r'))).toEqual({ decision: 'block', reason: 'r' });
  });

  it('Gemini CLI: deny', () => {
    expect(decisionOf(blockOutput('gemini', 'r'))).toEqual({ decision: 'deny', reason: 'r' });
  });

  it('reads the prompt every agent sends, and rejects anything else', () => {
    expect(readPrompt(input('hi', { turn_id: 't1' }))).toBe('hi');
    expect(() => readPrompt('{"tool_name":"Bash"}')).toThrow(/no "prompt"/);
    expect(() => readPrompt('{"prompt":42}')).toThrow(/not a string/);
    expect(() => readPrompt('not json')).toThrow();
  });
});

describe('check', () => {
  it('lets a clean prompt through silently', () => {
    expect(check(input('refactor the auth module'), opts())).toEqual({
      stdout: '',
      stderr: '',
      code: 0,
    });
    expect(check(input('   '), opts()).stdout).toBe('');
  });

  it.each<Agent>(['claude', 'codex', 'gemini'])(
    'stops a prompt with PII (%s), exit 0 with a decision',
    (agent) => {
      const res = check(input(PII), opts({ agent }));
      expect(res.code).toBe(0);
      const out = decisionOf(res.stdout);
      expect(out.decision).toBe(agent === 'gemini' ? 'deny' : 'block');
      const reason = String(out.reason);
      expect(reason).toContain('1 sensitive item');
      expect(reason).toContain('email [EMAIL_1] about the deploy');
      expect(reason).not.toContain('ngozi.adeyemi@gmail.com');
    },
  );

  it('lets the identical prompt through when sent again within the window', () => {
    expect(decisionOf(check(input(PII), opts()).stdout).decision).toBe('block');
    expect(check(input(PII), opts({ now: 1_000_000 + RESEND_WINDOW_MS - 1 })).stdout).toBe('');
    // Not used up inside the window (two installed entries both check each send).
    expect(check(input(PII), opts({ now: 1_000_000 + RESEND_WINDOW_MS })).stdout).toBe('');
  });

  it('works with the hook installed twice: the send is stopped, the resend goes through', () => {
    // An agent stops a prompt if any of its hooks blocks it.
    const twice = (now: number): string[] =>
      [opts({ now }), opts({ now, agent: 'claude' })].map((o) => check(input(PII), o).stdout);
    expect(twice(1_000_000).some((out) => out !== '' && decisionOf(out).decision === 'block')).toBe(
      true,
    );
    expect(twice(1_000_000 + 5_000)).toEqual(['', '']);
  });

  it('does not let it through after the window, or for a different prompt', () => {
    check(input(PII), opts());
    expect(check(input(PII), opts({ now: 1_000_000 + RESEND_WINDOW_MS + 1 })).stdout).not.toBe('');
    check(input(PII), opts());
    expect(check(input(`${PII} today`), opts()).stdout).not.toBe('');
  });

  it('remembers a stopped prompt as a hash only, never its text', () => {
    check(input(PII), opts());
    const files = readdirSync(stateDir);
    expect(files).toEqual(['last-blocked']);
    const saved = readFileSync(join(stateDir, 'last-blocked'), 'utf8');
    expect(saved).toMatch(/^[0-9a-f]{64}\t\d+$/);
    expect(saved).not.toContain('ngozi');
  });

  it('fails closed by default when the input cannot be checked', () => {
    const res = check('garbage', opts());
    expect(decisionOf(res.stdout).decision).toBe('block');
    expect(String(decisionOf(res.stdout).reason)).toContain('could not check this prompt');
  });

  it('fails open only when asked to', () => {
    const res = check('garbage', opts({ failOpen: true }));
    expect(res).toMatchObject({ stdout: '', code: 0 });
    expect(res.stderr).toContain('SETHER_HOOK_FAIL_OPEN');
  });

  it('copies the clean version when asked, and says whether it worked', () => {
    const copied: string[] = [];
    const ok = check(
      input(PII),
      opts({ copy: true, copyToClipboard: (t) => (copied.push(t), true) }),
    );
    expect(copied).toEqual(['email [EMAIL_1] about the deploy']);
    expect(String(decisionOf(ok.stdout).reason)).toContain('on your clipboard');
    const failed = check(input(`${PII}!`), opts({ copy: true, copyToClipboard: () => false }));
    expect(String(decisionOf(failed.stdout).reason)).toContain('Could not copy');
    const off = check(input(`${PII}?`), opts({ copyToClipboard: () => true }));
    expect(String(decisionOf(off.stdout).reason)).not.toMatch(/clipboard/);
  });

  it('cuts a very long clean version and lists at most ten values', () => {
    const many = Array.from({ length: 14 }, (_, i) => `user${i}.x@gmail.com`).join(' ');
    const prompt = `${many} ${'lorem '.repeat(1000)}`;
    const reason = String(decisionOf(check(input(prompt), opts()).stdout).reason);
    expect(reason).toContain('14 sensitive items');
    expect(reason).toContain('and 4 more');
    expect(reason).toMatch(/more characters; install with --copy/);
  });
});

describe('review findings: state handling and time budget', () => {
  it('still stops a sensitive prompt when the state cannot be saved, even with fail-open', () => {
    const bad = join(stateDir, 'not-a-dir');
    writeFileSync(bad, 'x');
    const res = check(input(PII), opts({ failOpen: true, stateDir: join(bad, 'x') }));
    const out = decisionOf(res.stdout);
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toContain('email [EMAIL_1] about the deploy');
    expect(String(out.reason)).toContain('Sending it again will not get it through');
  });

  it('refuses a state directory other users can write to', () => {
    const shared = join(stateDir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const reason = String(decisionOf(check(input(PII), opts({ stateDir: shared })).stdout).reason);
    expect(reason).toContain('writable by other users');
    expect(readdirSync(shared)).toEqual([]);
  });

  it('never writes through a planted symlink', () => {
    const victim = join(stateDir, 'victim.txt');
    writeFileSync(victim, 'precious');
    const dirWithLink = join(stateDir, 'state');
    mkdirSync(dirWithLink, { mode: 0o700 });
    symlinkSync(victim, join(dirWithLink, 'last-blocked'));
    const out = decisionOf(check(input(PII), opts({ stateDir: dirWithLink })).stdout);
    expect(out.decision).toBe('block');
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('stops a prompt it cannot finish checking in time (fail closed)', () => {
    let t = 0;
    const slowClock = { ...DEFAULT_LIMITS, budgetMs: 10, now: () => (t += 20) };
    const res = check(input('just some text to scan'), opts({ limits: slowClock }));
    expect(String(decisionOf(res.stdout).reason)).toMatch(/took more than 0.01 s to check/);
    expect(check(input('just some text'), opts({ limits: slowClock, failOpen: true })).stdout).toBe(
      '',
    );
  });
});

describe('oversized prompts', () => {
  const huge = 'a'.repeat(MAX_PROMPT_CHARS + 1);
  it('are stopped unchecked, so a timeout can never wave them through', () => {
    const reason = String(decisionOf(check(input(huge), opts({ agent: 'codex' })).stdout).reason);
    expect(reason).toContain('could not check this prompt');
    expect(reason).toContain('split it up');
  });

  it('go through only with fail-open set', () => {
    expect(check(input(huge), opts({ failOpen: true })).stdout).toBe('');
  });

  it('just under the limit is still checked', () => {
    expect(check(input('a'.repeat(MAX_PROMPT_CHARS - 100)), opts()).stdout).toBe('');
  });
});

describe('configFromEnv', () => {
  it('defaults match the engine defaults', () => {
    expect(configFromEnv({})).toEqual(DEFAULT_CONFIG);
  });

  it('reads every switch', () => {
    expect(
      configFromEnv({
        SETHER_NETWORK: '0',
        SETHER_IDENTITY: '1',
        SETHER_HIGH_ENTROPY: 'true',
        SETHER_PHONE_REGIONS: 'de, fr',
        SETHER_IGNORE: 'a@b.co, x ',
      }),
    ).toEqual({
      network: false,
      identity: true,
      highEntropy: true,
      phoneRegions: ['de', 'fr'],
      ignoreValues: ['a@b.co', 'x'],
    });
  });
});

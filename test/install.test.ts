import {
  chmodSync,
  lstatSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  hookCommand,
  inspect,
  inspectAll,
  install,
  isSetherHandler,
  settingsPath,
  uninstall,
} from '../src/install.js';

const CMD = hookCommand('claude', '/usr/local/bin/node', '/opt/sether-hooks/dist/cli.js', false);
let dir: string;
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const write = (file: string, body: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sether-install-test-'));
});

describe('settingsPath', () => {
  it('points at each agent’s own file, user or project', () => {
    expect(settingsPath('claude', 'user', '/h', '/p')).toBe('/h/.claude/settings.json');
    expect(settingsPath('codex', 'user', '/h', '/p')).toBe('/h/.codex/hooks.json');
    expect(settingsPath('gemini', 'project', '/h', '/p')).toBe('/p/.gemini/settings.json');
  });
});

describe('hookCommand', () => {
  it('quotes paths with spaces and shell characters', () => {
    expect(hookCommand('codex', '/Apps/My Node/node', '/x/$HOME/cli.js', true)).toBe(
      '"/Apps/My Node/node" "/x/\\$HOME/cli.js" check --agent codex --copy',
    );
  });
});

describe('install', () => {
  it('creates the file with the agent’s documented shape', () => {
    const claude = join(dir, '.claude/settings.json');
    install('claude', claude, CMD);
    expect(read(claude)).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD, onFailure: 'block' }] }],
      },
    });

    const codex = join(dir, '.codex/hooks.json');
    install('codex', codex, CMD);
    expect(read(codex)).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD, timeout: 30 }] }] },
    });

    const gemini = join(dir, '.gemini/settings.json');
    install('gemini', gemini, CMD);
    expect(read(gemini)).toEqual({
      hooks: {
        BeforeAgent: [
          { hooks: [{ name: 'sether', type: 'command', command: CMD, timeout: 30000 }] },
        ],
      },
    });
  });

  it('keeps every other setting and hook, and backs the original up', () => {
    const file = join(dir, 'settings.json');
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    write(file, original);
    const res = install('claude', file, CMD);
    const doc = read(file);
    expect(doc.model).toBe('opus');
    expect(doc.permissions).toEqual(original.permissions);
    const hooks = doc.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.UserPromptSubmit?.[0]).toEqual(original.hooks.UserPromptSubmit[0]);
    expect(res.backup && read(res.backup)).toEqual(original);
  });

  it('is idempotent: installing twice leaves one Sether entry', () => {
    const file = join(dir, 'settings.json');
    install('claude', file, CMD);
    const second = install(
      'claude',
      file,
      hookCommand('claude', '/usr/local/bin/node', '/opt/sether-hooks/dist/cli.js', true),
    );
    expect(second.removed).toBe(1);
    const groups =
      (read(file).hooks as Record<string, { hooks: { command: string }[] }[]>).UserPromptSubmit ??
      [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks[0]?.command.endsWith('--copy')).toBe(true);
  });

  it('never touches a file that is not valid JSON', () => {
    const file = join(dir, 'settings.json');
    write(file, '{ "model": "opus", // a comment\n }');
    expect(() => install('claude', file, CMD)).toThrow(/not valid JSON, so it was left untouched/);
    expect(readFileSync(file, 'utf8')).toBe('{ "model": "opus", // a comment\n }');
    expect(readdirSync(dir)).toEqual(['settings.json']);
    write(file, '[1,2]');
    expect(() => install('claude', file, CMD)).toThrow(/not a JSON object/);
  });

  it('keeps the file’s permissions', () => {
    const file = join(dir, 'settings.json');
    write(file, {});
    chmodSync(file, 0o600);
    install('claude', file, CMD);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('uninstall', () => {
  it('removes only the Sether handler and cleans up what it emptied', () => {
    const file = join(dir, 'settings.json');
    write(file, {
      model: 'opus',
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });
    install('claude', file, CMD);
    expect(uninstall('claude', file).removed).toBe(1);
    expect(read(file)).toEqual({
      model: 'opus',
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });

    const only = join(dir, 'only.json');
    install('gemini', only, CMD);
    uninstall('gemini', only);
    expect(read(only)).toEqual({});
  });

  it('does nothing when there is nothing to remove', () => {
    expect(uninstall('codex', join(dir, 'missing.json'))).toEqual({
      file: join(dir, 'missing.json'),
      removed: 0,
    });
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
    const file = join(dir, 'other.json');
    write(file, {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });
    expect(uninstall('claude', file).removed).toBe(0);
    expect(readdirSync(dir).filter((f) => f.includes('backup'))).toEqual([]);
  });

  it('recognises only its own handlers', () => {
    expect(isSetherHandler({ command: CMD })).toBe(true);
    expect(isSetherHandler({ command: hookCommand('codex', undefined, '', true) })).toBe(true);
    expect(isSetherHandler({ command: `SETHER_PHONE_REGIONS=DE A='x y' ${CMD}` })).toBe(true);
    // Anyone else's command that merely mentions sether is not ours (review finding 6).
    expect(isSetherHandler({ command: 'sether-other-tool check --agent claude' })).toBe(false);
    expect(
      isSetherHandler({ command: '~/bin/my-sether-wrapper.sh check --agent claude --strict' }),
    ).toBe(false);
    expect(isSetherHandler({ command: `${CMD} --strict` })).toBe(false);
    expect(isSetherHandler({ command: '/x/my-hook check --agent claude' })).toBe(false);
    expect(isSetherHandler({ command: 'sether scan' })).toBe(false);
    expect(isSetherHandler('sether check --agent claude')).toBe(false);
  });
});

describe('symlinked settings files (dotfiles repos)', () => {
  it('writes through the link and keeps it a link', () => {
    const real = join(dir, 'dotfiles', 'claude-settings.json');
    write(real, { model: 'opus' });
    const link = join(dir, '.claude', 'settings.json');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    const res = install('claude', link, CMD);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real).model).toBe('opus');
    expect((read(real).hooks as Record<string, unknown[]>).UserPromptSubmit).toHaveLength(1);
    // The backup sits next to the real file (resolved path: /var is /private/var on macOS).
    expect(res.backup?.startsWith(realpathSync(join(dir, 'dotfiles')))).toBe(true);
    uninstall('claude', link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: 'opus' });
  });
});

describe('portable command', () => {
  it('runs sether-hook from PATH, with no machine paths', () => {
    expect(hookCommand('gemini', undefined, '/ignored/cli.js', true)).toBe(
      'sether-hook check --agent gemini --copy',
    );
    expect(isSetherHandler({ command: hookCommand('codex', undefined, '', false) })).toBe(true);
  });
});

describe('inspect (sether-hook status)', () => {
  const node = process.execPath;
  const cli = join(process.cwd(), 'dist', 'cli.js'); // built by pretest
  const never = (): boolean => false;
  const always = (): boolean => true;

  it('reports a healthy install', () => {
    const file = join(dir, 'settings.json');
    install('claude', file, hookCommand('claude', node, cli, false));
    expect(inspect('claude', file, never)).toMatchObject({ entries: 1, problems: [] });
  });

  it('catches Node having moved (the nvm-upgrade breakage)', () => {
    const file = join(dir, 'settings.json');
    install('codex', file, hookCommand('codex', join(dir, 'old-node', 'bin', 'node'), cli, false));
    expect(inspect('codex', file, never).problems).toEqual([
      expect.stringContaining('Node is no longer at'),
    ]);
  });

  it('catches the script having moved, quoting and all', () => {
    const file = join(dir, 'settings.json');
    install(
      'gemini',
      file,
      hookCommand(
        'gemini',
        node,
        join(dir, 'gone dir', '$x', 'sether-hooks', 'dist', 'cli.js'),
        false,
      ),
    );
    expect(inspect('gemini', file, never).problems).toEqual([
      expect.stringContaining(join(dir, 'gone dir', '$x', 'sether-hooks', 'dist', 'cli.js')),
    ]);
  });

  it('checks PATH for a portable entry', () => {
    const file = join(dir, 'settings.json');
    install('claude', file, hookCommand('claude', undefined, '', false));
    expect(inspect('claude', file, always).problems).toEqual([]);
    expect(inspect('claude', file, never).problems).toEqual(['sether-hook is not on PATH here']);
  });

  it('flags a wrong agent, duplicates and unreadable files', () => {
    const file = join(dir, 'settings.json');
    write(file, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: hookCommand('codex', node, cli, false) }] },
          { hooks: [{ type: 'command', command: hookCommand('codex', node, cli, false) }] },
        ],
      },
    });
    const problems = inspect('claude', file, never).problems.join(' | ');
    expect(problems).toContain('2 Sether entries');
    expect(problems).toContain('checks for "codex"');
    write(file, '{oops');
    expect(inspect('claude', file, never).problems[0]).toContain('not valid JSON');
  });

  it('reports not installed when there is no Sether entry', () => {
    const file = join(dir, 'settings.json');
    write(file, {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
    });
    expect(inspect('claude', file, never)).toMatchObject({ entries: 0, problems: [] });
  });

  it('looks at user and project files that exist, for every agent', () => {
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    install(
      'claude',
      settingsPath('claude', 'user', home, project),
      hookCommand('claude', node, cli, false),
    );
    install(
      'gemini',
      settingsPath('gemini', 'project', home, project),
      hookCommand('gemini', undefined, '', false),
    );
    const found = inspectAll(home, project, never).map((s) => `${s.agent}:${s.problems.length}`);
    expect(found).toEqual(['claude:0', 'gemini:1']);
  });
});

describe('review findings: install', () => {
  it('leaves a user wrapper that mentions sether alone', () => {
    const file = join(dir, 'settings.json');
    const wrapper = {
      type: 'command',
      command: '~/bin/my-sether-wrapper.sh check --agent claude --strict',
    };
    write(file, { hooks: { UserPromptSubmit: [{ hooks: [wrapper] }] } });
    install('claude', file, CMD);
    const groups =
      (read(file).hooks as Record<string, { hooks: unknown[] }[]>).UserPromptSubmit ?? [];
    expect(groups[0]?.hooks).toEqual([wrapper]);
    expect(groups).toHaveLength(2);
    uninstall('claude', file);
    expect((read(file).hooks as Record<string, { hooks: unknown[] }[]>).UserPromptSubmit).toEqual([
      { hooks: [wrapper] },
    ]);
  });

  it('keeps a VAR=value prefix the user added when installing again', () => {
    const file = join(dir, 'settings.json');
    install('codex', file, CMD.replace('claude', 'codex'));
    const withEnv = readFileSync(file, 'utf8').replace(
      '"command": "',
      '"command": "SETHER_PHONE_REGIONS=DE ',
    );
    writeFileSync(file, withEnv);
    install('codex', file, `${CMD.replace('claude', 'codex')} --copy`);
    const command = (read(file).hooks as Record<string, { hooks: { command: string }[] }[]>)
      .UserPromptSubmit?.[0]?.hooks[0]?.command;
    expect(command).toBe(`SETHER_PHONE_REGIONS=DE ${CMD.replace('claude', 'codex')} --copy`);
  });

  it('status understands a VAR=value prefix', () => {
    const file = join(dir, 'settings.json');
    const real = hookCommand(
      'claude',
      process.execPath,
      join(process.cwd(), 'dist', 'cli.js'),
      false,
    );
    write(file, {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `SETHER_IDENTITY=1 ${real}` }] }],
      },
    });
    expect(inspect('claude', file, () => false)).toMatchObject({ entries: 1, problems: [] });
  });
});

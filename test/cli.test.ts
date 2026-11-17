// The built CLI, run the way an agent runs it: JSON on stdin, decision on stdout.
// `npm test` builds first (pretest), so dist/cli.js is always current.

import { spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { configFingerprint, configFromEnv } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { AWS_KEY } from './fixtures.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (args: string[], stdin = '', env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      SETHER_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), 'sether-cli-')),
      // A gateway running on the developer's machine must not change results.
      ANTHROPIC_BASE_URL: '',
      ...env,
    },
  });

describe('sether-hook (built)', () => {
  it('blocks for each agent from real hook input', () => {
    for (const [agent, word] of [
      ['claude', 'block'],
      ['codex', 'block'],
      ['gemini', 'deny'],
    ] as const) {
      const res = run(
        ['check', '--agent', agent],
        JSON.stringify({ prompt: `key ${AWS_KEY} please` }),
      );
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).decision).toBe(word);
    }
  });

  it('allows a clean prompt with no output at all', () => {
    const res = run(['check', '--agent', 'claude'], JSON.stringify({ prompt: 'add a unit test' }));
    expect(res).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('honours environment settings', () => {
    const res = run(
      ['check', '--agent', 'codex'],
      JSON.stringify({ prompt: 'mail me@mycompany.dev' }),
      {
        SETHER_IGNORE: 'me@mycompany.dev',
      },
    );
    expect(res.stdout).toBe('');
  });

  it('scan prints masks and the clean version, exit 1 when something is found', () => {
    const found = run(['scan', 'ping ngozi.adeyemi@gmail.com']);
    expect(found.status).toBe(1);
    expect(found.stdout).toContain('email: n•••@g•••.com');
    expect(found.stdout).toContain('ping [EMAIL_1]');
    expect(found.stdout).not.toContain('ngozi.adeyemi@gmail.com');
    expect(run(['scan'], 'nothing here').status).toBe(0);
  });

  it('rejects bad usage with exit 64', () => {
    expect(run(['check', '--agent', 'cursor']).status).toBe(64);
    expect(run(['frobnicate']).status).toBe(64);
  });

  it('reports its version, equal to package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(run(['--version']).stdout.trim()).toBe(VERSION);
  });

  it('makes no network connection while checking', () => {
    // Block every outbound socket in the child; a check that tried one would crash.
    const guard = join(mkdtempSync(join(tmpdir(), 'sether-net-')), 'no-net.cjs');
    writeFileSync(
      guard,
      "const net=require('net');const die=()=>{throw new Error('network call')};net.connect=die;net.createConnection=die;require('dns').lookup=die;",
    );
    const res = spawnSync(
      process.execPath,
      ['--require', guard, CLI, 'check', '--agent', 'claude'],
      {
        input: JSON.stringify({ prompt: 'email ngozi.adeyemi@gmail.com' }),
        encoding: 'utf8',
        env: { ...process.env, SETHER_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), 'sether-cli-')) },
      },
    );
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).decision).toBe('block');
  });
});

describe('sether-hook (built): install, status, usage errors', () => {
  const inHome = (args: string[], home: string, cwd = home) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

  it('installs, reports OK, then reports Node gone after an "upgrade"', () => {
    const home = mkdtempSync(join(tmpdir(), 'sether-home-'));
    expect(inHome(['install', 'claude'], home).status).toBe(0);
    const ok = inHome(['status'], home);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Claude Code: OK');

    // Simulate an nvm upgrade: rewrite the node path to one that no longer exists.
    const file = join(home, '.claude', 'settings.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        JSON.stringify(process.execPath).slice(1, -1),
        '/nonexistent/node',
      ),
    );
    const broken = inHome(['status'], home);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('Node is no longer at /nonexistent/node');
  });

  it('writes --project into the current directory, and warns about committing it', () => {
    const home = mkdtempSync(join(tmpdir(), 'sether-home-'));
    const project = mkdtempSync(join(tmpdir(), 'sether-proj-'));
    const res = inHome(['install', 'codex', '--project'], home, project);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(join(project, '.codex', 'hooks.json'));
    expect(res.stdout).toContain('install with --portable');
  });

  it('rejects a mistyped option instead of installing somewhere else', () => {
    const home = mkdtempSync(join(tmpdir(), 'sether-home-'));
    const res = inHome(['install', 'claude', '--porject'], home);
    expect(res.status).toBe(64);
    expect(res.stderr).toContain('unknown option --porject');
    expect(inHome(['status'], home).stdout).toContain('No agent settings files found');
  });

  it('check without --agent is a usage error, not a guess', () => {
    expect(run(['check', 'claude']).status).toBe(64);
  });
});

describe('sether-hook gateway (built)', () => {
  it('rejects bad options with a usage error instead of starting', () => {
    for (const args of [
      ['gateway', '--bogus'],
      ['gateway', '--port'],
      ['gateway', '--port', '0'],
      ['gateway', '--upstream', 'http://example.com'],
      ['gateway', '--upstream', 'not a url'],
    ]) {
      expect(run(args).status).toBe(64);
    }
  });

  it('listens on loopback, answers the health probe and stops cleanly on SIGTERM', async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve) =>
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)),
    );
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const child = spawn(process.execPath, [CLI, 'gateway', '--port', String(port)], {
      env: { ...process.env, ANTHROPIC_BASE_URL: '' },
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    let out = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('is running')) resolve();
      });
      child.on('exit', () => reject(new Error(`gateway exited early: ${out}`)));
    });
    expect(out).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port} claude`);

    const health = await new Promise<string>((resolve, reject) => {
      get(`http://127.0.0.1:${port}/__sether/health`, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    expect(JSON.parse(health)).toEqual({
      sether: 'gateway',
      version: VERSION,
      config: configFingerprint(configFromEnv(process.env)),
    });

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});

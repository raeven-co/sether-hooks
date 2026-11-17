// The gateway: request cleaning (pure) and the local server, driven against a
// fake upstream that records exactly what would have left the machine.
// Request shapes mirror what Claude Code 2.1.220 sends (captured 2026-11-17
// against a fake Anthropic server): billing header block, cached system
// blocks, a <system-reminder> user block, mid-conversation system messages,
// thinking blocks with signatures, tool_use and tool_result.

import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { check } from '../src/check.js';
import { createDetect, DEFAULT_CONFIG, type Detect } from '../src/engine/engine.js';
import {
  CleanError,
  cleanRequest,
  FindingCache,
  MAX_SLOT_CHARS,
  PlaceholderBook,
} from '../src/gateway/clean.js';
import { gatewayAnswers, gatewayCandidate, loopbackBaseUrl } from '../src/gateway/probe.js';
import { createGateway, HEALTH_PATH, isPlanLogin } from '../src/gateway/server.js';
import { AWS_KEY, SLACK_USER_TOKEN } from './fixtures.js';

const detect = createDetect(DEFAULT_CONFIG);
const EMAIL = 'ngozi.adeyemi@gmail.com';
const OTHER_EMAIL = 'tunde.bakare@northstar.dev';
const PHONE = '+234 803 412 7789';
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.220.81c; cc_entrypoint=cli;';
const THINKING = { type: 'thinking', thinking: '', signature: 'EpQBCkYIBRgCKkBsig+/=' };
const IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};
const PLANTED = [EMAIL, OTHER_EMAIL, PHONE, AWS_KEY, SLACK_USER_TOKEN];

type Body = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function claudeCodeRequest(): Body {
  return {
    model: 'claude-opus-5',
    max_tokens: 64000,
    stream: true,
    thinking: { type: 'adaptive', display: 'omitted' },
    metadata: { user_id: 'user_abc_account_def_session_ghi' },
    system: [
      { type: 'text', text: BILLING },
      {
        type: 'text',
        text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'You are an interactive agent that helps with software engineering.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    tools: [
      {
        name: 'Bash',
        description: `Runs a shell command. Maintainer: ${OTHER_EMAIL}`,
        input_schema: { type: 'object' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<system-reminder>\n# userEmail\nThe user's email address is ${EMAIL}.\n</system-reminder>`,
          },
          { type: 'text', text: `deploy with key ${AWS_KEY} and text ${PHONE} when done` },
        ],
      },
      { role: 'system', content: `Available agent types. Escalations go to ${OTHER_EMAIL}.` },
      {
        role: 'assistant',
        content: [
          THINKING,
          { type: 'text', text: 'Running it.' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: {
              command: `aws configure set aws_access_key_id ${AWS_KEY}`,
              description: 'Set the key',
            },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: `notified ${EMAIL}; token ${SLACK_USER_TOKEN}`,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_02',
            content: [{ type: 'text', text: `owner: ${OTHER_EMAIL}` }, IMAGE],
          },
        ],
      },
    ],
  };
}

describe('cleanRequest', () => {
  it('leaves no planted value anywhere the model reads', () => {
    const { body } = cleanRequest(claudeCodeRequest(), { detect });
    const sent = JSON.stringify({ ...body, tools: undefined });
    for (const value of PLANTED) expect(sent).not.toContain(value);
  });

  it('numbers values by first appearance and reuses a placeholder for the same value', () => {
    const { body, replaced } = cleanRequest(claudeCodeRequest(), { detect });
    const messages = body.messages as Array<{ content: unknown }>;
    const first = (messages[0]?.content as Array<{ text: string }>).map((b) => b.text);
    expect(first[0]).toContain('[EMAIL_1]');
    expect(first[1]).toContain('[AWS_KEY_1]');
    const toolResults = messages[3]?.content as Array<{ content: unknown }>;
    expect(toolResults[0]?.content).toContain('notified [EMAIL_1]');
    expect(messages[1]?.content).toContain('[EMAIL_2]');
    expect((toolResults[1]?.content as Array<{ text?: string }>)[0]?.text).toBe('owner: [EMAIL_2]');
    expect(replaced.get('EMAIL')).toBe(2);
  });

  it('cleans tool call arguments but never their keys, ids or names', () => {
    const { body } = cleanRequest(claudeCodeRequest(), { detect });
    const assistant = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2];
    const call = assistant?.content[2] as {
      id: string;
      name: string;
      input: Record<string, string>;
    };
    expect(call.id).toBe('toolu_01');
    expect(call.name).toBe('Bash');
    expect(Object.keys(call.input)).toEqual(['command', 'description']);
    expect(call.input.command).toBe('aws configure set aws_access_key_id [AWS_KEY_1]');
  });

  it('never touches the billing header, cache settings, thinking, images, metadata or tools', () => {
    const original = claudeCodeRequest();
    const { body } = cleanRequest(clone(original), { detect });
    expect(body.system).toEqual(original.system);
    expect(body.metadata).toEqual(original.metadata);
    expect(body.tools).toEqual(original.tools);
    expect(body.thinking).toEqual(original.thinking);
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[2]?.content[0]).toEqual(THINKING);
    expect(messages[2]?.content[2]?.cache_control).toEqual({ type: 'ephemeral' });
    expect((messages[3]?.content[1]?.content as unknown[])[1]).toEqual(IMAGE);
  });

  it('cleans the same history the same way on the next turn, so cache prefixes hold', () => {
    const turn1 = claudeCodeRequest();
    const turn2 = claudeCodeRequest();
    (turn2.messages as unknown[]).push(
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: `also cc ${OTHER_EMAIL} and paul.okeke@yahoo.com` },
    );
    const a = cleanRequest(turn1, { detect }).body;
    const b = cleanRequest(turn2, { detect }).body;
    const bMessages = b.messages as unknown[];
    expect(JSON.stringify(bMessages.slice(0, 4))).toBe(JSON.stringify(a.messages));
    expect(bMessages[5]).toEqual({ role: 'user', content: 'also cc [EMAIL_2] and [EMAIL_3]' });
  });

  it('hides a value everywhere once it is caught anywhere', () => {
    const SECRET = 'Q7-ROTATE-ME-91';
    const contextual: Detect = (text) => {
      const at = text.indexOf(`code: ${SECRET}`);
      return at < 0
        ? []
        : [{ type: 'PASSWORD', value: SECRET, start: at + 6, end: at + 6 + SECRET.length }];
    };
    const { body } = cleanRequest(
      {
        messages: [
          { role: 'user', content: `the door code: ${SECRET}` },
          { role: 'assistant', content: `I will not repeat ${SECRET} anywhere.` },
        ],
      },
      { detect: contextual },
    );
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect((body.messages as Array<{ content: string }>)[1]?.content).toBe(
      'I will not repeat [PASSWORD_1] anywhere.',
    );
  });

  it('only replaces short values where they were found', () => {
    const short: Detect = (text) => {
      const at = text.indexOf('pin 4471');
      return at < 0 ? [] : [{ type: 'PASSWORD', value: '4471', start: at + 4, end: at + 8 }];
    };
    const { body } = cleanRequest(
      { messages: [{ role: 'user', content: 'pin 4471, room 4471' }] },
      { detect: short },
    );
    expect((body.messages as Array<{ content: string }>)[0]?.content).toBe(
      'pin [PASSWORD_1], room 4471',
    );
  });

  it('skips placeholder names the conversation already uses', () => {
    const { body } = cleanRequest(
      { messages: [{ role: 'user', content: `earlier I sent [EMAIL_1]; now email ${EMAIL}` }] },
      { detect },
    );
    expect((body.messages as Array<{ content: string }>)[0]?.content).toBe(
      'earlier I sent [EMAIL_1]; now email [EMAIL_2]',
    );
  });

  it('returns a request with nothing sensitive unchanged', () => {
    const plain = {
      model: 'm',
      messages: [{ role: 'user', content: 'refactor the parser please' }],
    };
    const { body, replaced } = cleanRequest(clone(plain), { detect });
    expect(body).toEqual(plain);
    expect(replaced.size).toBe(0);
  });

  it('fails closed: a scan error, an oversized part or a non-object body throws', () => {
    const broken: Detect = () => {
      throw new Error('detector exploded');
    };
    expect(() => cleanRequest(claudeCodeRequest(), { detect: broken })).toThrow(
      'detector exploded',
    );
    expect(() =>
      cleanRequest(
        { messages: [{ role: 'user', content: 'x'.repeat(MAX_SLOT_CHARS + 1) }] },
        { detect },
      ),
    ).toThrow(CleanError);
    expect(() => cleanRequest([], { detect })).toThrow(CleanError);
    let t = 0;
    expect(() =>
      cleanRequest(claudeCodeRequest(), { detect, budgetMs: 5, now: () => (t += 10) }),
    ).toThrow('took too long');
  });

  it('scans each distinct block once across requests', () => {
    let calls = 0;
    const counting: Detect = (text) => {
      calls += 1;
      return detect(text);
    };
    const cache = new FindingCache();
    cleanRequest(claudeCodeRequest(), { detect: counting, cache });
    const first = calls;
    cleanRequest(claudeCodeRequest(), { detect: counting, cache });
    expect(first).toBeGreaterThan(0);
    expect(calls).toBe(first);
  });
});

describe('isPlanLogin', () => {
  it('spots Claude plan logins by token or beta flag, and lets API keys through', () => {
    expect(isPlanLogin({ authorization: 'Bearer sk-ant-oat01-abc' })).toBe(true);
    expect(isPlanLogin({ 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' })).toBe(true);
    expect(isPlanLogin({ 'x-api-key': 'sk-ant-api03-abc' })).toBe(false);
    expect(isPlanLogin({ authorization: 'Bearer corp-gateway-token' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The server, against a fake upstream.

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const SSE =
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n';

let upstream: Server;
let upstreamUrl: string;
let seen: Seen[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/v1/messages') || req.url?.startsWith('/prefix/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock' });
        res.end(SSE);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(req.method === 'HEAD' ? undefined : 'upstream ok');
      }
    });
  });
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
});

afterAll(() => {
  upstream.close();
});

beforeEach(() => {
  seen = [];
});

async function withGateway<T>(
  run: (port: number, logs: string[]) => Promise<T>,
  over: { upstream?: string; maxBodyBytes?: number } = {},
): Promise<T> {
  const logs: string[] = [];
  const cache = new FindingCache();
  const book = new PlaceholderBook();
  const gateway = createGateway({
    upstream: new URL(over.upstream ?? upstreamUrl),
    version: 'test',
    configFingerprint: 'test-config',
    clean: (body) => cleanRequest(body, { detect, cache, book }),
    log: (line) => logs.push(line),
    maxBodyBytes: over.maxBodyBytes,
  });
  const port = await listen(gateway);
  try {
    return await run(port, logs);
  } finally {
    gateway.closeAllConnections();
    gateway.close();
  }
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  opts: { headers?: OutgoingHttpHeaders; body?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          'content-type': 'application/json',
          ...opts.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const API_KEY = { 'x-api-key': 'sk-ant-api03-test', 'anthropic-version': '2023-06-01' };
const errorType = (reply: Reply): string =>
  (JSON.parse(reply.body) as { error: { type: string } }).error.type;

describe('gateway server', () => {
  it('forwards a cleaned request with its query and credentials, and streams the reply back untouched', async () => {
    await withGateway(async (port, logs) => {
      const reply = await send(port, 'POST', '/v1/messages?beta=true', {
        headers: { ...API_KEY, 'anthropic-beta': 'claude-code-20250219' },
        body: JSON.stringify(claudeCodeRequest()),
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toBe(SSE);
      expect(reply.headers['request-id']).toBe('req_mock');
      expect(seen).toHaveLength(1);
      const out = seen[0] as Seen;
      expect(out.url).toBe('/v1/messages?beta=true');
      expect(out.headers['x-api-key']).toBe('sk-ant-api03-test');
      expect(out.headers['anthropic-beta']).toBe('claude-code-20250219');
      expect(Number(out.headers['content-length'])).toBe(Buffer.byteLength(out.body));
      const sent = JSON.parse(out.body) as Body;
      const modelReads = JSON.stringify({ ...sent, tools: undefined });
      for (const value of PLANTED) expect(modelReads).not.toContain(value);
      expect(logs.join('\n')).toMatch(/200, cleaned \d+ values \(/);
      for (const value of PLANTED) expect(logs.join('\n')).not.toContain(value);
    });
  });

  it('cleans token counting too', async () => {
    await withGateway(async (port) => {
      await send(port, 'POST', '/v1/messages/count_tokens?beta=true', {
        headers: API_KEY,
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: `mail ${EMAIL}` }],
        }),
      });
      expect(seen[0]?.url).toBe('/v1/messages/count_tokens?beta=true');
      expect(seen[0]?.body).not.toContain(EMAIL);
      expect(seen[0]?.body).toContain('[EMAIL_1]');
    });
  });

  it('refuses Claude plan logins without forwarding anything', async () => {
    await withGateway(async (port) => {
      for (const headers of [
        { authorization: 'Bearer sk-ant-oat01-abcdef' },
        { authorization: 'Bearer something-else', 'anthropic-beta': 'oauth-2025-04-20' },
      ]) {
        const reply = await send(port, 'POST', '/v1/messages', {
          headers,
          body: JSON.stringify(claudeCodeRequest()),
        });
        expect(reply.status).toBe(403);
        expect(errorType(reply)).toBe('permission_error');
        expect(reply.body).toContain('plan logins');
      }
      expect(seen).toHaveLength(0);
    });
  });

  it('answers every other endpoint locally', async () => {
    await withGateway(async (port) => {
      for (const [method, path] of [
        ['POST', '/v1/files'],
        ['GET', '/v1/models'],
        ['POST', '/api/event_logging/batch'],
        ['PUT', '/v1/messages'],
      ] as const) {
        const reply = await send(port, method, path, { headers: API_KEY, body: '{}' });
        expect(reply.status).toBe(404);
      }
      expect(seen).toHaveLength(0);
    });
  });

  it('refuses requests not addressed to loopback, or sent by a web page', async () => {
    await withGateway(async (port) => {
      const body = JSON.stringify(claudeCodeRequest());
      const rebound = await send(port, 'POST', '/v1/messages', {
        headers: API_KEY,
        body,
        host: `attacker.example:${port}`,
      });
      expect(rebound.status).toBe(403);
      const fromPage = await send(port, 'POST', '/v1/messages', {
        headers: { ...API_KEY, origin: 'https://attacker.example' },
        body,
      });
      expect(fromPage.status).toBe(403);
      expect(seen).toHaveLength(0);
    });
  });

  it('passes Claude Code connectivity probes through', async () => {
    await withGateway(async (port) => {
      expect((await send(port, 'GET', '/')).body).toBe('upstream ok');
      expect((await send(port, 'HEAD', '/api/hello')).status).toBe(200);
      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /', 'HEAD /api/hello']);
    });
  });

  it('never forwards a body it could not read, parse or check', async () => {
    await withGateway(async (port) => {
      const bad = await send(port, 'POST', '/v1/messages', {
        headers: API_KEY,
        body: '{"messages": [',
      });
      expect(bad.status).toBe(400);
      expect(errorType(bad)).toBe('invalid_request_error');
      expect(bad.body).toContain('nothing was sent');
      expect(seen).toHaveLength(0);
    });
    await withGateway(
      async (port) => {
        const big = await send(port, 'POST', '/v1/messages', {
          headers: API_KEY,
          body: JSON.stringify(claudeCodeRequest()),
        });
        expect(big.status).toBe(413);
        expect(seen).toHaveLength(0);
      },
      { maxBodyBytes: 256 },
    );
  });

  it('keeps a path prefix on the upstream URL (company gateways)', async () => {
    await withGateway(
      async (port) => {
        await send(port, 'POST', '/v1/messages?beta=true', {
          headers: API_KEY,
          body: JSON.stringify(claudeCodeRequest()),
        });
        expect(seen[0]?.url).toBe('/prefix/v1/messages?beta=true');
      },
      { upstream: `${upstreamUrl}/prefix/` },
    );
  });

  it('reports an unreachable upstream as an error, never a hang', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    dead.close();
    await withGateway(
      async (port) => {
        const reply = await send(port, 'POST', '/v1/messages', {
          headers: API_KEY,
          body: '{"messages":[]}',
        });
        expect(reply.status).toBe(502);
        expect(errorType(reply)).toBe('api_error');
      },
      { upstream: `http://127.0.0.1:${deadPort}` },
    );
  });
});

describe('prompt hook and gateway together', () => {
  it('answers the health probe, and only a Sether gateway counts', async () => {
    await withGateway(async (port) => {
      const health = await send(port, 'GET', HEALTH_PATH);
      expect(JSON.parse(health.body)).toEqual({
        sether: 'gateway',
        version: 'test',
        config: 'test-config',
      });
      const url = new URL(`http://127.0.0.1:${port}`);
      expect(await gatewayAnswers(url, 'test-config')).toBe(true);
      // Different detection settings than the hook's: the hook keeps working.
      expect(await gatewayAnswers(url, 'other-config')).toBe(false);
    });
    expect(await gatewayAnswers(new URL(upstreamUrl), 'test-config')).toBe(false);
    const dead = createServer();
    const deadPort = await listen(dead);
    dead.close();
    expect(await gatewayAnswers(new URL(`http://127.0.0.1:${deadPort}`), 'test-config')).toBe(
      false,
    );
  });

  it('only treats a plain-http loopback ANTHROPIC_BASE_URL as a possible gateway', () => {
    expect(loopbackBaseUrl('http://127.0.0.1:8742')?.port).toBe('8742');
    expect(loopbackBaseUrl('http://localhost:8742/')).not.toBeNull();
    expect(loopbackBaseUrl('https://api.anthropic.com')).toBeNull();
    expect(loopbackBaseUrl('http://gateway.corp.example:8742')).toBeNull();
    expect(loopbackBaseUrl('not a url')).toBeNull();
    expect(loopbackBaseUrl(undefined)).toBeNull();
  });

  it('lets Claude Code prompts through when the gateway is active, and still stops them for other agents', () => {
    const stdin = JSON.stringify({ prompt: `email ${EMAIL}` });
    const stateDir = mkdtempSync(join(tmpdir(), 'sether-gateway-test-'));
    const base = { config: DEFAULT_CONFIG, copy: false, failOpen: false, now: 1, stateDir };
    expect(check(stdin, { ...base, agent: 'claude', gatewayActive: true }).stdout).toBe('');
    expect(check(stdin, { ...base, agent: 'codex', gatewayActive: true }).stdout).toContain(
      '"decision":"block"',
    );
  });
});

// ---------------------------------------------------------------------------
// Regressions from the independent review of the gateway (2026-11-17). Each
// failed before its fix.

type Message = { role: string; content: unknown };
const CARD = '4539148803436467';

describe('review fixes: cleaning', () => {
  it('hides the bare secret of a caught assignment, in every format', () => {
    const token = 'Q2xhdWRlR2F0ZXdheVRlc3RUb2tlbjEyMzQ1Njc4';
    const cases: Array<[string, string]> = [
      ['DB_PASSWORD=Tr0ub4dor&3xyz', 'Tr0ub4dor&3xyz'],
      ['{"password": "Tr0ub4dor&3xyz"}', 'Tr0ub4dor&3xyz'],
      ['password: Tr0ub4dor&3xyz', 'Tr0ub4dor&3xyz'],
      ['DATABASE_URL=postgres://app:Rk7vpQ2xL9wM@db.northstar.dev:5432/orders', 'Rk7vpQ2xL9wM'],
      [`Authorization: Bearer ${token}`, token],
    ];
    for (const [assignment, secret] of cases) {
      const { body } = cleanRequest(
        {
          messages: [
            { role: 'user', content: assignment },
            { role: 'assistant', content: `retry with ${secret} now` },
          ],
        },
        { detect },
      );
      expect(JSON.stringify(body), assignment).not.toContain(secret);
    }
  });

  it('keeps a value on the same placeholder across turns, even when the model repeats it', () => {
    const book = new PlaceholderBook();
    const cache = new FindingCache();
    const first = { role: 'user', content: `email ${EMAIL} the report` };
    const reply = { role: 'assistant', content: 'I will email [EMAIL_1] now.' };
    const turn = (rest: Message[]) => ({ messages: [clone(first), ...clone(rest)] });
    const t1 = cleanRequest(turn([]), { detect, book, cache }).body;
    const t2 = cleanRequest(turn([reply, { role: 'user', content: 'thanks' }]), {
      detect,
      book,
      cache,
    }).body;
    const t3 = cleanRequest(
      turn([
        reply,
        { role: 'user', content: 'thanks' },
        reply,
        { role: 'user', content: `and ${OTHER_EMAIL}` },
      ]),
      { detect, book, cache },
    ).body;
    for (const t of [t1, t2, t3]) {
      expect((t.messages as Message[])[0]?.content).toBe('email [EMAIL_1] the report');
    }
    expect((t3.messages as Message[])[4]?.content).toBe('and [EMAIL_2]');
  });

  it('still hides a value in a later request after the block that revealed it is gone', () => {
    const SECRET = 'Q7-ROTATE-ME-91';
    const contextual: Detect = (text) => {
      const at = text.indexOf(`code: ${SECRET}`);
      return at < 0
        ? []
        : [{ type: 'PASSWORD', value: SECRET, start: at + 6, end: at + 6 + SECRET.length }];
    };
    const book = new PlaceholderBook();
    cleanRequest(
      { messages: [{ role: 'user', content: `door code: ${SECRET}` }] },
      { detect: contextual, book },
    );
    const { body } = cleanRequest(
      { messages: [{ role: 'user', content: `is ${SECRET} still valid?` }] },
      { detect: contextual, book },
    );
    expect((body.messages as Message[])[0]?.content).toBe('is [PASSWORD_1] still valid?');
  });

  it('skips only an exact one-line billing header', () => {
    const exact = { system: [{ type: 'text', text: BILLING }], messages: [] };
    expect(cleanRequest(clone(exact), { detect }).body).toEqual(exact);
    const smuggled = { system: `${BILLING}\nKey ${AWS_KEY}`, messages: [] };
    expect(JSON.stringify(cleanRequest(smuggled, { detect }).body)).not.toContain(AWS_KEY);
  });

  it('scans citations, tool argument keys and numbers, search results and object-shaped tool output', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'See the note.',
              citations: [
                {
                  type: 'char_location',
                  cited_text: `contact ${EMAIL}`,
                  document_index: 0,
                  document_title: `Notes for ${OTHER_EMAIL}`,
                  start_char_index: 0,
                  end_char_index: 10,
                },
              ],
            },
            {
              type: 'tool_use',
              id: 'toolu_9',
              name: 'crm_update',
              input: { [EMAIL]: { card: Number(CARD), tier: 2 } },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_9',
              content: [
                {
                  type: 'search_result',
                  source: `https://crm.example.com/u/${EMAIL}`,
                  title: `Profile of ${OTHER_EMAIL}`,
                  content: [{ type: 'text', text: 'ok' }],
                },
              ],
            },
            {
              type: 'web_fetch_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: {
                type: 'web_fetch_result',
                url: 'https://example.com',
                content: {
                  type: 'document',
                  source: { type: 'text', media_type: 'text/plain', data: `owner ${EMAIL}` },
                },
              },
            },
            {
              type: 'bash_code_execution_tool_result',
              tool_use_id: 'srvtoolu_2',
              content: {
                type: 'bash_code_execution_result',
                stdout: `key ${AWS_KEY}`,
                stderr: '',
                return_code: 0,
              },
            },
          ],
        },
      ],
    };
    const { body: cleaned } = cleanRequest(body, { detect });
    const sent = JSON.stringify(cleaned);
    for (const value of [EMAIL, OTHER_EMAIL, AWS_KEY, CARD]) expect(sent).not.toContain(value);
    const call = (cleaned.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      ?.content[1];
    expect(call?.id).toBe('toolu_9');
    expect(call?.name).toBe('crm_update');
    const input = call?.input as Record<string, { card: unknown; tier: unknown }>;
    expect(Object.keys(input)).toEqual(['[EMAIL_1]']);
    expect(input['[EMAIL_1]']?.card).toMatch(/^\[[A-Z_]+_1\]$/);
    expect(input['[EMAIL_1]']?.tier).toBe(2);
  });

  it('cleans a text document sent base64-encoded, and leaves binary documents alone', () => {
    const encoded = Buffer.from(`mail ${EMAIL} today`, 'utf8').toString('base64');
    const pdf = { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' };
    const { body } = cleanRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'text/plain', data: encoded },
              },
              { type: 'document', source: pdf },
            ],
          },
        ],
      },
      { detect },
    );
    const blocks = (body.messages as Array<{ content: Array<{ source: { data: string } }> }>)[0]
      ?.content;
    expect(Buffer.from(blocks?.[0]?.source.data ?? '', 'base64').toString('utf8')).toBe(
      'mail [EMAIL_1] today',
    );
    expect(blocks?.[1]?.source).toEqual(pdf);
  });

  it('refuses a request whose signed reasoning holds a sensitive value', () => {
    const withThinking = (thinking: string) => ({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking, signature: 'sig' },
            { type: 'text', text: 'ok' },
          ],
        },
      ],
    });
    expect(() => cleanRequest(withThinking(`I should email ${EMAIL}`), { detect })).toThrow(
      CleanError,
    );
    expect(() => cleanRequest(withThinking('I should email [EMAIL_1]'), { detect })).not.toThrow();
    expect(() => cleanRequest(withThinking(''), { detect })).not.toThrow();
  });

  it('leaves no tail when two known values overlap', () => {
    const pairs: Detect = (text) =>
      ['PREFIX-AAAA1234', '1234-TAILSECRET'].flatMap((value) => {
        const at = text.indexOf(`[${value}]`);
        return at < 0
          ? []
          : [{ type: 'PASSWORD', value, start: at + 1, end: at + 1 + value.length }];
      });
    const { body } = cleanRequest(
      {
        messages: [
          { role: 'user', content: 'a [PREFIX-AAAA1234] b [1234-TAILSECRET]' },
          { role: 'user', content: 'joined PREFIX-AAAA1234-TAILSECRET here' },
        ],
      },
      { detect: pairs },
    );
    const second = (body.messages as Message[])[1]?.content as string;
    expect(second).not.toContain('TAILSECRET');
    expect(second).not.toContain('AAAA1234');
  });
});

describe('review fixes: server and hook', () => {
  it('closes the client connection when the upstream drops mid-reply', async () => {
    const dropping = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {}\n\n');
        setTimeout(() => res.socket?.destroy(), 50);
      });
    });
    const droppingUrl = `http://127.0.0.1:${await listen(dropping)}`;
    try {
      await withGateway(
        async (port) => {
          const started = Date.now();
          const ended = await new Promise<string>((resolve) => {
            const req = request(
              {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: '/v1/messages',
                headers: { host: `127.0.0.1:${port}`, ...API_KEY },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve('end'));
                res.on('error', () => resolve('error'));
                res.on('close', () => resolve('close'));
              },
            );
            req.on('error', () => resolve('error'));
            req.end('{"messages":[]}');
          });
          expect(['end', 'error', 'close']).toContain(ended);
          expect(Date.now() - started).toBeLessThan(5000);
        },
        { upstream: droppingUrl },
      );
    } finally {
      dropping.close();
    }
  });

  it('does not forward a request encoding or headers named in Connection', async () => {
    await withGateway(async (port) => {
      await send(port, 'POST', '/v1/messages', {
        headers: {
          ...API_KEY,
          'content-encoding': 'gzip',
          connection: 'keep-alive, x-hop',
          'x-hop': 'hop-value',
        },
        body: '{"messages":[]}',
      });
      expect(seen[0]?.headers['content-encoding']).toBeUndefined();
      expect(seen[0]?.headers['x-hop']).toBeUndefined();
      expect(seen[0]?.headers['x-api-key']).toBe('sk-ant-api03-test');
    });
  });

  it('spots a plan token hidden behind an API key in a repeated header', () => {
    expect(isPlanLogin({ 'x-api-key': 'sk-ant-api03-a, sk-ant-oat01-b' })).toBe(true);
    expect(isPlanLogin({ authorization: 'Basic x, Bearer sk-ant-oat01-b' })).toBe(true);
  });

  it('spots the plan-login beta flag in any case or separator', () => {
    expect(isPlanLogin({ 'anthropic-beta': 'claude-code-20250219 OAUTH-2025-04-20' })).toBe(true);
    expect(isPlanLogin({ 'anthropic-beta': 'claude-code-20250219,  Oauth-2025-04-20' })).toBe(true);
  });

  it('never steps aside when Claude Code is set to Bedrock, Vertex or Foundry', () => {
    const local = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8742' };
    expect(gatewayCandidate(local)?.port).toBe('8742');
    for (const flag of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      expect(gatewayCandidate({ ...local, [flag]: '1' }), flag).toBeNull();
    }
    expect(gatewayCandidate({ ...local, CLAUDE_CODE_USE_BEDROCK: '0' })).not.toBeNull();
  });

  it('gives up on a slow health answer within the time limit', async () => {
    const trickle = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => res.write(' '), 100);
      res.on('close', () => clearInterval(timer));
    });
    const port = await listen(trickle);
    try {
      const started = Date.now();
      expect(await gatewayAnswers(new URL(`http://127.0.0.1:${port}`), 'test-config', 300)).toBe(
        false,
      );
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      trickle.closeAllConnections();
      trickle.close();
    }
  });
});

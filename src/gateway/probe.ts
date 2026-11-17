// Lets the prompt hook step aside when Claude Code's requests already go
// through a running Sether gateway, which cleans them instead of stopping them.
// All of these must hold, or the hook does its normal job:
// - ANTHROPIC_BASE_URL is a plain-http loopback URL;
// - Claude Code is not set to Bedrock, Vertex or Foundry (it then ignores
//   ANTHROPIC_BASE_URL, so the gateway would never see the prompt);
// - that URL answers the health check as a Sether gateway, within the time
//   limit, with the same detection settings as the hook's own.

import { get } from 'node:http';

import { HEALTH_PATH } from './server.js';

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CLOUD_PROVIDERS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

export function loopbackBaseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url : null;
}

/** Where Claude Code sends its model requests, when that could be a local gateway. */
export function gatewayCandidate(env: Env): URL | null {
  if (CLOUD_PROVIDERS.some((name) => isSet(env[name]))) return null;
  return loopbackBaseUrl(env.ANTHROPIC_BASE_URL);
}

/** True only for a Sether gateway with the expected settings, answered in
 *  time. The limit covers the whole exchange, so a slow trickle cannot hold
 *  the hook past the agent's timeout. */
export function gatewayAnswers(
  base: URL,
  expectedConfig: string,
  timeoutMs = 800,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const target = new URL(base.href);
    target.pathname = base.pathname.replace(/\/+$/, '') + HEALTH_PATH;
    target.search = '';
    const req = get(target, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          const answer = JSON.parse(body) as { sether?: unknown; config?: unknown };
          done(
            res.statusCode === 200 &&
              answer.sether === 'gateway' &&
              answer.config === expectedConfig,
          );
        } catch {
          done(false);
        }
      });
      res.on('error', () => done(false));
      res.on('close', () => done(false));
    });
    timer = setTimeout(() => {
      req.destroy();
      done(false);
    }, timeoutMs);
    req.on('error', () => done(false));
  });
}

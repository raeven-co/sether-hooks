// The local gateway: Claude Code sends its model requests here (through its
// ANTHROPIC_BASE_URL setting), each request is cleaned, and only the clean
// version goes on to Anthropic or the company gateway. Responses come back
// byte for byte.
//
// Fails closed: a request that cannot be cleaned is answered with an error
// and never forwarded. Only the two message endpoints carry text out; every
// other path is answered locally, so no unknown endpoint can leak a prompt.

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream';

import { CleanError, type CleanResult } from './clean.js';

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_PORT = 8742;

/** Answers a health probe from the prompt hook, so the hook can step aside. */
export const HEALTH_PATH = '/__sether/health';

const CLEANED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
/** Connectivity probes Claude Code sends before its first request. */
const PROBE_PATHS = new Set(['/', '/api/hello']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // The body is re-serialised as plain JSON, and nothing waits for 100-continue.
  'content-encoding',
  'expect',
]);
/** A reply that goes quiet this long is cut off (Anthropic sends pings). */
const UPSTREAM_IDLE_MS = 10 * 60 * 1000;

export interface GatewayOptions {
  upstream: URL;
  clean: (body: unknown) => CleanResult;
  version: string;
  /** Detection settings, so the prompt hook steps aside only for a gateway
   *  that checks the way it would. */
  configFingerprint: string;
  log?: (line: string) => void;
  maxBodyBytes?: number;
}

type ErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'not_found_error'
  | 'permission_error'
  | 'request_too_large'
  | 'api_error';

function sendError(
  res: ServerResponse,
  method: string | undefined,
  status: number,
  type: ErrorType,
  message: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(method === 'HEAD' ? undefined : body);
}

/** A Claude Pro/Max login. The gateway is for API keys and company gateways
 *  only: a plan login belongs to Anthropic's own app. */
export function isPlanLogin(headers: IncomingHttpHeaders): boolean {
  // Anywhere in either credential header: Node joins repeated headers with
  // ", ", so a plan token can sit behind an API key in one value.
  const credentials = [headers.authorization, headers['x-api-key']].flat().join(' ');
  const beta = [headers['anthropic-beta']].flat().join(',');
  return /sk-ant-oat/i.test(credentials) || /(^|[\s,])oauth-/i.test(beta);
}

/** Only loopback names: a web page that rebinds its own domain to 127.0.0.1
 *  still sends its domain in Host, and is refused. */
function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Headers a Connection header names are hop-by-hop too. */
function connectionNamed(headers: IncomingHttpHeaders): Set<string> {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set(named);
}

function forwardHeaders(
  headers: IncomingHttpHeaders,
  bodyLength: number | null,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const named = connectionNamed(headers);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  if (bodyLength !== null) out['content-length'] = bodyLength;
  return out;
}

/** Upstream reply headers, byte-for-byte body: its own encoding and length stay. */
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const named = connectionNamed(headers);
  const keep = new Set(['content-length', 'content-encoding']);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || named.has(name)) continue;
    if (HOP_BY_HOP.has(name) && !keep.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function targetUrl(upstream: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://gateway.invalid');
  const target = new URL(upstream.href);
  target.pathname = upstream.pathname.replace(/\/+$/, '') + incoming.pathname;
  target.search = incoming.search;
  return target;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  body: Buffer | null,
  onDone: (status: number) => void,
): void {
  const target = targetUrl(upstream, req.url ?? '/');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let finished = false;
  const done = (status: number): void => {
    if (finished) return;
    finished = true;
    onDone(status);
  };
  const outgoing = send(
    target,
    { method: req.method, headers: forwardHeaders(req.headers, body ? body.length : null) },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      res.writeHead(status, responseHeaders(upstreamRes.headers));
      // pipeline, not pipe: if the upstream drops mid-reply, the client's
      // connection is closed too instead of hanging.
      pipeline(upstreamRes, res, (err) => {
        if (err) res.destroy();
        done(err ? 502 : status);
      });
    },
  );
  outgoing.setTimeout(UPSTREAM_IDLE_MS, () => {
    outgoing.destroy(new Error('the upstream went quiet'));
  });
  outgoing.on('error', (err) => {
    sendError(
      res,
      req.method,
      502,
      'api_error',
      `Sether gateway could not reach ${target.host}: ${err.message}`,
    );
    done(502);
  });
  res.on('close', () => {
    if (!res.writableFinished) outgoing.destroy();
  });
  outgoing.end(body ?? undefined);
}

function summary(replaced: Map<string, number>): string {
  if (replaced.size === 0) return 'nothing to clean';
  const total = [...replaced.values()].reduce((a, b) => a + b, 0);
  return `cleaned ${total} value${total === 1 ? '' : 's'} (${[...replaced.keys()].join(', ')})`;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayOptions,
): Promise<void> {
  const log = opts.log ?? (() => {});
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://gateway.invalid').pathname;
  const port = req.socket.localPort ?? 0;

  if (!isLoopbackHost(req.headers.host, port)) {
    sendError(
      res,
      method,
      403,
      'permission_error',
      'Sether gateway only answers requests addressed to 127.0.0.1 or localhost.',
    );
    return;
  }
  if (req.headers.origin !== undefined) {
    sendError(
      res,
      method,
      403,
      'permission_error',
      'Sether gateway does not accept requests from web pages.',
    );
    return;
  }
  if (method === 'GET' && path === HEALTH_PATH) {
    const body = JSON.stringify({
      sether: 'gateway',
      version: opts.version,
      config: opts.configFingerprint,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && PROBE_PATHS.has(path)) {
    forward(req, res, opts.upstream, null, () => {});
    return;
  }
  if (method !== 'POST' || !CLEANED_PATHS.has(path)) {
    sendError(
      res,
      method,
      404,
      'not_found_error',
      `Sether gateway does not forward ${method} ${path}.`,
    );
    log(`${method} ${path} -> 404 (not forwarded)`);
    return;
  }
  if (isPlanLogin(req.headers)) {
    // 403, not 401: Claude Code answers a 401 by refreshing the login and
    // retrying with backoff for minutes, so the user would see a hang
    // instead of this message.
    sendError(
      res,
      method,
      403,
      'permission_error',
      'Sether gateway does not pass Claude plan logins through. Use an API key (ANTHROPIC_API_KEY) or your company gateway, or use the Sether prompt hook instead: unset ANTHROPIC_BASE_URL and run "sether-hook install claude".',
    );
    log(`${method} ${path} -> 403 (plan login refused, not forwarded)`);
    return;
  }

  const raw = await readBody(req, opts.maxBodyBytes ?? 64 * 1024 * 1024);
  if (raw === null) {
    sendError(
      res,
      method,
      413,
      'request_too_large',
      'Sether gateway refused a request larger than it checks; nothing was sent.',
    );
    log(`${method} ${path} -> 413 (too large, not forwarded)`);
    return;
  }
  let result: CleanResult;
  try {
    result = opts.clean(JSON.parse(raw.toString('utf8')));
  } catch (err) {
    const why =
      err instanceof SyntaxError
        ? 'the request was not valid JSON'
        : err instanceof Error
          ? err.message
          : String(err);
    const status = err instanceof CleanError || err instanceof SyntaxError ? 400 : 500;
    sendError(
      res,
      method,
      status,
      status === 400 ? 'invalid_request_error' : 'api_error',
      `Sether could not check this request, so nothing was sent (${why}).`,
    );
    log(`${method} ${path} -> ${status} (could not check: ${why}; not forwarded)`);
    return;
  }
  const cleaned = Buffer.from(JSON.stringify(result.body), 'utf8');
  forward(req, res, opts.upstream, cleaned, (status) =>
    log(`${method} ${path} -> ${status}, ${summary(result.replaced)}`),
  );
}

export function createGateway(opts: GatewayOptions): Server {
  return createServer((req, res) => {
    handle(req, res, opts).catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err);
      sendError(
        res,
        req.method,
        500,
        'api_error',
        `Sether gateway failed, so nothing was sent (${why}).`,
      );
    });
  });
}

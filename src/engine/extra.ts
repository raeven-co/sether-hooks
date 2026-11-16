// Detectors the hook adds on top of @raeven-co/sether and the ported
// credentials pack, for what developers paste into coding agents. Each is
// anchored on a fixed prefix or a key name, so precision stays high; the
// code-noise filters in context.ts still apply to every CREDENTIAL match.
// Candidates for upstreaming into @raeven-co/sether.

import type { Detector, DetectorMatch, PhoneDetectorOptions } from '@raeven-co/sether';
import { isValidPhoneNumber } from 'libphonenumber-js';

function regexDetector(type: string, re: RegExp): Detector {
  return {
    type,
    detect(text) {
      const out: DetectorMatch[] = [];
      for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue;
        out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
      }
      return out;
    },
  };
}

// ── Phone numbers in data rows ────────────────────────────────────────────────
// libphonenumber skips a number whose neighbours are numeric too
// (`14.50,08031234567,4532…` in a CSV row), though it finds the same number
// in prose. Fallback: whole delimited tokens of digits, validated by
// libphonenumber for the configured regions (or as international with `+`).

type CountryCode = NonNullable<PhoneDetectorOptions['defaultCountry']>;

const PHONE_WORD =
  /\b(?:phone|phones|tel|telephone|mobile|cell|cellphone|msisdn|whatsapp|sms|contact)\b/gi;

/** Where phone words occur, to ask whether a position has one within the
 *  4 KB before it (a CSV header, a JSON key) or 200 characters after. */
function phoneContext(text: string): { near: (pos: number) => boolean } {
  const at = [...text.matchAll(PHONE_WORD)].map((m) => m.index ?? 0);
  return {
    near(pos) {
      let lo = 0;
      let hi = at.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((at[mid] ?? 0) < pos - 4096) lo = mid + 1;
        else hi = mid;
      }
      return lo < at.length && (at[lo] ?? 0) <= pos + 200;
    },
  };
}

export function createDelimitedPhoneDetector(regions: readonly CountryCode[]): Detector {
  return {
    type: 'PHONE',
    detect(text) {
      const out: DetectorMatch[] = [];
      // Group 1 is the delimiter before the token (consumed); the one after is
      // only looked at, so `,123…,456…` yields both tokens.
      const re = /(^|[\s,;|"'([{:=])(\+?\d[\d-]{5,17}\d)(?=$|[\s,;|"')\]}])/gm;
      const context = phoneContext(text);
      for (const m of text.matchAll(re)) {
        if (m.index === undefined || m[2] === undefined) continue;
        const token = m[2];
        const start = m.index + (m[1]?.length ?? 0);
        // A bare digit column is as often an id as a phone (most 10-digit ids
        // validate for the US). Without a `+`, a dash, or a phone column or
        // key nearby, leave it.
        if (!/[+-]/.test(token) && !context.near(start)) continue;
        const digits = token.replace(/\D/g, '').length;
        if (digits < 7 || digits > 15) continue;
        const valid = token.startsWith('+')
          ? isValidPhoneNumber(token)
          : regions.some((r) => isValidPhoneNumber(token, r));
        if (valid) out.push({ start, end: start + token.length, value: token });
      }
      return out;
    },
  };
}

// ── Prefixed tokens ───────────────────────────────────────────────────────────
// The library's Slack pattern fits three-segment bot tokens only; user (xoxp),
// app-level (xoxa) and refresh (xoxr) tokens are caught here.
export const slackTokenDetector = regexDetector(
  'SLACK_TOKEN',
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,250}/g,
);
export const googleApiKeyDetector = regexDetector(
  'GOOGLE_API_KEY',
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
);
export const npmTokenDetector = regexDetector('NPM_TOKEN', /\bnpm_[A-Za-z0-9]{36}\b/g);
export const gitlabTokenDetector = regexDetector('GITLAB_TOKEN', /\bglpat-[A-Za-z0-9_-]{20,64}/g);

// ── Authorization headers ─────────────────────────────────────────────────────
//   Authorization: Basic dXNlcjpwYXNzd29yZA==
//   Authorization: Bearer 3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e

const PLACEHOLDER_TOKEN = /^(?:[A-Z_]+|<.*|\$.*|\{\{.*|x{6,}|your.*|token|api[_-]?key)$/i;

export const authHeaderDetector: Detector = {
  type: 'AUTH_HEADER',
  detect(text) {
    const out: DetectorMatch[] = [];
    // `Authorization: …`, or any auth-named key holding a scheme and credential
    // (`AUTH_HEADER=Basic …`, `"authorization": "Bearer …"`).
    const re =
      /\b(?:Authorization|[A-Za-z_]{0,40}auth[A-Za-z_]{0,40})["']?\s*[:=]\s*["']?(?:Basic|Bearer|Token)\s+([A-Za-z0-9._~+/=-]{12,500})/gi;
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || !m[1] || PLACEHOLDER_TOKEN.test(m[1])) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── A private key pasted without its END line ─────────────────────────────────
// The credentials pack needs BEGIN…END; a truncated paste still carries most
// of the key. Walked line by line rather than with a nested-quantifier regex.

const PEM_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const BASE64_LINE = /^[A-Za-z0-9+/=]{16,}$/;
const PEM_FIELD = /^[A-Za-z-]+: /; // Proc-Type: / DEK-Info: in encrypted keys

export const truncatedPrivateKeyDetector: Detector = {
  type: 'PRIVATE_KEY',
  detect(text) {
    const out: DetectorMatch[] = [];
    for (const m of text.matchAll(PEM_HEADER)) {
      if (m.index === undefined) continue;
      const start = m.index;
      let end = start + m[0].length;
      const nextHeader = text.indexOf('-----BEGIN', end);
      const endLine = text.indexOf('-----END', end);
      if (endLine !== -1 && (nextHeader === -1 || endLine < nextHeader)) continue; // complete: the pack has it
      let body = 0;
      let pos = end;
      while (pos < text.length) {
        const nl = text.indexOf('\n', pos + 1);
        const lineEnd = nl === -1 ? text.length : nl;
        const line = text.slice(pos, lineEnd).trim();
        if (line === '' && body === 0) {
          pos = lineEnd;
          continue;
        }
        if (BASE64_LINE.test(line)) body++;
        else if (!(PEM_FIELD.test(line) && body === 0)) break;
        end = lineEnd;
        pos = lineEnd;
      }
      if (body > 0) out.push({ start, end, value: text.slice(start, end) });
    }
    return out;
  },
};

// ── Credentials under any key spelling ────────────────────────────────────────
//   {"password": "Xk29dkLqp!"}   "client_secret": "…"   api_key: …
//   aws_secret_access_key = wJalr…   db_password = "…"   dbPassword: "…"
//   PGPASSWORD=… psql   apiKey := "…" (Go)   DB_PASSWORD ?= … (make)
//   https://api.vendor.io/v1/data?token=…   if password == "…":
// The credentials pack only knows upper-case env names and a few lower-case
// words; this matches the key by its last word, in any case or quoting.

/** A key names a secret when it contains a secret word followed only by
 *  words that do not change what it holds: `dbPassword`, `client_secret`,
 *  `tokenValue`, `password1`, `password_old`, `secret_key_base`, `db_pass`.
 *  `key` counts after a qualifier (`aws_secret_access_key`, `jwtKey`). Not:
 *  `max_tokens`, `tokenizer`, `tokenPrice`, `secret_scanning`,
 *  `passwordStrength`, `passwordHash`. */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'pass',
  'pwd',
  'secret',
  'token',
  'otp',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'authkey',
]);
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'secret',
  'private',
  'auth',
  'encryption',
  'decryption',
  'signing',
  'master',
  'client',
  'service',
  'app',
  'license',
  'jwt',
  'hmac',
  'ssh',
  'gpg',
  'pgp',
  'rsa',
  'aes',
  'session',
  'cookie',
  'webhook',
  'shared',
  'sas',
]);
/** Words after the secret word that leave its meaning alone. */
const NEUTRAL_AFTER =
  /^(?:\d+|value|val|old|new|current|curr|prev|previous|base|raw|plain|str|string|b64|base64|hex|encoded|enc|key|primary|secondary|backup|main|default|prod|dev|test|staging|local)$/;
const SINGLE_WORD_SECRET = /(?:password|passwd|pwd|secret|token|apikey|passphrase)$/;

export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 1 && SINGLE_WORD_SECRET.test(words[0] ?? '')) return true; // PGPASSWORD, MYSQLPWD
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i] ?? '';
    const secret =
      SECRET_WORDS.has(word) || (word === 'key' && KEY_QUALIFIERS.has(words[i - 1] ?? ''));
    if (secret) return words.slice(i + 1).every((w) => NEUTRAL_AFTER.test(w));
  }
  return false;
}

const ASSIGNMENTS = new Set([':=', '?=', '+=', '=', ':']);

export const keyedCredentialDetector: Detector = {
  type: 'CREDENTIAL',
  detect(text) {
    const out: DetectorMatch[] = [];
    // Key and operator are consumed; the value is only looked at (lookahead),
    // so a non-sensitive `url=https://…` cannot swallow a `token=` inside it.
    const re =
      /["']?\b([A-Za-z][A-Za-z0-9_.-]{0,60})["']?[ \t]*(:=|\?=|\+=|===|!==|==|!=|=(?![=>])|:(?![/:]))[ \t]*(?=("[^"\n]{1,300}"|'[^'\n]{1,300}'|\$\{\{[^}\n]{1,100}\}\}|[^\s"'`,;)\]}&]{1,300}))/g;
    for (const m of text.matchAll(re)) {
      const [, key, operator, value] = m;
      if (m.index === undefined || !key || !operator || !value) continue;
      if (!isSensitiveKey(key)) continue;
      const quoted = /^["']/.test(value);
      // A comparison only names a secret when it compares with a literal.
      if (!ASSIGNMENTS.has(operator) && !quoted) continue;
      const raw = value.replace(/^["']|["']$/g, '');
      if (raw.length < 4) continue;
      const end = m.index + m[0].length + value.length;
      out.push({ start: m.index, end, value: text.slice(m.index, end) });
    }
    return out;
  },
};

export const extraDetectors: readonly Detector[] = [
  slackTokenDetector,
  googleApiKeyDetector,
  npmTokenDetector,
  gitlabTokenDetector,
  authHeaderDetector,
  truncatedPrivateKeyDetector,
  keyedCredentialDetector,
];

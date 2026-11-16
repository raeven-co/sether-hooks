// Code-context precision filters.
//
// Started as a port of sether-vscode/src/core/context.ts, which was tuned for
// scanning source files. A hook guards what leaves the machine, so when a
// rule is unsure it must keep the finding: two independent reviews found
// editor rules dropping real phones, cards and passwords in prompts, and
// each rule below now only removes a finding when the value cannot be a
// secret. Differences from the editor copy:
// - no "numeric data line" rule (it dropped phones and cards in CSV rows,
//   prices and JSON); glued-number rules below still catch SVG paths;
// - operators are parsed (`:=`, `?=`, `+=` assign; `==` with a quoted literal
//   is still a secret);
// - config-key suffixes, references and placeholders are exact, and never
//   apply to a value that looks like a secret;
// - credential URLs on non-local hosts are never "default local credentials".
//
// These filters only ever REMOVE findings.

const NUMERIC_TYPES = new Set(['PHONE', 'IPV4', 'CC']);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z]/.test(c);
}

function isAlnum(c: string | undefined): boolean {
  return isDigit(c) || isLetter(c);
}

const VERSION_CONTEXT =
  /(?:\bversion|\bver\.?|\bbump(?:ed)?(?: to)?|\brelease|\btag(?:ged)?|\bbuild|Version\(["']?)\s*["']?$/i;

function isNumericNoise(
  type: string,
  value: string,
  text: string,
  start: number,
  end: number,
): boolean {
  const prev = text[start - 1];
  const prev2 = text[start - 2];
  const next = text[end];
  const next2 = text[end + 1];

  // Glued to a larger number or identifier: `.7577 1195 31.`, `AW-17199115802`,
  // `id171...`, SVG path data `M4155552671.5`.
  if (isDigit(prev) || prev === '.' || isLetter(prev)) return true;
  if (prev === '-' && isAlnum(prev2)) return true;
  if (next === '.' && isDigit(next2)) return true;
  if (isLetter(next)) return true;
  // File names and URL slugs: `Group 1597886316.svg`, `articles/42728983564564-Responsible`.
  if (next === '.' && isLetter(next2)) return true;
  if (next === '-' && isLetter(next2)) return true;

  if (type === 'CC') {
    // Millisecond / microsecond timestamps pass Luhn one time in ten, and no
    // card network issues numbers starting with 1. Numeric ids in URL paths
    // are not cards either.
    if (/^1\d+$/.test(value)) return true;
    if (prev === '/') return true;
  }
  if (type === 'PHONE') {
    // A fraction with 5+ digits is a float, not a phone group: `0.707107 10 24.7949`.
    if (/\.\d{5,}/.test(value)) return true;
    // Bare 10 digits starting with 1: a unix timestamp. No NANP area code starts with 1.
    if (/^1\d{9}$/.test(value)) return true;
    // Semver at the head: changelog headers like `0.7.1 — 2026-09-23` parse as
    // phones (found dogfooding on sether's own CHANGELOG). No phone is `d.d.d`.
    if (/^\d+\.\d+\.\d/.test(value)) return true;
    // An ISO date inside the candidate is release-line noise, never a phone.
    if (/\d{4}-\d{2}-\d{2}/.test(value)) return true;
  }
  if (type === 'IPV4') {
    // Versions, not hosts: `Chrome/120.0.0.0` (a product name before the
    // slash), `v1.2.3.4`, `bump to 2.3.4.5`, `AssemblyVersion("1.2.0.0")`.
    // `db.prod.internal/34.120.5.66:5432` is a host (Java/Netty logs): the
    // word before the slash has dots, or a port follows.
    if (prev === '/' && prev2 !== '/') {
      const word = /[A-Za-z][\w.-]*$/.exec(text.slice(Math.max(0, start - 65), start - 1))?.[0];
      if (word && !word.includes('.') && next !== ':') return true;
    }
    if (prev === 'v' || prev === 'V') return true;
    if (VERSION_CONTEXT.test(text.slice(Math.max(0, start - 24), start))) return true;
  }
  return false;
}

const EXPRESSION_VALUE = /^(?:new\s|[A-Za-z_$][\w$]*\s*(?:\?\.|\.|\(|\[))/;
// Unicode-aware: i18n values like `كلمة` or `Passwort` are identifiers-shaped too.
const BARE_IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const HAS_DIGIT = /\p{N}/u;
const LETTERS_AND_SPACES = /^[\p{L}\s]+$/u;

/** First operator after the key. `:=`, `?=`, `+=` assign (Go, Makefiles).
 *  Exported for the mask, which must cut at the same place. */
export const OPERATOR = /\s*(===|!==|==|!=|<=|>=|=>|:=|\?=|\+=|=|:)\s*/;
const COMPARISONS = new Set(['===', '!==', '==', '!=', '<=', '>=', '=>']);

const CONFIG_KEY_SUFFIX =
  /_(?:MIN|MAX|LEN|LENGTH|TTL|TIMEOUT|COUNT|LIMIT|SIZE|RE|REGEX|PATTERN|FIELD|LABEL|KEY_NAME|NAME|EXPIRY|EXPIRES|EXPIRES_IN|EXPIRATION|ROUNDS|PROVIDER|PATH|FILE|DIR|HOST|PORT|ALGORITHM|ALG|ISSUER|AUDIENCE|ENABLED|MODE|TYPE|VERSION|HEADER|SCOPE|SCOPES|STRATEGY|DOMAIN|REGION|POLICY)$/i;
/** `AUTH_URL=https://…`: an address, not a secret, unless it carries
 *  credentials (`REDIS_URL=redis://:pw@host`) or an opaque token in its path
 *  or query (a Slack webhook URL). */
const URL_KEY_SUFFIX = /_(?:URL|URI|ENDPOINT|CALLBACK|REDIRECT|REDIRECT_URI)$/i;
/** Shell and CI references, matched whole: `$DB_PASSWORD` (upper-case, as env
 *  names are), `${TOKEN}`, `$(cat f)`, `%TOKEN%`, `${{ secrets.X }}`. A literal
 *  that merely starts with `$` (`$ecretP4ss!`) is a password. */
const SHELL_REFERENCE =
  /^(?:\$[A-Z_][A-Z0-9_]*|\$\{\{[^}\n]{1,100}\}\}|\$\{[^}\n]{1,100}\}|\$\([^)\n]{1,200}\)|%[A-Za-z_][A-Za-z0-9_]*%)$/;
/** Placeholders, matched whole. */
const PLACEHOLDER =
  /^(?:<[^>\n]{0,60}>|\{\{[^}\n]{0,60}\}\}|your[-_ ][\w-]*|x{3,}|\*{3,}|\.{3}|changeme|change_me|placeholder|redacted|todo|none|null|undefined)$/i;
/** Literal words that are settings or schema values, never secrets:
 *  `credentials: 'include'` (fetch), `"password": "string"` (Swagger
 *  examples), `token: "refresh"`, `password: "required"`. */
const NON_SECRET_WORDS = new Set([
  'include',
  'omit',
  'same-origin',
  'string',
  'required',
  'optional',
  'refresh',
  'access',
  'bearer',
  'basic',
  'password',
  'secret',
  'token',
  'hidden',
  'text',
  'true',
  'false',
  'enabled',
  'disabled',
  'example',
  'sample',
]);
/** A filesystem path, recognisably one: `~/…`, `./…`, `../…`, a home or
 *  system directory, or a last segment with an extension. A base64 secret
 *  that happens to start with `/` is not. */
function isPath(value: string): boolean {
  if (!/^(?:~|\.{1,2})?\/[\w.\-/ ]*$/.test(value)) return false;
  if (/^(?:~|\.{1,2})\//.test(value)) return true;
  if (
    /^\/(?:Users|home|var|etc|opt|tmp|usr|srv|mnt|app|workspace|root|private|Volumes)\//.test(value)
  ) {
    return true;
  }
  return /\.[a-z0-9]{1,6}$/i.test(value.split('/').pop() ?? '');
}
/** UI text that names its own field: `"New password"`, `"Forgot your
 *  password?"`, `"Show"` under `showPassword`. Up to nine words, first
 *  capitalised, the rest lower case, and at least one word from the key. A
 *  passphrase (`"Correct horse battery staple"`) does not repeat its key. */
function isFieldText(text: string, key: string): boolean {
  const words = text.replace(/[.?!]$/, '').split(' ');
  if (words.length > 9) return false;
  if (!words.every((w, i) => (i === 0 ? /^[A-Z][a-z]+$/ : /^[a-z]+$/).test(w))) return false;
  const fromKey = new Set(keyWords(key));
  return words.some((w) => fromKey.has(w.toLowerCase()));
}

const characterClasses = (raw: string, symbols: RegExp): number =>
  [/[a-z]/, /[A-Z]/, /\d/, symbols].filter((r) => r.test(raw)).length;

/** A value shaped like a secret rather than a setting: an auth scheme with a
 *  credential, or 8+ characters mixing three of lower, upper, digit, symbol. */
function looksSecret(raw: string): boolean {
  if (/^(?:Basic|Bearer|Token)\s+\S{8,}/i.test(raw)) return true;
  if (raw.length < 8) return false;
  return characterClasses(raw, /[^A-Za-z0-9]/) >= 3;
}

/** Stricter, for values under a config-named key (`SECRET_REGION`,
 *  `AUTH_PROVIDER`): `-`, `.`, `/`, `_` do not count as symbols there
 *  (`us-east-1`, `v2.1.0-Beta`, `kv/data/App1` are settings), so it takes a
 *  real symbol, or 16+ mixed characters, to count as a secret. */
function looksStrongSecret(raw: string): boolean {
  if (/^(?:Basic|Bearer|Token)\s+\S{8,}/i.test(raw)) return true;
  const realSymbol = /[^A-Za-z0-9\-._/]/.test(raw);
  if (realSymbol && raw.length >= 8 && characterClasses(raw, /[^A-Za-z0-9]/) >= 3) return true;
  return raw.length >= 16 && characterClasses(raw, /[^A-Za-z0-9]/) >= 3;
}

/** A URL whose path or query carries an opaque token (16+ characters mixing
 *  letters and digits): `https://hooks.slack.com/services/T0…/B0…/AbCd…`. */
function urlCarriesToken(url: string): boolean {
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') // the host is never the token
    .split(/[/?&=#]/)
    .some(
      (part) =>
        /^[\w-]+$/.test(part) &&
        ((part.length >= 16 && /[A-Za-z]/.test(part) && /\d/.test(part)) ||
          (part.length >= 20 && /[a-z]/.test(part) && /[A-Z]/.test(part))),
    );
}

/** `forgotPassword` → [forgot, password]; `password1` → [password, 1]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** `KEY=value` / `key: value` where the value is code, a reference, a setting
 *  or UI text rather than a literal secret. */
function isCredentialNoise(value: string): boolean {
  const op = OPERATOR.exec(value);
  if (!op || op[1] === undefined) return false;
  const operator = op[1];
  // A mapping that opens a block (`password:\n  type: string` in OpenAPI or
  // JSON-schema YAML): the next line is the schema, not the value.
  if (op[0].slice(op[0].indexOf(operator) + operator.length).includes('\n')) return true;
  const key = value
    .slice(0, op.index)
    .trim()
    .replace(/^["'`]|["'`]$/g, '');
  const raw = value
    .slice(op.index + op[0].length)
    .trim()
    .replace(/[,;)\]}]+$/, '');
  if (raw.length === 0) return true;
  const quoted = /^["'`]/.test(raw);
  const inner = raw.replace(/^["'`]|["'`]$/g, '');

  if (COMPARISONS.has(operator)) {
    // `apiKey === undefined` and `token === "pending"` are code;
    // `password == "Xk29dkLqp!"` is a secret.
    return !quoted || /^[a-z_-]+$/.test(inner);
  }
  if (raw.startsWith('`') && !raw.endsWith('`')) return true; // fragment of a template literal

  if (inner.length === 0) return true;
  if (inner.toLowerCase() === key.toLowerCase()) return true; // password: password
  if (SHELL_REFERENCE.test(inner) || PLACEHOLDER.test(inner)) return true;
  if (inner.startsWith('${')) return true; // interpolation, even when cut short at a space
  if (NON_SECRET_WORDS.has(inner.toLowerCase())) return true;
  if (quoted && isFieldText(inner, key)) return true;
  if (isPath(inner)) return true;
  if (URL_KEY_SUFFIX.test(key) && /^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i.test(inner)) {
    return !urlCarriesToken(inner);
  }
  if (CONFIG_KEY_SUFFIX.test(key)) return !looksStrongSecret(inner); // TOKEN_EXPIRY = 3600
  if (looksSecret(inner)) return false;

  // Below here the value is short or simple.
  if (URL_KEY_SUFFIX.test(key) && !inner.includes('@')) return true;
  if (quoted) {
    // i18n and label tables: `Password: "Passwort"`.
    if (/^\p{Lu}\p{Ll}/u.test(key) && LETTERS_AND_SPACES.test(inner)) return true;
    return false; // any other quoted literal is a literal
  }

  if (/^[[{(<]/.test(raw)) return true; // array, object, group, JSX
  if (EXPRESSION_VALUE.test(raw)) return true; // values.password, Yup.string(), new RegExp(...)
  // A bare identifier with no digit is a variable reference in code (lower-case
  // key, or `:` as in object literals / YAML). Env files use `=` with
  // upper-case keys, and there bare words ARE the value.
  const codeKey = /[a-z]/.test(key) || operator === ':';
  return codeKey && BARE_IDENTIFIER.test(raw) && !HAS_DIGIT.test(raw);
}

/**
 * Label-anchored PASSWORD values: prose like "the password is below", or code
 * like `password: values.password` once the wider CREDENTIAL match is gone.
 */
function isPasswordNoise(value: string): boolean {
  const raw = value.replace(/[,;)\]}]+$/, '');
  if (/^[=>]/.test(raw)) return true; // the rest of `password === confirmPassword`
  const inner = raw.replace(/^["'`]|["'`]$/g, '');
  if (SHELL_REFERENCE.test(inner) || PLACEHOLDER.test(inner)) return true;
  if (looksSecret(inner)) return false;
  if (/^[[{(<]/.test(raw) || raw.startsWith('${')) return true;
  if (EXPRESSION_VALUE.test(raw)) return true;
  return BARE_IDENTIFIER.test(raw) && !HAS_DIGIT.test(raw);
}

const PLACEHOLDER_PASSWORDS = new Set([
  'password',
  'pass',
  'passwd',
  'postgres',
  'mysql',
  'root',
  'admin',
  'user',
  'secret',
  'example',
  'changeme',
  'change_me',
  'test',
  'guest',
  'xxx',
  'xxxx',
  'xxxxx',
  'xxxxxx',
]);

/** `postgres://postgres:postgres@localhost`: a default credential on a local
 *  or compose-service host. The same pair on a real host is a leak. */
function isDbUriNoise(value: string): boolean {
  const m = /^[a-z+]+:\/\/([^\s:/@]+):([^\s@]+)@([^\s:/?#]*)/i.exec(value);
  if (!m) return false;
  const host = (m[3] ?? '').toLowerCase();
  const local =
    host === 'localhost' || host.startsWith('127.') || host === '0.0.0.0' || !host.includes('.');
  if (!local) return false;
  const user = (m[1] ?? '').toLowerCase();
  const password = (m[2] ?? '').toLowerCase();
  if (password === user) return true;
  if (PLACEHOLDER_PASSWORDS.has(password)) return true;
  return password.startsWith('${') || password.startsWith('<') || password.startsWith('{{');
}

/**
 * True when a match is noise in a source-code context. `text` is the full
 * prompt; `start`/`end` are the match offsets.
 */
export function isNoiseInCode(
  type: string,
  value: string,
  text: string,
  start: number,
  end: number,
): boolean {
  if (NUMERIC_TYPES.has(type)) return isNumericNoise(type, value, text, start, end);
  if (type === 'CREDENTIAL') return isCredentialNoise(value);
  if (type === 'PASSWORD') return isPasswordNoise(value);
  if (type === 'DB_URI') return isDbUriNoise(value);
  return false;
}

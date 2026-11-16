// Credential & secret detectors.
//
// Catches infrastructure secrets that end up in code, configs and AI prompts:
//
// 1. Database connection strings with embedded passwords (MongoDB, Postgres, ...)
// 2. Environment variable credential assignments (SECRET_KEY=..., DB_PASSWORD=...)
// 3. Generic password/secret assignments in code snippets
// 4. PEM-encoded private keys
//
// All patterns are ReDoS-safe and run locally.
//
// Ported from sether-vscode/src/core/credentials.ts (itself from
// sether-shield/src/credentials.ts). Hook change to port back: the bounded
// DB_URI pattern below (the original is quadratic on long unbroken text). Candidate for upstreaming into
// @raeven-co/sether as a `credentialsDetectors` pack so Shield, the editor,
// the hooks and the library share one source. Until then, keep the copies
// identical.

import type { Detector } from '@raeven-co/sether/browser';

// ── 1. Database connection strings ────────────────────────────────────────────
//   mongodb+srv://acco_user:yv7G@cluster0.huckxlg.mongodb.net/
//   postgres://admin:secretpass@db.example.com:5432/mydb

export const dbConnectionStringDetector: Detector = {
  type: 'DB_URI',
  detect(text: string) {
    const regex =
      // User and password are bounded: unbounded `[^\s:]+:[^\s@]+@` rescans to the end
      // of every whitespace-free run, which made minified JSON full of
      // `redis://host:6379` URLs quadratic (13 s for 600 KB). The user part may be
      // empty (`redis://:password@host`) and, per RFC 3986, holds no `/` or `@`.
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis(?:s)?|amqp(?:s)?|ftp(?:s)?|mssql|cockroachdb):\/\/[^\s:/@]{0,256}:[^\s@]{1,256}@[^\s"'`,;\])}>]+/gi;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 2. Environment variable credential assignments ────────────────────────────
//   MONGODB_URI=mongodb+srv://user:pass@host.net/
//   SECRET_KEY=a8f2e9b1c3d4e5f6
//   DB_PASSWORD=hunter2

/** Env var name segments that independently signal a credential. */
const SENSITIVE_SEGMENTS = new Set([
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'TOKEN',
  'CREDENTIAL',
  'AUTH',
  'PRIVATE',
]);

/** Compound substrings in env var names that signal credentials. */
const SENSITIVE_COMPOUNDS = [
  'API_KEY',
  'ACCESS_KEY',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'ENCRYPTION_KEY',
  'SIGNING_KEY',
  'MASTER_KEY',
  'SERVICE_KEY',
  'APP_KEY',
  'MONGODB_URI',
  'MONGO_URI',
  'MONGO_URL',
  'DATABASE_URL',
  'DATABASE_URI',
  'DB_URL',
  'DB_URI',
  'DB_DSN',
  'DB_PASS',
  'DB_PASSWORD',
  'REDIS_URL',
  'REDIS_URI',
  'POSTGRES_URL',
  'POSTGRES_URI',
  'PG_URL',
  'PG_URI',
  'MYSQL_URL',
  'MYSQL_URI',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'FIREBASE_URL',
  'FIREBASE_KEY',
  'CONNECTION_STRING',
  'CONN_STR',
  'CONN_STRING',
  'CLIENT_SECRET',
  'CLIENT_ID',
  'JWT_SECRET',
  'SESSION_SECRET',
  'COOKIE_SECRET',
  'WEBHOOK_SECRET',
  'SIGNING_SECRET',
];

function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const parts = upper.split('_');
  if (parts.some((p) => SENSITIVE_SEGMENTS.has(p))) return true;
  return SENSITIVE_COMPOUNDS.some((c) => upper.includes(c));
}

/** Values that are clearly placeholders, not real credentials. */
const PLACEHOLDER_VALUES = new Set([
  'null',
  'undefined',
  'none',
  'true',
  'false',
  'your_secret_here',
  'your_key_here',
  'change_me',
  'changeme',
  'xxxxxxxx',
  'todo',
]);

export const envCredentialDetector: Detector = {
  type: 'CREDENTIAL',
  detect(text: string) {
    const regex = /\b([A-Z][A-Z0-9_]{2,})\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined || !m[1] || !m[2]) continue;
      if (!isSensitiveEnvName(m[1])) continue;
      const rawValue = m[2].replace(/^["']|["']$/g, '');
      if (
        !rawValue ||
        rawValue.length < 2 ||
        PLACEHOLDER_VALUES.has(rawValue.toLowerCase()) ||
        (rawValue.startsWith('<') && rawValue.endsWith('>')) ||
        (rawValue.startsWith('${') && rawValue.endsWith('}')) ||
        (rawValue.startsWith('{{') && rawValue.endsWith('}}'))
      ) {
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 3. Generic password / secret assignments ──────────────────────────────────
//   password: "hunter2"
//   secret = "abc123"
//   api_key: sk-1234567890

const NON_CREDENTIAL_VALUES = new Set([
  'true',
  'false',
  'yes',
  'no',
  'none',
  'null',
  'undefined',
  'required',
  'optional',
  'empty',
  'blank',
  'default',
  'example',
  'string',
  'number',
  'boolean',
  'password',
  'secret',
]);

export const genericPasswordDetector: Detector = {
  type: 'CREDENTIAL',
  detect(text: string) {
    const regex =
      /\b(password|passwd|pass(?:word|wd)?|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|master[_-]?key|encryption[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined || !m[2]) continue;
      const rawValue = m[2].replace(/^["']|["']$/g, '');
      if (
        !rawValue ||
        rawValue.length < 2 ||
        NON_CREDENTIAL_VALUES.has(rawValue.toLowerCase()) ||
        (rawValue.startsWith('<') && rawValue.endsWith('>')) ||
        (rawValue.startsWith('${') && rawValue.endsWith('}')) ||
        (rawValue.startsWith('{{') && rawValue.endsWith('}}')) ||
        rawValue.startsWith('process.env') ||
        rawValue.startsWith('os.environ') ||
        rawValue.startsWith('env(')
      ) {
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 4. PEM private keys ───────────────────────────────────────────────────────

export const privateKeyDetector: Detector = {
  type: 'PRIVATE_KEY',
  detect(text: string) {
    const regex =
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

export const credentialDetectors: readonly Detector[] = [
  dbConnectionStringDetector,
  envCredentialDetector,
  genericPasswordDetector,
  privateKeyDetector,
];

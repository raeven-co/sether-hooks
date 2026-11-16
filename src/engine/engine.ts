// Detection for prompts on their way to a coding agent.
//
// The real @raeven-co/sether packs, assembled and filtered the way the VS Code
// extension does it (sether-vscode/src/core/engine.ts), because prompts to
// coding agents look like the files the editor scans: pasted code, configs,
// stack traces. Same defaults: network on, identity and high-entropy off,
// reserved/fictional values and code noise never flagged. On top, for a hook
// that must never let a value half through:
// - overlapping findings merge into one span, so the clean version never
//   keeps the tail of a secret;
// - a phone match that swallowed part of the next number is split;
// - the text is scanned in overlapping chunks under a time budget, so no
//   prompt can outrun the agent's hook timeout (where Codex and Gemini CLI
//   let the prompt through).

import {
  basicDetectors,
  secretsDetectors,
  identityDetectors,
  createPhoneDetector,
  createMultiRegionPhoneDetector,
  type Detector,
  type PhoneDetectorOptions,
} from '@raeven-co/sether';
import { isSupportedCountry } from 'libphonenumber-js';

import { credentialDetectors } from './credentials.js';
import { isNoiseInCode } from './context.js';
import { createDelimitedPhoneDetector, extraDetectors } from './extra.js';
import { isReservedValue } from './reserved.js';

export interface Finding {
  /** Detector type, e.g. "EMAIL", "AWS_KEY". */
  type: string;
  /** The matched text. Lives in memory only; never logged or persisted. */
  value: string;
  /** Absolute UTF-16 offsets into the prompt. */
  start: number;
  end: number;
}

export interface EngineConfig {
  /** IPv4 / IPv6 addresses (private and documentation ranges are never flagged). */
  network: boolean;
  /** Label-anchored names, dates of birth, passports, addresses. */
  identity: boolean;
  /** Random-looking strings with no known prefix. Noisy on hashes and ids. */
  highEntropy: boolean;
  phoneRegions: readonly string[];
  /** Exact values never to flag (the user's own test fixtures, say). */
  ignoreValues: readonly string[];
}

export const DEFAULT_CONFIG: EngineConfig = {
  network: true,
  identity: false,
  highEntropy: false,
  phoneRegions: ['US', 'GB', 'NG', 'CA'],
  ignoreValues: [],
};

export interface ScanLimits {
  /** Stop and throw once scanning has taken this long. */
  budgetMs: number;
  /** Characters each chunk owns, and how far it reads past them and before them. */
  chunk: number;
  overlap: number;
  lookbehind: number;
  now: () => number;
}

/** Agents give a hook about 30 s. Detection stops well short of that,
 *  leaving room for Node to start, a slower machine, and the agent. */
export const DEFAULT_LIMITS: ScanLimits = {
  // The deadline is checked between detector calls, and a single call on a
  // pathological 32 KB chunk can take ~2 s (the library email pattern on runs
  // of `1.`), so the worst case stays near 14 s.
  budgetMs: 12_000,
  chunk: 32 * 1024,
  // Longer than any finding the packs produce (a 4096-bit PEM key is ~3.3 KB).
  overlap: 8 * 1024,
  lookbehind: 256,
  now: () => Date.now(),
};

type CountryCode = NonNullable<PhoneDetectorOptions['defaultCountry']>;

/** Keep only regions libphonenumber knows. Unknown codes are skipped, never fatal. */
function validPhoneRegions(regions: readonly string[]): CountryCode[] {
  const out = new Set<CountryCode>();
  for (const raw of regions) {
    const code = raw.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && isSupportedCountry(code)) out.add(code as CountryCode);
  }
  return [...out].slice(0, 12);
}

function buildDetectors(cfg: EngineConfig): Detector[] {
  const regions = validPhoneRegions(cfg.phoneRegions);
  return [
    ...basicDetectors.filter(
      (d) => d.type !== 'PHONE' && (cfg.network || (d.type !== 'IPV4' && d.type !== 'IPV6')),
    ),
    regions.length > 0 ? createMultiRegionPhoneDetector(regions) : createPhoneDetector(),
    createDelimitedPhoneDetector(regions.length > 0 ? regions : ['US']),
    ...secretsDetectors.filter((d) => cfg.highEntropy || d.type !== 'HIGH_ENTROPY'),
    ...credentialDetectors,
    ...extraDetectors,
    ...(cfg.identity ? identityDetectors : []),
  ];
}

/** Placeholders a previous scrub produced must not be flagged again. */
function isAlreadyRedacted(value: string): boolean {
  // • is the • in masks; escaped so the bundle stays ASCII-only.
  return /[*\u2022]{3,}/.test(value) || /^\[[a-z0-9_-]+\]$/i.test(value);
}

/** The literal part of `KEY=value` / `"key": "value"`, for SETHER_IGNORE. */
function assignedValue(value: string): string | undefined {
  const sep = value.search(/[=:]/);
  if (sep < 0) return undefined;
  return value
    .slice(sep + 1)
    .trim()
    .replace(/^["'`]|["'`,;]+$/g, '');
}

/** Merge overlapping findings into their union: earliest start, latest end,
 *  the type of the one that starts first (the longest, on a tie). Dropping
 *  the later one instead left its tail in the clean version:
 *  `CARD_TOKEN=4532 0151 1283 0366` became `[CREDENTIAL_1] 0151 1283 0366`. */
export function mergeOverlaps(findings: Finding[], text: string): Finding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Finding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.start < last.end) {
      if (f.end > last.end) {
        last.end = f.end;
        last.value = text.slice(last.start, last.end);
      }
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

/** libphonenumber can run one match across a list: `415-555-2671, 415` out of
 *  `415-555-2671, 415-555-2672`, leaving `-555-2672` in the clean version.
 *  Cut such a match at the separator and take the next number whole. */
export function splitPhoneLists(findings: Finding[], text: string): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const sep = f.type === 'PHONE' ? /\s*[,;]\s*(?=[+(\d])/.exec(f.value) : null;
    if (!sep) {
      out.push(f);
      continue;
    }
    const leftEnd = f.start + sep.index;
    out.push({ ...f, end: leftEnd, value: text.slice(f.start, leftEnd) });
    const rightStart = leftEnd + sep[0].length;
    const tail = /^\+?[\d(][\d\s().-]{0,24}\d/.exec(text.slice(rightStart, rightStart + 32));
    const digits = tail?.[0].replace(/\D/g, '').length ?? 0;
    if (tail && digits >= 7 && digits <= 15) {
      const end = rightStart + tail[0].length;
      out.push({ ...f, start: rightStart, end, value: text.slice(rightStart, end) });
    }
  }
  return out;
}

/** A `KEY=value` that opens a line is an .env-style assignment, whose value
 *  is the rest of the line: `SECRET_ANSWER=Adebayo Ogunleye Street` must not
 *  leave `Ogunleye Street` in the clean version. Unquoted values only; a
 *  quoted one already ends at its quote. */
export function extendLineAssignments(findings: Finding[], text: string): Finding[] {
  return findings.map((f) => {
    if (f.type !== 'CREDENTIAL' || f.value.includes('\n')) return f;
    if (/[=:]/.exec(f.value)?.[0] !== '=') return f; // YAML `key: value` ends at the line anyway
    const lineStart = text.lastIndexOf('\n', f.start - 1) + 1;
    const before = text.slice(lineStart, f.start).trim();
    if (before !== '' && before !== 'export') return f;
    if (/^[^=:]*[=:]\s*["'`]/.test(f.value)) return f;
    const nl = text.indexOf('\n', f.end);
    const lineEnd =
      (nl === -1 ? text.length : nl) - (text[(nl === -1 ? text.length : nl) - 1] === '\r' ? 1 : 0);
    const end = f.end + text.slice(f.end, lineEnd).trimEnd().length;
    return end > f.end ? { ...f, end, value: text.slice(f.start, end) } : f;
  });
}

/** Where each chunk starts. A boundary moves to just after the next newline
 *  (within 4 KB), so it rarely lands inside a token or a run of digits whose
 *  matches depend on where scanning began. */
function chunkStarts(text: string, chunk: number): number[] {
  const starts = [0];
  for (let next = chunk; next < text.length;) {
    const nl = text.indexOf('\n', next);
    const start = nl !== -1 && nl - next < 4096 ? nl + 1 : next;
    if (start >= text.length) break;
    starts.push(start);
    next = start + chunk;
  }
  return starts;
}

export type Detect = (text: string) => Finding[];

export class ScanBudgetExceeded extends Error {}

export function createDetect(
  cfg: EngineConfig = DEFAULT_CONFIG,
  limits: ScanLimits = DEFAULT_LIMITS,
): Detect {
  const detectors = buildDetectors(cfg);
  const ignore = new Set(cfg.ignoreValues.map((v) => v.trim()).filter(Boolean));
  const ignored = (type: string, value: string): boolean => {
    if (ignore.has(value)) return true;
    if (type !== 'CREDENTIAL' && type !== 'PASSWORD') return false;
    const assigned = assignedValue(value);
    return assigned !== undefined && ignore.has(assigned);
  };

  return (text) => {
    if (text.length === 0) return [];
    const deadline = limits.now() + limits.budgetMs;
    const all: Finding[] = [];
    // Chunk i owns [own, ownEnd) and reads `lookbehind` before it (word
    // boundaries) and `overlap` after it (findings that start inside but run
    // past). A finding is kept by the chunk that owns its start. The result
    // matches one pass over the whole text, except where a run of digits or
    // a token longer than `lookbehind` straddles a boundary that had no
    // newline within 4 KB to move to (greedy patterns then start elsewhere).
    const starts = chunkStarts(text, limits.chunk);
    for (let i = 0; i < starts.length; i++) {
      const own = starts[i] ?? 0;
      const ownEnd = starts[i + 1] ?? text.length;
      const from = Math.max(0, own - limits.lookbehind);
      const to = Math.min(text.length, ownEnd + limits.overlap);
      const piece = text.slice(from, to);
      for (const d of detectors) {
        if (limits.now() > deadline) {
          throw new ScanBudgetExceeded(
            `the prompt took more than ${limits.budgetMs / 1000} s to check (${Math.round(text.length / 1000)}K characters); split it up`,
          );
        }
        let matches: ReturnType<Detector['detect']>;
        try {
          matches = d.detect(piece);
        } catch {
          continue; // one misbehaving detector must not take the check down
        }
        for (const m of matches) {
          const start = from + m.start;
          const end = from + m.end;
          if (end <= start || start < own || start >= ownEnd) continue;
          const { value } = m;
          if (isAlreadyRedacted(value) || ignored(d.type, value)) continue;
          if (isReservedValue(d.type, value)) continue;
          if (isNoiseInCode(d.type, value, text, start, end)) continue;
          all.push({ type: d.type, value, start, end });
        }
      }
    }
    return mergeOverlaps(extendLineAssignments(splitPhoneLists(all, text), text), text);
  };
}

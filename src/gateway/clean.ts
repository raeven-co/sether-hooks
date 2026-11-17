// Cleans an Anthropic Messages request before it leaves the machine.
//
// Every string that the user, a file or a tool put into the conversation is
// scanned with the hook's detection. Each sensitive value becomes a typed
// placeholder ([EMAIL_1]) from a placeholder book that lives as long as the
// gateway: the same value keeps the same placeholder in every request, so the
// model's earlier references stay right and prompt-cache prefixes stay stable
// from turn to turn. Every value in the book is also replaced wherever it
// appears, so a value caught once (next to a label, say) is hidden where it
// appears bare, in this request and later ones.
//
// Scanned: every field that is not structure. Never touched: types, ids,
// names, signatures, encrypted fields, cache settings, images, base64 data,
// metadata and tool definitions, and Claude Code's one-line billing header.
// A signed reasoning block cannot be changed without breaking its signature,
// so a request whose reasoning holds a sensitive value is refused.

import { createHash } from 'node:crypto';

import type { Detect, Finding } from '../engine/engine.js';
import { slugFor } from '../engine/labels.js';

type JsonObject = { [key: string]: unknown };
type Container = JsonObject | unknown[];

/** A string (or a large number) inside the body that may be rewritten, or an
 *  object key inside tool arguments that may be renamed. */
interface Slot {
  owner: Container;
  key: string | number;
  text: string;
  isKey: boolean;
  /** A text document sent base64-encoded: scanned decoded, written back encoded. */
  base64?: boolean;
}

interface Span {
  start: number;
  end: number;
  placeholder: string;
}

interface Collected {
  slots: Slot[];
  /** Text of signed reasoning blocks: checked, never rewritten. */
  signed: string[];
}

export class CleanError extends Error {}

/** Claude Code's first system block, read by Anthropic's billing. Only an
 *  exact single line is skipped; anything after it is scanned. */
const BILLING_LINE = /^x-anthropic-billing-header:[^\n]*$/;
const SKIPPED_TYPES = new Set(['image', 'redacted_thinking', 'base64']);
const TOOL_CALL_TYPES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);
/** Block fields that are structure, not content. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'id',
  'tool_use_id',
  'name',
  'signature',
  'encrypted_content',
  'encrypted_index',
  'media_type',
  'cache_control',
  'file_id',
  'is_error',
]);
/** Credential findings hold `KEY=secret`; the bare secret is hidden too. */
const ASSIGNMENT_TYPES = new Set(['CREDENTIAL', 'PASSWORD', 'AUTH_HEADER']);

/** Shorter values are only replaced where a detector found them, so a short
 *  match cannot rewrite unrelated text across the whole conversation. */
const MIN_PROPAGATED_LENGTH = 6;

/** One string larger than this is refused rather than risk a partial scan. */
export const MAX_SLOT_CHARS = 2_000_000;

/** Bounded, so a long run of `_1_1_1` cannot make it backtrack. */
const PLACEHOLDER = /\[[A-Z][A-Z0-9_]{0,48}\]/g;
const NUMBERED = /_\d+\]$/;
const URI_PASSWORD = /:\/\/[^\s:/@]{0,256}:([^\s@/]{1,256})@/;
const AUTH_SCHEME = /^(?:Bearer|Basic|Token|Bot)\s+(\S{1,4096})/i;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remembers findings per exact text, so a long session only scans new blocks.
 *  In memory only; the values it holds are never logged or written. */
export class FindingCache {
  private readonly entries = new Map<string, Finding[]>();

  constructor(private readonly maxEntries = 4096) {}

  findings(text: string, detect: Detect): Finding[] {
    const key = createHash('sha256').update(text).digest('hex');
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const found = detect(text);
    this.entries.set(key, found);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return found;
  }
}

/** Value -> placeholder, for as long as the gateway runs. In memory only. */
export class PlaceholderBook {
  private readonly byValue = new Map<string, string>();
  /** Every name ever handed out stays reserved, even after its value is
   *  dropped, so one placeholder never means two values. */
  private readonly names = new Set<string>();
  private readonly counters = new Map<string, number>();
  private compiled: RegExp | null | undefined;

  constructor(private readonly maxValues = 50_000) {}

  get(value: string): string | undefined {
    return this.byValue.get(value);
  }

  isOurs(name: string): boolean {
    return this.names.has(name);
  }

  /** The value's placeholder, handing out the next free number on first sight. */
  assign(value: string, slug: string, taken: ReadonlySet<string>): string {
    const known = this.byValue.get(value);
    if (known) return known;
    let n = this.counters.get(slug) ?? 0;
    let name: string;
    do {
      n += 1;
      name = `[${slug}_${n}]`;
    } while (taken.has(name) || this.names.has(name));
    this.counters.set(slug, n);
    this.names.add(name);
    this.remember(value, name);
    return name;
  }

  /** Another form of an already named value (the bare secret of `KEY=secret`). */
  alias(value: string, name: string): void {
    if (value.length >= MIN_PROPAGATED_LENGTH && !this.byValue.has(value))
      this.remember(value, name);
  }

  /** Matches every known value at every position (overlaps included), longest
   *  first; group 1 is the value. Rebuilt only when the book changes. */
  matcher(): RegExp | null {
    if (this.compiled === undefined) {
      const values = [...this.byValue.keys()]
        .filter((v) => v.length >= MIN_PROPAGATED_LENGTH)
        .sort((a, b) => b.length - a.length);
      this.compiled =
        values.length > 0 ? new RegExp(`(?=(${values.map(escapeRegExp).join('|')}))`, 'g') : null;
    }
    return this.compiled;
  }

  private remember(value: string, name: string): void {
    this.byValue.set(value, name);
    this.compiled = undefined;
    if (this.byValue.size > this.maxValues) {
      const oldest = this.byValue.keys().next().value;
      if (oldest !== undefined) this.byValue.delete(oldest);
    }
  }
}

/** The secret inside an assignment or URL finding, when it can appear alone. */
function secretParts(f: Finding): string[] {
  const parts: string[] = [];
  if (ASSIGNMENT_TYPES.has(f.type)) {
    const sep = f.value.search(/[=:]/);
    if (sep >= 0) {
      const rhs = f.value
        .slice(sep + 1)
        .trim()
        .replace(/^["'`]|["'`,;]+$/g, '');
      parts.push(rhs);
      const scheme = AUTH_SCHEME.exec(rhs);
      if (scheme?.[1]) parts.push(scheme[1]);
    }
  }
  const password = URI_PASSWORD.exec(f.value)?.[1];
  if (password) parts.push(password);
  return parts.filter((p) => p !== f.value);
}

function addSlot(into: Collected, owner: Container, key: string | number): void {
  const value = (owner as Record<string | number, unknown>)[key];
  if (typeof value === 'string' && value.length > 0) {
    into.slots.push({ owner, key, text: value, isKey: false });
  }
}

/** Tool call arguments: every string, every large number, every key. */
function collectArguments(
  into: Collected,
  value: unknown,
  owner: Container,
  key: string | number,
): void {
  if (typeof value === 'string') {
    addSlot(into, owner, key);
  } else if (typeof value === 'number') {
    // Card and phone numbers can arrive as JSON numbers.
    if (Number.isFinite(value) && Math.abs(value) >= 1_000_000) {
      into.slots.push({ owner, key, text: String(value), isKey: false });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectArguments(into, item, value, index));
  } else if (isObject(value)) {
    for (const [k, item] of Object.entries(value)) {
      if (k.length > 0) into.slots.push({ owner: value, key: k, text: k, isKey: true });
      collectArguments(into, item, value, k);
    }
  }
}

function collectContent(
  into: Collected,
  owner: Container,
  key: string | number,
  item: unknown,
): void {
  if (typeof item === 'string') addSlot(into, owner, key);
  else if (Array.isArray(item)) item.forEach((inner, i) => collectContent(into, item, i, inner));
  else if (isObject(item)) collectBlock(into, item);
}

function collectBlock(into: Collected, block: unknown): void {
  if (!isObject(block)) return;
  const type = typeof block.type === 'string' ? block.type : undefined;
  if (type === 'base64') {
    // Text documents can arrive base64-encoded; PDFs and images cannot be read.
    if (
      typeof block.media_type === 'string' &&
      block.media_type.startsWith('text/') &&
      typeof block.data === 'string'
    ) {
      const text = Buffer.from(block.data, 'base64').toString('utf8');
      if (text.length > 0)
        into.slots.push({ owner: block, key: 'data', text, isKey: false, base64: true });
    }
    return;
  }
  if (type !== undefined && SKIPPED_TYPES.has(type)) return;
  if (type === 'thinking') {
    if (typeof block.thinking === 'string' && block.thinking.length > 0)
      into.signed.push(block.thinking);
    return;
  }
  for (const [key, item] of Object.entries(block)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (key === 'input' && type !== undefined && TOOL_CALL_TYPES.has(type)) {
      collectArguments(into, item, block, key);
    } else {
      collectContent(into, block, key, item);
    }
  }
}

/** The strings to clean, in the order the model reads them. */
function collect(body: JsonObject): Collected {
  const into: Collected = { slots: [], signed: [] };
  const { system, messages } = body;
  if (typeof system === 'string') {
    if (!BILLING_LINE.test(system)) addSlot(into, body, 'system');
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (isObject(block) && typeof block.text === 'string' && BILLING_LINE.test(block.text))
        continue;
      collectBlock(into, block);
    }
  }
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isObject(message)) continue;
      if (typeof message.content === 'string') addSlot(into, message, 'content');
      else if (Array.isArray(message.content)) {
        for (const block of message.content) collectBlock(into, block);
      }
    }
  }
  return into;
}

/** Spans sorted by start; overlapping spans merge into their union under the
 *  first one's placeholder, so no tail of a value survives. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

function rewrite(text: string, spans: Span[]): string {
  let out = '';
  let pos = 0;
  for (const span of spans) {
    out += text.slice(pos, span.start) + span.placeholder;
    pos = span.end;
  }
  return out + text.slice(pos);
}

/** Every known value in `text`, overlapping matches included. */
function knownSpans(text: string, book: PlaceholderBook): Span[] {
  const matcher = book.matcher();
  if (!matcher) return [];
  const spans: Span[] = [];
  for (const m of text.matchAll(matcher)) {
    const value = m[1] ?? '';
    const placeholder = book.get(value);
    const start = m.index ?? 0;
    if (placeholder) spans.push({ start, end: start + value.length, placeholder });
  }
  return spans;
}

/** Rename keys in place, keeping their order. */
function renameKeys(owner: JsonObject, renames: Map<string, string>): void {
  const entries = Object.entries(owner);
  for (const [key] of entries) delete owner[key];
  for (const [key, value] of entries) {
    let next = renames.get(key) ?? key;
    while (Object.hasOwn(owner, next)) next += '_';
    owner[next] = value;
  }
}

export interface CleanOptions {
  detect: Detect;
  cache?: FindingCache;
  /** Shared across requests so placeholders stay stable; one per gateway. */
  book?: PlaceholderBook;
  /** Give up (and refuse the request) once cleaning has taken this long. */
  budgetMs?: number;
  now?: () => number;
}

export interface CleanResult {
  /** The same object, cleaned in place. */
  body: JsonObject;
  /** Distinct values found in this request, per detector type. Counts only. */
  replaced: Map<string, number>;
}

export function cleanRequest(body: unknown, opts: CleanOptions): CleanResult {
  if (!isObject(body)) throw new CleanError('the request body is not a JSON object');
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 60_000);
  const cache = opts.cache ?? new FindingCache();
  const book = opts.book ?? new PlaceholderBook();
  const { slots, signed } = collect(body);

  const scan = (text: string): Finding[] => {
    if (text.length > MAX_SLOT_CHARS) {
      throw new CleanError(
        `one part of the conversation is ${(text.length / 1e6).toFixed(1)}M characters, more than the ${MAX_SLOT_CHARS / 1e6}M Sether checks at once`,
      );
    }
    if (now() > deadline) throw new CleanError('the conversation took too long to check');
    return cache.findings(text, opts.detect);
  };
  const found = slots.map((slot) => scan(slot.text));

  // Placeholder names already in the text that the gateway did not hand out
  // (a clean version pasted back in, say) are skipped, so [EMAIL_1] never
  // means two things. Names the model repeats back are ours and reused.
  const taken = new Set<string>();
  for (const slot of slots) {
    for (const m of slot.text.matchAll(PLACEHOLDER)) {
      if (NUMBERED.test(m[0]) && !book.isOurs(m[0])) taken.add(m[0]);
    }
  }
  const seen = new Map<string, Set<string>>();
  for (const findings of found) {
    for (const f of [...findings].sort((a, b) => a.start - b.start)) {
      const name = book.assign(f.value, slugFor(f.type), taken);
      for (const part of secretParts(f)) book.alias(part, name);
      const values = seen.get(f.type) ?? new Set<string>();
      values.add(f.value);
      seen.set(f.type, values);
    }
  }

  for (const text of signed) {
    if (scan(text).length > 0 || knownSpans(text, book).length > 0) {
      throw new CleanError(
        'an earlier reasoning block in this conversation holds a sensitive value and is signed, so it cannot be cleaned; start a new conversation',
      );
    }
  }

  const renames = new Map<JsonObject, Map<string, string>>();
  slots.forEach((slot, i) => {
    const spans: Span[] = (found[i] ?? []).map((f) => ({
      start: f.start,
      end: f.end,
      placeholder: book.get(f.value) ?? '[REDACTED]',
    }));
    spans.push(...knownSpans(slot.text, book));
    if (spans.length === 0) return;
    const cleaned = rewrite(slot.text, mergeSpans(spans));
    if (slot.isKey) {
      const owner = slot.owner as JsonObject;
      const forOwner = renames.get(owner) ?? new Map<string, string>();
      forOwner.set(String(slot.key), cleaned);
      renames.set(owner, forOwner);
    } else {
      (slot.owner as Record<string | number, unknown>)[slot.key] = slot.base64
        ? Buffer.from(cleaned, 'utf8').toString('base64')
        : cleaned;
    }
  });
  for (const [owner, forOwner] of renames) renameKeys(owner, forOwner);

  const replaced = new Map<string, number>();
  for (const [type, values] of seen) replaced.set(type, values.size);
  return { body, replaced };
}

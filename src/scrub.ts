// The clean version of a blocked prompt: each sensitive value becomes a typed,
// numbered placeholder ([EMAIL_1], [AWS_KEY_1]). The same value always gets the
// same placeholder, so "email [EMAIL_1] and cc [EMAIL_1]" still reads right,
// and a coding agent can still reason about which values are the same.

import type { Finding } from './engine/engine.js';
import { slugFor } from './engine/labels.js';

export function scrubPrompt(prompt: string, findings: readonly Finding[]): string {
  const placeholders = new Map<string, string>();
  const counters = new Map<string, number>();
  const placeholderFor = (f: Finding): string => {
    const key = `${f.type}\u0000${f.value}`;
    let p = placeholders.get(key);
    if (!p) {
      const slug = slugFor(f.type);
      const n = (counters.get(slug) ?? 0) + 1;
      counters.set(slug, n);
      p = `[${slug}_${n}]`;
      placeholders.set(key, p);
    }
    return p;
  };

  let out = '';
  let pos = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < pos) continue;
    out += prompt.slice(pos, f.start) + placeholderFor(f);
    pos = f.end;
  }
  return out + prompt.slice(pos);
}

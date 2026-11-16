// "Send it again to send it anyway", the same escape hatch as Shield's
// pre-send heads-up. The hook remembers the last prompt it stopped as a
// SHA-256 hash plus a timestamp; the identical prompt goes through for the
// rest of the window. The prompt itself is never written anywhere.
//
// The pass is not used up on the first resend: with the hook installed twice
// (user and project settings), both entries check every prompt, and a
// one-shot pass taken by the second left the first blocking every retry.
//
// The state lives in the user's own state directory, never a shared temp
// path, and is refused if another user owns it or can write to it; the file
// is opened without following symlinks. A planted `last-blocked` symlink in
// a world-writable /tmp could otherwise overwrite any file the user owns.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RESEND_WINDOW_MS = 2 * 60 * 1000;

// 0 where the platform has no O_NOFOLLOW (Windows); there is no shared /tmp there.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The state directory, created 0700 if missing and checked if present. */
export function stateDirFor(override: string | undefined, env = process.env): string {
  const dir =
    override ??
    join(
      env.XDG_STATE_HOME ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state'),
      'sether-hook',
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`${dir} belongs to another user`);
    }
    if ((st.mode & 0o022) !== 0) throw new Error(`${dir} is writable by other users`);
  }
  return dir;
}

const hashOf = (prompt: string): string => createHash('sha256').update(prompt.trim()).digest('hex');

/** True when this exact prompt was stopped within the window. */
export function resendAllowed(prompt: string, now: number, stateDir?: string): boolean {
  const file = join(stateDirFor(stateDir), 'last-blocked');
  let saved: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try {
      saved = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const [hash, at] = saved.split('\t');
  const age = now - Number(at);
  return hash === hashOf(prompt) && age >= 0 && age <= RESEND_WINDOW_MS;
}

export function rememberBlocked(prompt: string, now: number, stateDir?: string): void {
  const file = join(stateDirFor(stateDir), 'last-blocked');
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${hashOf(prompt)}\t${now}`);
  } finally {
    closeSync(fd);
  }
}

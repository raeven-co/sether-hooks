// Optional (--copy): put the clean version on the clipboard so resending is a
// paste. Uses the platform's own clipboard command; no network, no native
// module. Returns false when none is available.

import { spawnSync } from 'node:child_process';

const COMMANDS: Readonly<Record<string, ReadonlyArray<readonly [string, readonly string[]]>>> = {
  darwin: [['pbcopy', []]],
  win32: [
    [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
    ],
  ],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
};

export function copyToClipboard(text: string, platform: string = process.platform): boolean {
  for (const [cmd, args] of COMMANDS[platform] ?? []) {
    const res = spawnSync(cmd, args, {
      input: text,
      timeout: 3000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (!res.error && res.status === 0) return true;
  }
  return false;
}

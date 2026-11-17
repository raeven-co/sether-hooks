# Changelog

## 0.1.1 - unreleased

Documentation only. No change to the hook, the installer or detection.

- README: an animated terminal demo at the top and an animated diagram of
  where the hook sits (your machine, before the model), so the package page
  explains itself at a glance. The images live in the repository, not in the
  npm package.

## 0.1.0 - 2026-11-16

First release.

- `sether-hook check`: the prompt hook for Claude Code (`UserPromptSubmit`),
  Codex (`UserPromptSubmit`) and Gemini CLI (`BeforeAgent`). Stops a prompt
  with personal data or a secret and shows a clean version with typed
  placeholders (`[EMAIL_1]`). Send the identical prompt again within two
  minutes to send it unchanged.
- `sether-hook install` / `uninstall`: adds or removes only Sether's entry in
  the agent's settings file, keeps a backup, never touches invalid JSON.
- `sether-hook status`: lists every agent settings file with a Sether entry
  and whether it will run (catches Node moved by an nvm/Volta/fnm upgrade,
  the script moved, duplicate entries, invalid JSON). Exit 1 on a problem.
- `--portable`: a PATH-based command for project settings files that are
  committed and used on other machines.
- `sether-hook scan`: check any text from the command line.
- Prompts over 2 million characters are stopped unchecked rather than risk the
  agents' 30-second timeout, after which Codex and Gemini CLI let a prompt
  through.
- The installer writes through a symlinked settings file, keeps file modes,
  rejects unknown options, and refuses to run on Windows until that path is
  tested.
- Detection: `@raeven-co/sether` 0.8 packs plus the credentials pack,
  reserved-value allowlist and code-noise filters ported from the Sether VS
  Code extension, and hook-only additions: Slack user/app tokens, Google,
  npm and GitLab tokens, `Authorization` headers, private keys pasted without
  their END line, and credentials under any key spelling (JSON, YAML,
  camelCase, prefixed env names).
- Hardened after an independent pre-release review:
  - Phones and cards on a line with several decimals (prices, JSON with
    coordinates) were dropped as "numeric data". The rule now applies only to
    lines that are mostly numbers, and never to a `+` phone or a 4-4-4-4 card.
  - Overlapping matches are merged instead of the later one being dropped, so
    the clean version never keeps the tail of a secret; a phone match that
    ran into the next number is split; a line-start `KEY=value` takes the
    rest of the line.
  - Scanning is chunked with a 15 s budget (fail closed), and the
    database-URI pattern is bounded; minified JSON no longer scans in
    quadratic time.
  - Once something is found, the prompt is stopped even if the resend state
    cannot be saved, including with `SETHER_HOOK_FAIL_OPEN=1`.
  - Resend state moved from the shared temp folder to
    `~/.local/state/sether-hook`, with ownership and permission checks and no
    symlink following. The resend pass lasts its whole window, so a hook
    installed in both user and project settings no longer blocks every retry.
  - The installer recognises only the exact commands it writes (a user's own
    wrapper that mentions sether is left alone) and keeps a `VAR=value`
    prefix when installing again.
  - A second review pass removed the "numeric data line" rule (it still
    dropped phones and cards in CSV rows), made every noise rule yield to a
    value that looks like a secret (Go `:=`, Makefile `?=`, numeric and
    `$`-prefixed passwords, `AUTH_HEADER=Basic …`), restored host IPs in
    `host/IP:port` logs and ending in `.0`/`.255`, stopped a non-sensitive
    `url=` value from hiding a `token=` inside it, tightened the time budget
    (12 s, 32 KB chunks), and stopped the block message printing a
    database URI's path and query.
  - Phone numbers in CSV columns are found even where libphonenumber skips
    them (delimited tokens validated for the configured regions).
  - Fewer false positives on code: comparisons (`apiKey === undefined`),
    `$VAR` references, config keys (`TOKEN_EXPIRY=3600`, `AUTH_URL=...`),
    LLM settings (`max_tokens`, `tokenizer`), i18n strings
    (`"newPassword": "New password"`), OpenAPI/YAML schemas, integer limits,
    version strings read as IPs. `SETHER_IGNORE` now also
    matches a credential's value.

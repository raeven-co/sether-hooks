# @raeven-co/sether-hooks

Stops a prompt that carries personal data or a secret **before** Claude Code,
Codex or Gemini CLI sends it to the model, and shows you a clean version to
send instead.

```
$ claude
> deploy with key AKIAIOSFODNN7EXAMPLE and email the report to ngozi.adeyemi@gmail.com

  UserPromptSubmit operation blocked by hook:
  Sether stopped this prompt before it was sent: 2 sensitive items.
    - AWS key: AKIAIOS•••
    - email: n•••@g•••.com

  Clean version, with placeholders instead of the values:

  deploy with key [AWS_KEY_1] and email the report to [EMAIL_1]

  To send the original anyway, send it again within 2 minutes.
```

It uses each agent's own, documented prompt hook. Detection is the
[`@raeven-co/sether`](https://www.npmjs.com/package/@raeven-co/sether) engine,
tuned the same way as the Sether VS Code extension for prompts full of code.
Everything runs on your machine. The hook makes no network calls.

## Why a hook and not a plugin

A ChatGPT plugin, an MCP server or a connector is called *after* the model
already has your prompt. A prompt hook runs before the agent sends anything,
so it is the one place a local check can actually stop the text.

## Install

```bash
npm install -g @raeven-co/sether-hooks

sether-hook install claude    # ~/.claude/settings.json
sether-hook install codex     # ~/.codex/hooks.json, then run /hooks in Codex to trust it
sether-hook install gemini    # ~/.gemini/settings.json
```

Requires Node 18 or later, on macOS or Linux. The installer refuses to run on
Windows for now (`scan` works there); see "Adding the hook by hand" below.

- `--project` writes to the settings file in the current directory instead
  (`.claude/`, `.codex/`, `.gemini/`).
- `--portable` writes a command that runs `sether-hook` from `PATH` instead of
  this machine's paths. Use it with `--project` for a settings file you commit,
  so it works for everyone who has installed the package.
- `--copy` also puts the clean version on your clipboard, so resending is a paste.
- Your other settings and hooks are kept. The previous file is copied next to
  it (`*.sether-backup-<time>`) before any change. A file that isn't valid
  JSON is never touched, and a symlinked settings file (a dotfiles repo) is
  written through to its target, so the link survives.
- A mistyped option is an error, never a silent install somewhere else.
- `sether-hook uninstall <agent>` removes only Sether's entry.

### Keeping it working

By default the hook command uses absolute paths to `node` and the script, so
it works whatever `PATH` your agent starts hooks with. If Node moves (an nvm,
Volta or fnm upgrade removes the old version), that command stops working:
Claude Code then stops every prompt, while Codex and Gemini CLI let every
prompt through unchecked. Check after any Node change:

```
$ sether-hook status
sether-hook 0.1.0
  Claude Code: OK (/Users/you/.claude/settings.json)
  Codex: PROBLEM (/Users/you/.codex/hooks.json)
    - Node is no longer at /Users/you/.nvm/versions/node/v22.11.0/bin/node (upgraded or moved?)
```

`status` exits with 1 when anything needs fixing; run `install` again for that
agent.

### Adding the hook by hand

Each agent runs `sether-hook check --agent <claude|codex|gemini>` on its
prompt event: `UserPromptSubmit` for Claude Code and Codex, `BeforeAgent` for
Gemini CLI. See each agent's hook documentation for where the entry goes.

## What it stops, and what it lets through

Stopped: emails, phone numbers (national formats for the regions below), card
numbers (Luhn-checked), SSNs, IBANs, public IP addresses, AWS / OpenAI /
Anthropic / GitHub / Slack / Stripe / Google / npm / GitLab keys and tokens,
JWTs, `Authorization: Basic|Bearer` headers, database URIs with passwords,
PEM private keys (also a key pasted without its END line), and credentials
under any key spelling: `SECRET=...`, `"password": "..."`,
`aws_secret_access_key = ...`, `dbPassword: "..."`, `PGPASSWORD=...`.

The clean version never keeps part of a value: overlapping matches are
merged into one placeholder, and a `KEY=value` that starts a line is treated
like an `.env` line, whose value runs to the end of the line.

Let through, because they appear in every codebase: private and loopback IPs,
version strings (`Chrome/120.0.0.0`), `example.com`-style domains, documented test cards and IBANs, fictional phone ranges, integer
limits (`2147483647`), timestamps, version numbers, code
(`password: values.password`, `apiKey === undefined`, `token: string`),
references and placeholders (`$DB_PASSWORD`, `${TOKEN}`, `your-key-here`),
settings and UI text under credential-like keys (`TOKEN_EXPIRY=3600`,
`AUTH_URL=https://...`, `max_tokens: 1000000`, `"newPassword": "New password"`),
YAML/OpenAPI schemas (`password:` followed by `type: string`), and default
credentials on a local host (`postgres:postgres@localhost`). Anything under
those keys that looks like a secret (8+ characters mixing letters, digits and
symbols, or an auth scheme) is still stopped.

Not caught:
- A bare name in prose ("ask Ngozi Adeyemi"). Names are only found after a
  label (`Name: ...`) with `SETHER_IDENTITY=1`. Free-text names need a model;
  see `@raeven-co/sether-ner`.
- A password made only of letters in code-like form (`password: sunshine`);
  it looks like a variable reference. Quoted (`password: "sunshine"`) it is
  caught.
- Phone numbers listed with spaces only (`415 555 2671 415 555 2672`), a
  phone-shaped number inside a list of decimals (`[6.52, 3.37, 4155552671]`),
  and a card number followed directly by more digits. Phone numbers in CSV
  columns, JSON strings and prose are caught.

## Settings

All optional, read from the environment the agent runs hooks with.

| Variable | Effect |
|---|---|
| `SETHER_PHONE_REGIONS=DE,FR` | National phone formats to recognise (default `US,GB,NG,CA`) |
| `SETHER_NETWORK=0` | Stop flagging public IP addresses |
| `SETHER_IDENTITY=1` | Also flag label-anchored names, dates of birth, passports, addresses |
| `SETHER_HIGH_ENTROPY=1` | Also flag random-looking strings with no known prefix (noisy on hashes) |
| `SETHER_IGNORE=me@co.dev,...` | Exact values never to flag |
| `SETHER_HOOK_FAIL_OPEN=1` | Let prompts through when the check itself fails (default: stop them) |

To send a stopped prompt unchanged, send the identical prompt again within two
minutes. The hook remembers only a SHA-256 hash of the last prompt it stopped,
never the text, in `$XDG_STATE_HOME/sether-hook` (default
`~/.local/state/sether-hook`, or `SETHER_HOOK_STATE_DIR`). It refuses a folder
another user owns or can write to, and never follows a symlink there. If the
state cannot be saved, the prompt is still stopped; only the resend does not
work until that is fixed.

## What it does not promise

- **It keeps the prompt from the model, not off your disk.** Claude Code
  records a blocked prompt in its local session transcript (its docs say a
  blocking hook "isn't a way to keep a secret off disk"). Sether asks Claude
  Code to leave the original out of the on-screen block message.
- **Each agent decides what happens if the hook can't run at all** (Node
  missing, say). Claude Code 2.1.295+ stops the prompt (`onFailure: "block"`,
  set by the installer). Codex and Gemini CLI let it through. When the hook
  runs but the check fails, Sether stops the prompt itself unless you set
  `SETHER_HOOK_FAIL_OPEN=1`.
- **Codex runs a hook only after you trust it** (`/hooks`), and project-level
  hooks only in a trusted project.
- **A prompt it can't check in time is stopped.** Agents give a hook about
  30 seconds, and on a timeout Codex and Gemini CLI let the prompt through. So
  the scan has a 15-second budget and a 2-million-character cap; past either,
  the hook stops the prompt and asks you to split it (unless
  `SETHER_HOOK_FAIL_OPEN=1`). On an M-series Mac a 20,000-row contact CSV
  (1.3 MB) takes about 2 seconds and 900 KB of minified JSON about 7.
- **It checks what you type.** Files the agent reads, tool output, and
  attachments are not prompts and are not covered.

## Tested

- Claude Code 2.1.220: prompts with an email, an AWS key, and a pasted JSON
  password and phone were stopped with zero model usage (`duration_api_ms: 0`,
  no tokens); a clean prompt went through.
- Codex 0.164.0: prompts with an email and an AWS secret-key line were stopped
  with zero input and output tokens.
- Gemini CLI: built and unit-tested against its documented hook contract, not
  yet run against a real Gemini CLI.
- `npm test`: 162 checks. They include every case from two independent
  review passes (leaks, partial clean versions, timing, state handling,
  installer ownership, false positives, format gaps, block-message masks), chunked scanning against a single
  pass on random prompts, a run with all network access blocked, and the
  installer against symlinked, permission-restricted and invalid settings
  files.

## Command reference

```
sether-hook install <claude|codex|gemini> [--project] [--portable] [--copy]
sether-hook uninstall <claude|codex|gemini> [--project]
sether-hook status               where the hook is installed and whether it will run; exit 1 on a problem
sether-hook scan [text]          check text (or stdin), print masks and the clean version; exit 1 if found
sether-hook check --agent <a>    what the agent runs: hook JSON on stdin, decision on stdout
```

MIT. Part of [Sether](https://sether.raevenmarket.com.ng).

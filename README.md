# draft-mate

Local-first email triage. Point it at a backlog of unread mail and it tells you
**what to handle first** — ranked by priority, with a short summary, the reason
for the ranking, a recommended next action, and a suggested reply-by date. It can
also draft replies for you to review (it **never sends**).

Privacy by construction: all analysis runs locally. Email content goes only to a
local [Ollama](https://ollama.com) model — or, if no model is running, to
on-device heuristics. Nothing is sent to any cloud AI service.

> Status: **MVP** — the Phase 1 read-only triage engine + CLI from the
> [build plan](#how-this-maps-to-the-build-plan). Runs today against a bundled
> sample inbox with zero setup. Real Gmail/Outlook adapters and OAuth are
> implemented and need your own API credentials (below).

---

## Quick start (no credentials needed)

```bash
npm install
npm run build
npm run serve            # opens the dashboard at http://127.0.0.1:4317
```

That launches the **web dashboard** against a built-in sample inbox
(`fixtures/sample-emails.json`), so you can see the whole product — ranked
cards, priority/category filters, score breakdowns, email detail, and AI draft
replies — without connecting any real account. Click **Triage inbox** to run the
pipeline (a progress bar streams live as each email is analysed).

Prefer the terminal? The same engine drives a CLI:

```bash
npm run demo                                              # ranked inbox in the terminal
node dist/cli.js triage --account demo --by-category
node dist/cli.js doctor
```

### The dashboard

`draft-mate serve` (`--port <n>`, `--no-open`) is a local web app served from
loopback only. It shows:

- a **ranked inbox** of cards colour-coded by priority, each with a summary, the
  reason for its rank, the recommended next action, deadlines, and a six-bar
  score sparkline;
- **sidebar filters** by priority band and by actionable category, with live
  counts;
- a **detail drawer** with the full message, score breakdown, and requested
  actions;
- **AI reply drafts** you can generate, edit, approve, and save to your
  provider's Drafts folder — never sent.

Nothing leaves your machine except the calls to your email provider and the
loopback LLM.

## Requirements

- **Node.js ≥ 22** (uses built-in `fetch`, test runner, and crypto).
- **Optional: [Ollama](https://ollama.com)** for full LLM analysis. Without it,
  draft-mate falls back to local heuristics automatically.

```bash
# optional, for best results
ollama pull qwen2.5:7b-instruct   # or llama3.1:8b
ollama serve                      # usually already running
```

Check your setup any time:

```bash
node dist/cli.js doctor
```

## Commands

| Command | What it does |
|---|---|
| `serve` | Launch the web dashboard. Flags: `--port <n>` (default 4317), `--no-open`. |
| `triage` | Fetch + rank an inbox. Flags: `--account`, `--unread`, `--since <date>`, `--limit <n>`, `--by-category`, `--heuristics`, `--refresh`, `--json`. |
| `draft` | Generate a reply draft for a message: `--account <key> --message <id>`. Never sends. |
| `drafts` | List locally-generated drafts. |
| `approve` | Approve a draft: `--draft <id> [--save]`. `--save` writes it to the provider's **Drafts** folder. |
| `accounts` | List configured accounts. |
| `connect` | Authorize a real account: `--provider <gmail\|graph> --email <addr> [--key <name>]`. |
| `runs` | Show recent triage run logs. |
| `doctor` | Check Ollama + config. |

## Connecting real accounts (Gmail / Outlook)

draft-mate talks to the Gmail API and Microsoft Graph directly. You supply your
own OAuth client (no third-party server is involved). Credentials are read from
environment variables so nothing secret lives in the repo.

**Gmail** — create an OAuth *Desktop app* client in Google Cloud Console.
Full click-by-click walkthrough: **[docs/google-setup.md](docs/google-setup.md)**.

```bash
export GMAIL_CLIENT_ID="...apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="..."     # Google desktop clients issue a non-confidential secret
node dist/cli.js connect --provider gmail --email you@gmail.com --key work
```

**Outlook** — register a *public client* app in Entra ID (Azure AD):

```bash
export GRAPH_CLIENT_ID="..."
export GRAPH_TENANT="common"          # or your tenant id
node dist/cli.js connect --provider graph --email you@outlook.com --key outlook
```

`connect` runs an OAuth Authorization-Code + PKCE flow on a loopback redirect and
stores only the **refresh token**, encrypted (AES-256-GCM) under your data dir.
Then:

```bash
node dist/cli.js triage --account work --unread --by-category
```

Default scopes are read-only (`gmail.readonly`, `Mail.Read`). To create drafts,
widen scopes via `GMAIL_SCOPES` / `GRAPH_SCOPES` (e.g. add `gmail.compose` /
`Mail.ReadWrite`) and re-run `connect`.

## Privacy & safety model

- **Local only.** Analysis uses heuristics and/or a **loopback** Ollama server.
  The LLM client refuses any non-loopback host, so email bodies can't be sent
  off-box.
- **The only outbound network calls** are to your email provider (to fetch mail,
  required) and to `127.0.0.1:11434` (Ollama).
- **No send capability.** There is no send code path and no send scope. `approve
  --save` writes a *draft* to your mailbox; you send it yourself.
- **Human-in-the-loop drafting.** Drafts are never auto-approved and mark missing
  facts with `[[NEEDS INPUT: ...]]`.
- **Prompt-injection defence.** Email text is passed to the LLM as untrusted
  data; the model is instructed never to follow instructions found inside an
  email, and its output is schema-validated (bad output is discarded in favour of
  heuristics).
- **Secrets** live in an encrypted vault (`secrets.enc` + `secret.key`, 0600),
  the documented stand-in for the OS keychain. Tokens are never written to the
  store or logs in plaintext.

## Where data lives

Everything is under `~/.draft-mate` (override with `DRAFT_MATE_HOME`):

```
~/.draft-mate/
  config.json     # accounts, VIP list, Ollama settings, maxBodyChars
  store.json      # analyses, run logs, local drafts
  secrets.enc     # encrypted OAuth refresh tokens
  secret.key      # encryption key (0600)
```

Example `config.json`:

```json
{
  "vips": ["@bigclient.com", "boss@work.com"],
  "ollama": { "model": "qwen2.5:7b-instruct" },
  "maxBodyChars": 4000,
  "accounts": [{ "key": "work", "provider": "gmail", "email": "you@gmail.com" }]
}
```

## How it works

```
listMessages → getMessage → heuristic signals → analyse → score (rubric) → group → persist → render
                                                  │
                            local LLM (Ollama)?  ─┤ yes → JSON-constrained analysis
                                                  └ no  → heuristics-only
```

The six-dimension rubric (urgency, reply-needed, sender importance, business
impact, meeting relevance, action items) is weighted into a Critical/High/
Medium/Low band; emails are then grouped into actionable categories (reply
immediately, needs review today, waiting on someone, informational,
newsletters/automated, low/spam).

## Development

```bash
npm run build      # tsc → dist/
npm test           # node:test suite (21 tests, no network)
npm run triage -- triage --account demo --unread
```

Project layout:

```
src/
  cli.ts              # command parsing + dispatch
  pipeline.ts         # fetch → analyse → score → persist → log
  heuristics.ts       # offline analyzer + priors
  scoring.ts          # rubric weights, banding, grouping
  render.ts           # terminal output
  drafting.ts         # reply-draft generation (LLM or template)
  config.ts           # config + local data paths
  types.ts            # shared domain model
  llm/                # Ollama client + prompts/schemas
  providers/          # interface + mock + gmail + graph adapters
  auth/               # OAuth (PKCE loopback) + encrypted secret vault
  store/              # JSON store (SQLite is the documented upgrade)
  server/             # local web server: JSON + SSE API over the engine
web/                  # dashboard SPA (index.html, styles.css, app.js)
fixtures/             # sample inbox for the demo + tests
```

## How this maps to the build plan

This repo implements **Phase 1** (read-only triage) of the approved plan, plus a
working slice of **Phase 2** drafting. The CLI is the plan's "core engine as a
library, usable headless"; the planned Tauri desktop shell can wrap this exact
engine. The JSON store stands in for the planned SQLite/SQLCipher store behind
the same interface; the encrypted vault stands in for the OS keychain.
```

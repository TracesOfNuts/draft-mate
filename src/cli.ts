#!/usr/bin/env node
/**
 * draft-mate CLI.
 *
 * Commands:
 *   triage    Fetch + rank an inbox (the core MVP loop)
 *   draft     Generate a reply draft for a message (never sends)
 *   drafts    List locally-generated drafts
 *   approve   Approve a draft and optionally save it to the provider's Drafts
 *   accounts  List configured accounts
 *   connect   Authorize a Gmail/Outlook account (OAuth loopback)
 *   runs      Show recent triage run logs
 *   doctor    Check local environment (Ollama, config)
 *   help      Show usage
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, _resetConfigCache, type AccountConfig, type Config } from "./config.js";
import type { FetchFilter, ProviderId } from "./types.js";
import { Store } from "./store/store.js";
import { runTriage } from "./pipeline.js";
import { renderInbox, renderDraft } from "./render.js";
import { makeDraft } from "./drafting.js";
import { isAvailable, listModels } from "./llm/ollama.js";
import { getProvider } from "./providers/provider.js";
import { spawn } from "node:child_process";

// --- tiny arg parser ------------------------------------------------------

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const nextToken = argv[i + 1];
      if (nextToken !== undefined && !nextToken.startsWith("--")) {
        flags[name] = nextToken;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      _.push(tok);
    }
  }
  return { _, flags };
}

function str(flags: Args["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
function bool(flags: Args["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}
function num(flags: Args["flags"], name: string, fallback: number): number {
  const v = str(flags, name);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// --- account resolution ---------------------------------------------------

const DEMO_ACCOUNT: AccountConfig = { key: "demo", provider: "mock", email: "demo" };

function resolveAccount(cfg: Config, keyOrEmail: string | undefined): AccountConfig {
  if (!keyOrEmail || keyOrEmail === "demo") return DEMO_ACCOUNT;
  const found = cfg.accounts.find((a) => a.key === keyOrEmail || a.email === keyOrEmail);
  if (!found) {
    throw new Error(
      `Unknown account "${keyOrEmail}". Configured: ${["demo", ...cfg.accounts.map((a) => a.key)].join(", ")}`,
    );
  }
  return found;
}

function saveAccount(cfg: Config, acct: AccountConfig): void {
  const configPath = join(cfg.dataDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) raw = JSON.parse(readFileSync(configPath, "utf8"));
  const accounts = (raw["accounts"] as AccountConfig[] | undefined) ?? [];
  const idx = accounts.findIndex((a) => a.key === acct.key);
  if (idx >= 0) accounts[idx] = acct;
  else accounts.push(acct);
  raw["accounts"] = accounts;
  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf8");
  _resetConfigCache();
}

// --- commands -------------------------------------------------------------

async function cmdTriage(args: Args, cfg: Config): Promise<void> {
  const account = resolveAccount(cfg, str(args.flags, "account"));
  const filter: FetchFilter = {
    limit: num(args.flags, "limit", 50),
    ...(bool(args.flags, "unread") ? { unread: true } : {}),
    ...(str(args.flags, "since") ? { since: str(args.flags, "since")! } : {}),
  };
  const store = Store.open(cfg);

  const llm = await isAvailable(cfg);
  process.stderr.write(
    llm
      ? `Using local model "${cfg.ollama.model}" via ${cfg.ollama.baseUrl}\n`
      : `Local LLM not reachable at ${cfg.ollama.baseUrl} — falling back to heuristics (run "draft-mate doctor").\n`,
  );

  const t0 = Date.now();
  const result = await runTriage(
    {
      account,
      filter,
      forceHeuristics: bool(args.flags, "heuristics"),
      refresh: bool(args.flags, "refresh"),
      onProgress: (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\rAnalysing ${done}/${total}…`);
      },
    },
    cfg,
    store,
  );
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  if (bool(args.flags, "json")) {
    process.stdout.write(JSON.stringify(result.analyses, null, 2) + "\n");
    return;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    renderInbox(result.analyses, {
      byCategory: bool(args.flags, "by-category"),
      limit: str(args.flags, "limit") ? num(args.flags, "limit", 50) : undefined,
    }),
  );
  console.log(
    `\nAnalysed ${result.analyses.length} emails in ${secs}s via ${result.source}` +
      ` (account: ${account.email}). Log id: ${result.run.id}`,
  );
}

async function cmdDraft(args: Args, cfg: Config): Promise<void> {
  const account = resolveAccount(cfg, str(args.flags, "account"));
  const messageId = str(args.flags, "message");
  if (!messageId) throw new Error("draft requires --message <id>");
  const store = Store.open(cfg);

  const provider = await getProvider(account, cfg);
  const email = await provider.getMessage(messageId);
  const analysis = store.getAnalysis(account.email, messageId);
  const draft = await makeDraft(email, analysis, cfg);
  store.saveDraft(draft);

  console.log(renderDraft(draft));
  console.log(
    `\nSaved locally as ${draft.id}. Review/edit, then: draft-mate approve --draft ${draft.id} --save`,
  );
}

async function cmdDrafts(args: Args, cfg: Config): Promise<void> {
  const store = Store.open(cfg);
  const account = str(args.flags, "account");
  const drafts = store.listDrafts(account ? resolveAccount(cfg, account).email : undefined);
  if (drafts.length === 0) {
    console.log("No drafts yet. Generate one with: draft-mate draft --message <id>");
    return;
  }
  for (const d of drafts) console.log(renderDraft(d), "\n");
}

async function cmdApprove(args: Args, cfg: Config): Promise<void> {
  const draftId = str(args.flags, "draft");
  if (!draftId) throw new Error("approve requires --draft <id>");
  const store = Store.open(cfg);
  const draft = store.getDraft(draftId);
  if (!draft) throw new Error(`No such draft: ${draftId}`);

  draft.approved = true;
  store.saveDraft(draft);
  console.log(`Draft ${draftId} marked approved.`);

  if (bool(args.flags, "save")) {
    const account = resolveAccount(cfg, draft.account);
    const provider = await getProvider(account, cfg);
    const original = await provider.getMessage(draft.messageId);
    const providerDraftId = await provider.createDraft(original, draft.subject, draft.body);
    draft.providerDraftId = providerDraftId;
    store.saveDraft(draft);
    console.log(
      `Saved to ${account.provider} Drafts as ${providerDraftId}. ` +
        `It was NOT sent — review and send it yourself from your mail client.`,
    );
  }
}

function cmdAccounts(cfg: Config): void {
  console.log("Configured accounts:");
  console.log(`  - demo            (mock, built-in sample inbox)`);
  for (const a of cfg.accounts) console.log(`  - ${a.key.padEnd(15)} (${a.provider}, ${a.email})`);
}

async function cmdConnect(args: Args, cfg: Config): Promise<void> {
  const provider = str(args.flags, "provider") as ProviderId | undefined;
  const email = str(args.flags, "email");
  const key = str(args.flags, "key") ?? email;
  if (!provider || (provider !== "gmail" && provider !== "graph") || !email || !key) {
    throw new Error("connect requires --provider <gmail|graph> --email <address> [--key <name>]");
  }
  const acct: AccountConfig = { key, provider, email };
  const { authorize } = await import("./auth/oauth.js");
  await authorize(acct, cfg);
  saveAccount(cfg, acct);
  console.log(`Connected ${email} (${provider}) as account "${key}".`);
}

function cmdRuns(cfg: Config): void {
  const runs = Store.open(cfg).listRuns().slice(0, 10);
  if (runs.length === 0) {
    console.log("No runs logged yet.");
    return;
  }
  console.log("Recent runs:");
  for (const r of runs) {
    const c = r.counts;
    console.log(
      `  ${r.startedAt}  ${r.account.padEnd(20)} ${r.analysedCount} emails via ${r.source}` +
        `  [C:${c.Critical} H:${c.High} M:${c.Medium} L:${c.Low}]`,
    );
  }
}

async function cmdDoctor(cfg: Config): Promise<void> {
  console.log(`data dir:     ${cfg.dataDir}`);
  console.log(`ollama url:   ${cfg.ollama.baseUrl}`);
  console.log(`ollama model: ${cfg.ollama.model}`);
  const up = await isAvailable(cfg);
  console.log(`ollama up:    ${up ? "yes" : "no"}`);
  if (up) {
    const models = await listModels(cfg);
    console.log(`models:       ${models.join(", ") || "(none pulled)"}`);
    if (!models.includes(cfg.ollama.model)) {
      console.log(`  ⚠ configured model not pulled. Run: ollama pull ${cfg.ollama.model}`);
    }
  } else {
    console.log("  → Install/start Ollama for full analysis. Heuristics are used meanwhile.");
  }
  console.log(`accounts:     ${["demo", ...cfg.accounts.map((a) => a.key)].join(", ")}`);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open the URL manually */
  }
}

async function cmdServe(args: Args, cfg: Config): Promise<void> {
  const { startServer } = await import("./server/server.js");
  const port = num(args.flags, "port", 4317);
  const host = "127.0.0.1";
  const url = await startServer({ port, host });
  console.log(`\n  draft-mate dashboard running at ${url}`);
  console.log(`  Local-first — analysis stays on this machine.\n`);
  const llm = await isAvailable(cfg);
  console.log(
    llm
      ? `  Local model: ${cfg.ollama.model} (ready)`
      : `  Local model: not running — using heuristics. Run "draft-mate doctor".`,
  );
  console.log(`  Press Ctrl+C to stop.\n`);
  if (!bool(args.flags, "no-open")) openBrowser(url);
}

function usage(): void {
  console.log(`draft-mate — local-first email triage

Usage: draft-mate <command> [options]

Commands:
  serve      Launch the web dashboard (recommended)
             --port <n>   port (default 4317)   --no-open   don't open a browser
  triage     Fetch + rank an inbox
             --account <key>     account key (default: demo sample inbox)
             --unread            only unread
             --since <date>      ISO date lower bound (e.g. 2026-06-01)
             --limit <n>         max emails (default 50)
             --by-category       group by actionable category
             --heuristics        force heuristics (skip the LLM)
             --refresh           re-analyse, ignoring cache
             --json              raw JSON output

  draft      Generate a reply draft (never sends)
             --account <key> --message <id>
  drafts     List locally-generated drafts [--account <key>]
  approve    Approve a draft  --draft <id> [--save]   (--save writes to provider Drafts)

  accounts   List configured accounts
  connect    --provider <gmail|graph> --email <addr> [--key <name>]
  runs       Show recent run logs
  doctor     Check local environment (Ollama, config)
  help       Show this help

Examples:
  draft-mate serve
  draft-mate triage --account demo --unread --by-category
  draft-mate doctor
`);
}

// --- entrypoint -----------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  const cfg = loadConfig();

  switch (command) {
    case "serve": return cmdServe(args, cfg);
    case "triage": return cmdTriage(args, cfg);
    case "draft": return cmdDraft(args, cfg);
    case "drafts": return cmdDrafts(args, cfg);
    case "approve": return cmdApprove(args, cfg);
    case "accounts": return cmdAccounts(cfg);
    case "connect": return cmdConnect(args, cfg);
    case "runs": return cmdRuns(cfg);
    case "doctor": return cmdDoctor(cfg);
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
});

/**
 * Local web server for the draft-mate dashboard.
 *
 * Binds to loopback only. Serves the static SPA from `web/` and a small JSON +
 * SSE API backed by the exact same triage engine the CLI uses. No email content
 * leaves the machine: analysis is local heuristics and/or the loopback LLM.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadConfig, type AccountConfig, type Config } from "../config.js";
import type { FetchFilter } from "../types.js";
import { Store } from "../store/store.js";
import { runTriage } from "../pipeline.js";
import { makeDraft } from "../drafting.js";
import { isAvailable, listModels } from "../llm/ollama.js";
import { getProvider } from "../providers/provider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/server/server.js → project root → web/
const WEB_DIR = join(HERE, "..", "..", "web");

const DEMO_ACCOUNT: AccountConfig = { key: "demo", provider: "mock", email: "demo" };

function accounts(cfg: Config): AccountConfig[] {
  return [DEMO_ACCOUNT, ...cfg.accounts];
}
function resolveAccount(cfg: Config, key: string | null): AccountConfig {
  const found = accounts(cfg).find((a) => a.key === key || a.email === key);
  return found ?? DEMO_ACCOUNT;
}

// --- http helpers ---------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json);
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Prevent path traversal: resolve within WEB_DIR only.
  const full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(normalize(WEB_DIR)) || !existsSync(full)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const data = await readFile(full);
  res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
  res.end(data);
}

// --- API ------------------------------------------------------------------

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  cfg: Config,
): Promise<void> {
  const { pathname } = url;
  const store = Store.open(cfg);

  // GET /api/health — environment + model status.
  if (pathname === "/api/health" && req.method === "GET") {
    const up = await isAvailable(cfg);
    const models = up ? await listModels(cfg) : [];
    return sendJson(res, 200, {
      ollamaUp: up,
      model: cfg.ollama.model,
      modelPulled: models.includes(cfg.ollama.model),
      models,
      accounts: accounts(cfg).map((a) => ({ key: a.key, provider: a.provider, email: a.email })),
    });
  }

  // GET /api/inbox?account= — cached analyses from the last run (instant).
  if (pathname === "/api/inbox" && req.method === "GET") {
    const account = resolveAccount(cfg, url.searchParams.get("account"));
    const analyses = store.getAnalyses(account.email);
    const { compareAnalyses } = await import("../scoring.js");
    analyses.sort(compareAnalyses);
    return sendJson(res, 200, { account: account.key, analyses, run: store.listRuns()[0] ?? null });
  }

  // GET /api/triage/stream?account=&unread=&limit=&refresh= — SSE progress + result.
  if (pathname === "/api/triage/stream" && req.method === "GET") {
    const account = resolveAccount(cfg, url.searchParams.get("account"));
    const filter: FetchFilter = {
      limit: parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
      ...(url.searchParams.get("unread") === "1" ? { unread: true } : {}),
      ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: "start", account: account.key });
    try {
      const result = await runTriage(
        {
          account,
          filter,
          refresh: url.searchParams.get("refresh") === "1",
          onProgress: (done, total, mode) => send({ type: "progress", done, total, mode }),
        },
        cfg,
        store,
      );
      send({ type: "done", analyses: result.analyses, run: result.run, source: result.source });
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
    res.end();
    return;
  }

  // GET /api/email?account=&id= — full message for the detail view.
  if (pathname === "/api/email" && req.method === "GET") {
    const account = resolveAccount(cfg, url.searchParams.get("account"));
    const id = url.searchParams.get("id");
    if (!id) return sendJson(res, 400, { error: "missing id" });
    const provider = await getProvider(account, cfg);
    const email = await provider.getMessage(id);
    return sendJson(res, 200, email);
  }

  // POST /api/draft {account, messageId} — generate a reply draft.
  if (pathname === "/api/draft" && req.method === "POST") {
    const { account: acctKey, messageId } = await readBody<{ account: string; messageId: string }>(req);
    const account = resolveAccount(cfg, acctKey);
    const provider = await getProvider(account, cfg);
    const email = await provider.getMessage(messageId);
    const analysis = store.getAnalysis(account.email, messageId);
    const draft = await makeDraft(email, analysis, cfg);
    store.saveDraft(draft);
    return sendJson(res, 200, draft);
  }

  // GET /api/drafts?account=
  if (pathname === "/api/drafts" && req.method === "GET") {
    const account = resolveAccount(cfg, url.searchParams.get("account"));
    return sendJson(res, 200, { drafts: store.listDrafts(account.email) });
  }

  // PUT /api/draft/:id {subject, body} — save edits from the editor.
  const editMatch = pathname.match(/^\/api\/draft\/([^/]+)$/);
  if (editMatch && req.method === "PUT") {
    const draft = store.getDraft(decodeURIComponent(editMatch[1]!));
    if (!draft) return sendJson(res, 404, { error: "no such draft" });
    const body = await readBody<{ subject?: string; body?: string }>(req);
    if (typeof body.subject === "string") draft.subject = body.subject;
    if (typeof body.body === "string") draft.body = body.body;
    store.saveDraft(draft);
    return sendJson(res, 200, draft);
  }

  // POST /api/draft/:id/approve {save} — approve and optionally save to provider.
  const approveMatch = pathname.match(/^\/api\/draft\/([^/]+)\/approve$/);
  if (approveMatch && req.method === "POST") {
    const draft = store.getDraft(decodeURIComponent(approveMatch[1]!));
    if (!draft) return sendJson(res, 404, { error: "no such draft" });
    const { save } = await readBody<{ save?: boolean }>(req);
    draft.approved = true;
    if (save) {
      const account = resolveAccount(cfg, draft.account);
      const provider = await getProvider(account, cfg);
      const original = await provider.getMessage(draft.messageId);
      draft.providerDraftId = await provider.createDraft(original, draft.subject, draft.body);
    }
    store.saveDraft(draft);
    return sendJson(res, 200, draft);
  }

  // DELETE /api/draft/:id
  const delMatch = pathname.match(/^\/api\/draft\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const ok = store.deleteDraft(decodeURIComponent(delMatch[1]!));
    return sendJson(res, ok ? 200 : 404, { deleted: ok });
  }

  sendJson(res, 404, { error: "unknown endpoint" });
}

export interface ServeOptions {
  port: number;
  host: string;
}

/** Start the dashboard server. Resolves with the bound URL. */
export function startServer(opts: ServeOptions): Promise<string> {
  const cfg = loadConfig();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);
    const work = url.pathname.startsWith("/api/")
      ? handleApi(req, res, url, cfg)
      : serveStatic(res, url.pathname);
    work.catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.host, () => resolve(`http://${opts.host}:${opts.port}`));
  });
}

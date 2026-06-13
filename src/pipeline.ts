/**
 * Triage pipeline — the heart of draft-mate.
 *
 * fetch → (cache) → analyse (local LLM, else heuristics) → score → persist → log.
 * No email content leaves the machine: analysis is either pure local heuristics
 * or a call to the loopback Ollama server.
 */

import type { AccountConfig, Config } from "./config.js";
import type { Analysis, AnalysisSource, FetchFilter, RunLog } from "./types.js";
import { getProvider } from "./providers/provider.js";
import { analyzeHeuristically } from "./heuristics.js";
import { analyzeWithLlm, isAvailable } from "./llm/ollama.js";
import { priorityCounts, compareAnalyses } from "./scoring.js";
import type { Store } from "./store/store.js";

export interface TriageOptions {
  account: AccountConfig;
  filter: FetchFilter;
  /** Force heuristics even if a local LLM is available. */
  forceHeuristics?: boolean;
  /** Re-analyse even if a cached analysis exists. */
  refresh?: boolean;
  onProgress?: (done: number, total: number, mode: AnalysisSource) => void;
}

export interface TriageResult {
  analyses: Analysis[];
  /** Overall source: "llm" if any email used the model, else "heuristics". */
  source: AnalysisSource;
  llmAvailable: boolean;
  run: RunLog;
}

/** Run tasks with bounded concurrency, preserving input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

let idCounter = 0;
function runId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${idCounter++}`;
}

export async function runTriage(
  opts: TriageOptions,
  cfg: Config,
  store: Store,
): Promise<TriageResult> {
  const startedAt = new Date().toISOString();
  const provider = await getProvider(opts.account, cfg);
  const ids = await provider.listMessages(opts.filter);

  const llmAvailable = !opts.forceHeuristics && (await isAvailable(cfg));
  let usedLlm = false;
  let done = 0;

  const analyses = await mapPool(ids, llmAvailable ? 4 : 8, async (id) => {
    // Cache reuse (idempotent re-runs) unless refresh requested.
    if (!opts.refresh) {
      const cached = store.getAnalysis(opts.account.email, id);
      if (cached) {
        opts.onProgress?.(++done, ids.length, cached.source);
        if (cached.source === "llm") usedLlm = true;
        return cached;
      }
    }

    const email = await provider.getMessage(id);
    let analysis: Analysis;
    if (llmAvailable) {
      try {
        analysis = await analyzeWithLlm(email, cfg);
        usedLlm = true;
      } catch {
        analysis = analyzeHeuristically(email, cfg.vips);
      }
    } else {
      analysis = analyzeHeuristically(email, cfg.vips);
    }
    opts.onProgress?.(++done, ids.length, analysis.source);
    return analysis;
  });

  analyses.sort(compareAnalyses);
  store.saveAnalyses(analyses);

  const source: AnalysisSource = usedLlm ? "llm" : "heuristics";
  const run: RunLog = {
    id: runId(),
    account: opts.account.email,
    provider: opts.account.provider,
    filter: opts.filter,
    startedAt,
    finishedAt: new Date().toISOString(),
    analysedCount: analyses.length,
    source,
    model: source === "llm" ? cfg.ollama.model : "none",
    counts: priorityCounts(analyses),
  };
  store.saveRun(run);

  return { analyses, source, llmAvailable, run };
}

/**
 * Local LLM client (Ollama).
 *
 * Talks ONLY to a loopback Ollama server. If the server or model is
 * unavailable, callers fall back to heuristics — there is no cloud fallback,
 * by design. Email content therefore never leaves the machine.
 */

import { assertLocalOllama, type Config } from "../config.js";
import type { Analysis, Email } from "../types.js";
import {
  bandFromScores,
  categorize,
  clampScore,
  scoreTotal,
} from "../scoring.js";
import { computeSignals, type HeuristicResult } from "../heuristics.js";
import {
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SCHEMA,
  buildAnalysisMessages,
  buildDraftMessages,
  DRAFT_SCHEMA,
  type LlmAnalysis,
  type LlmDraft,
} from "./prompts.js";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Is a local Ollama server reachable? (short timeout, no throw) */
export async function isAvailable(cfg: Config): Promise<boolean> {
  try {
    assertLocalOllama(cfg.ollama.baseUrl);
    const res = await fetchWithTimeout(`${cfg.ollama.baseUrl}/api/tags`, {}, 2500);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Force the model to load into memory before the batch, so concurrent first
 * requests don't race the (slow) cold-start load and trip their timeouts.
 * Best-effort: never throws.
 */
export async function warmup(cfg: Config): Promise<void> {
  try {
    assertLocalOllama(cfg.ollama.baseUrl);
    await fetchWithTimeout(
      `${cfg.ollama.baseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: cfg.ollama.model,
          prompt: "ok",
          stream: false,
          options: { num_predict: 1 },
        }),
      },
      Math.max(cfg.ollama.timeoutMs, 120_000),
    );
  } catch {
    /* ignore — analysis will fall back to heuristics if the model is truly absent */
  }
}

/** List installed model tags. Returns [] if the server is unreachable. */
export async function listModels(cfg: Config): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${cfg.ollama.baseUrl}/api/tags`, {}, 2500);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

interface ChatResult {
  message?: { content?: string };
}

/** One JSON-constrained chat call. Throws on transport/parse failure. */
async function chatJson<T>(
  cfg: Config,
  system: string,
  user: string,
  schema: unknown,
): Promise<T> {
  assertLocalOllama(cfg.ollama.baseUrl);
  const res = await fetchWithTimeout(
    `${cfg.ollama.baseUrl}/api/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        format: schema,
        options: { temperature: cfg.ollama.temperature },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    cfg.ollama.timeoutMs,
  );
  if (!res.ok) {
    throw new Error(`Ollama responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as ChatResult;
  let content = data.message?.content?.trim();
  if (!content) throw new Error("Ollama returned an empty response");
  // Defensive: strip ```json fences some models add despite format constraints.
  const fence = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) content = fence[1].trim();
  return JSON.parse(content) as T;
}

/** True if a string is actually a JSON object/array rather than prose. */
function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/** Fall back to a snippet-derived summary when the model misuses the field. */
function safeSummary(raw: string | undefined, email: Email): string {
  if (raw && raw.trim() && !looksLikeJson(raw)) return raw.trim();
  const src = (email.snippet || email.bodyText || "").replace(/\s+/g, " ").trim();
  if (!src) return "(no preview available)";
  const twoSentences = src.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return twoSentences.length > 200 ? twoSentences.slice(0, 197) + "…" : twoSentences;
}

/**
 * Analyse one email with the local LLM, folding in heuristic priors and the
 * authoritative scoring rubric. Throws if the LLM is unavailable or misbehaves;
 * the pipeline catches that and falls back to heuristics.
 */
export async function analyzeWithLlm(email: Email, cfg: Config): Promise<Analysis> {
  const signals: HeuristicResult = computeSignals(email, cfg.vips);
  const { system, user } = buildAnalysisMessages(email, signals, cfg.maxBodyChars);
  const out = await chatJson<LlmAnalysis>(cfg, system, user, ANALYSIS_SCHEMA);

  const scores = {
    urgency: clampScore(out.scores.urgency),
    replyNeeded: clampScore(out.scores.replyNeeded),
    // Trust heuristics for VIP status — the model can't know the user's VIP list.
    senderImportance: signals.isVip
      ? 3
      : clampScore(out.scores.senderImportance),
    businessImpact: clampScore(out.scores.businessImpact),
    meetingRelevance: clampScore(out.scores.meetingRelevance),
    actionItems: clampScore(out.scores.actionItems),
  };

  const deadline = out.deadline ?? signals.deadline;
  const total = scoreTotal(scores);
  const priority = bandFromScores(scores, total, {
    isBulk: signals.isBulk,
    hasDeadline: Boolean(deadline),
  });
  const category = categorize(scores, priority, {
    isBulk: signals.isBulk,
    needsReply: out.needsReply,
    waitingOnSomeone: out.waitingOnSomeone,
  });

  return {
    messageId: email.id,
    account: email.account,
    provider: email.provider,
    from: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt,
    summary: safeSummary(out.summary, email),
    scores,
    scoreTotal: total,
    priority,
    priorityReason: out.priorityReason,
    category,
    ...(deadline ? { deadline } : {}),
    requestedActions: out.requestedActions.slice(0, 5),
    recommendedAction: out.recommendedAction,
    ...(signals.deadline || out.deadline
      ? { suggestedReplyDeadline: deadline }
      : {}),
    needsReply: out.needsReply,
    source: "llm",
    model: cfg.ollama.model,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    analysedAt: new Date().toISOString(),
  };
}

/** Generate a reply draft with the local LLM. Throws if unavailable. */
export async function draftWithLlm(
  email: Email,
  summary: string,
  cfg: Config,
  tone = "concise professional",
): Promise<LlmDraft> {
  const { system, user } = buildDraftMessages(email, summary, tone, cfg.maxBodyChars);
  const out = await chatJson<LlmDraft>(cfg, system, user, DRAFT_SCHEMA);
  return { subject: out.subject, body: out.body };
}

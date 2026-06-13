/**
 * Priority scoring rubric + grouping.
 *
 * Implements section 8 of the build plan: each email carries six 0–3 sub-scores;
 * a weighted sum maps to a Critical/High/Medium/Low band, with a few override
 * rules for high-stakes combinations.
 */

import type { Analysis, Category, Priority, Scores } from "./types.js";

/** Rubric weights, per dimension. */
export const WEIGHTS: Record<keyof Scores, number> = {
  urgency: 3,
  replyNeeded: 3,
  senderImportance: 2,
  businessImpact: 2,
  meetingRelevance: 1,
  actionItems: 1,
};

/** Maximum achievable weighted total (all dimensions at 3). */
export const MAX_TOTAL = Object.values(WEIGHTS).reduce((sum, w) => sum + w * 3, 0); // 36

/** Clamp a raw value into the valid 0–3 sub-score range. */
export function clampScore(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(3, Math.round(n)));
}

/** Weighted sum of the rubric. */
export function scoreTotal(scores: Scores): number {
  return (Object.keys(WEIGHTS) as (keyof Scores)[]).reduce(
    (sum, dim) => sum + clampScore(scores[dim]) * WEIGHTS[dim],
    0,
  );
}

export interface BandContext {
  /** Heuristics flagged this as bulk/automated mail. */
  isBulk?: boolean;
  /** A concrete deadline was detected. */
  hasDeadline?: boolean;
}

/**
 * Map sub-scores + total to a priority band.
 *
 * Override rules (highest precedence first):
 *  - urgency=3 AND replyNeeded=3            -> Critical
 *  - businessImpact=3 WITH a deadline       -> Critical
 *  - bulk/automated mail                    -> at most Low
 */
export function bandFromScores(
  scores: Scores,
  total: number,
  ctx: BandContext = {},
): Priority {
  if (ctx.isBulk) return "Low";
  if (scores.urgency >= 3 && scores.replyNeeded >= 3) return "Critical";
  if (scores.businessImpact >= 3 && ctx.hasDeadline) return "Critical";
  if (total >= 24) return "Critical";
  if (total >= 16) return "High";
  if (total >= 8) return "Medium";
  return "Low";
}

/**
 * Choose the actionable category for an email from its scores + flags.
 * This is the grouping shown as inbox tabs.
 */
export function categorize(
  scores: Scores,
  priority: Priority,
  ctx: { isBulk?: boolean; needsReply: boolean; waitingOnSomeone?: boolean },
): Category {
  if (ctx.isBulk) return "newsletter_automated";
  if (priority === "Low") return "low_or_spam";
  if (ctx.waitingOnSomeone) return "waiting_on_someone";
  if (ctx.needsReply && (priority === "Critical" || priority === "High")) {
    return "reply_immediately";
  }
  if (priority === "Critical" || priority === "High" || priority === "Medium") {
    return "needs_review_today";
  }
  return "informational";
}

/** Human-readable labels for categories (used by the renderer). */
export const CATEGORY_LABELS: Record<Category, string> = {
  reply_immediately: "Reply immediately",
  needs_review_today: "Needs review today",
  waiting_on_someone: "Waiting on someone",
  informational: "Informational",
  newsletter_automated: "Newsletters / automated",
  low_or_spam: "Low priority / spam",
};

/** Display order for priority bands (highest first). */
export const PRIORITY_ORDER: Priority[] = ["Critical", "High", "Medium", "Low"];

const PRIORITY_RANK: Record<Priority, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/**
 * Ranking comparator: priority band first, then weighted total, then most
 * recent. Suitable for `Array.prototype.sort`.
 */
export function compareAnalyses(a: Analysis, b: Analysis): number {
  const byBand = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byBand !== 0) return byBand;
  if (b.scoreTotal !== a.scoreTotal) return b.scoreTotal - a.scoreTotal;
  return b.receivedAt.localeCompare(a.receivedAt);
}

/** Tally analyses into per-priority counts (for run logs + summaries). */
export function priorityCounts(analyses: Analysis[]): Record<Priority, number> {
  const counts: Record<Priority, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const a of analyses) counts[a.priority]++;
  return counts;
}

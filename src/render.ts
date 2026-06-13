/**
 * Terminal rendering for the ranked inbox + drafts.
 *
 * Dependency-free ANSI styling. Colour is disabled automatically when stdout is
 * not a TTY or when NO_COLOR is set.
 */

import type { Analysis, Category, Draft, Priority } from "./types.js";
import { CATEGORY_LABELS, PRIORITY_ORDER, priorityCounts } from "./scoring.js";

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const code = (n: number) => (s: string) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = code(1);
const dim = code(2);
const red = code(31);
const yellow = code(33);
const cyan = code(36);
const green = code(32);
const gray = code(90);

const PRIORITY_STYLE: Record<Priority, { icon: string; color: (s: string) => string }> = {
  Critical: { icon: "●", color: red },
  High: { icon: "●", color: yellow },
  Medium: { icon: "○", color: cyan },
  Low: { icon: "·", color: gray },
};

function senderLabel(a: Analysis): string {
  return a.from.name && a.from.name !== a.from.email
    ? `${a.from.name} · ${a.from.email}`
    : a.from.email || "(unknown sender)";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/** One-line-per-field card for a single analysis. */
function renderCard(a: Analysis, index: number): string {
  const style = PRIORITY_STYLE[a.priority];
  const head = `${style.color(style.icon)} ${bold(style.color(a.priority.toUpperCase().padEnd(8)))} ${bold(a.subject)}`;
  const lines = [
    `${dim(String(index).padStart(2))}. ${head}`,
    `    ${gray("from")} ${senderLabel(a)}   ${gray("received")} ${fmtDate(a.receivedAt)}`,
    `    ${a.summary}`,
    `    ${gray("why:")} ${a.priorityReason}`,
    `    ${gray("do:")}  ${green(a.recommendedAction)}`,
  ];
  if (a.deadline) lines.push(`    ${gray("deadline:")} ${a.deadline}`);
  if (a.suggestedReplyDeadline) lines.push(`    ${gray("reply by:")} ${yellow(a.suggestedReplyDeadline)}`);
  return lines.join("\n");
}

function bar(counts: Record<Priority, number>): string {
  return PRIORITY_ORDER.map((p) => {
    const n = counts[p];
    const txt = `${p} ${n}`;
    return PRIORITY_STYLE[p].color(txt);
  }).join(dim(" | "));
}

export interface RenderOptions {
  /** Group output under category headers instead of one flat ranked list. */
  byCategory?: boolean;
  /** Cap the number of cards shown. */
  limit?: number;
}

export function renderInbox(analyses: Analysis[], opts: RenderOptions = {}): string {
  if (analyses.length === 0) return dim("No emails matched your filter.");

  const counts = priorityCounts(analyses);
  const out: string[] = [];
  out.push(bold("Ranked inbox") + dim(`  (${analyses.length} emails)`));
  out.push(bar(counts));
  out.push("");

  const shown = opts.limit ? analyses.slice(0, opts.limit) : analyses;

  if (opts.byCategory) {
    const order: Category[] = [
      "reply_immediately",
      "needs_review_today",
      "waiting_on_someone",
      "informational",
      "newsletter_automated",
      "low_or_spam",
    ];
    let i = 1;
    for (const cat of order) {
      const group = shown.filter((a) => a.category === cat);
      if (group.length === 0) continue;
      out.push(bold(cyan(`▌ ${CATEGORY_LABELS[cat]} (${group.length})`)));
      for (const a of group) out.push(renderCard(a, i++), "");
    }
  } else {
    shown.forEach((a, idx) => out.push(renderCard(a, idx + 1), ""));
  }

  if (opts.limit && analyses.length > opts.limit) {
    out.push(dim(`… and ${analyses.length - opts.limit} more. Use --limit to show more.`));
  }
  return out.join("\n");
}

export function renderDraft(draft: Draft): string {
  return [
    bold(`Draft ${draft.id}`) + dim(` (for message ${draft.messageId}, ${draft.approved ? green("approved") : yellow("pending approval")})`),
    `${gray("Subject:")} ${draft.subject}`,
    gray("─".repeat(40)),
    draft.body,
    gray("─".repeat(40)),
  ].join("\n");
}

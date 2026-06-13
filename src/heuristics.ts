/**
 * Heuristic pre-filter + offline analyzer.
 *
 * Cheap, deterministic signals derived from headers, sender, subject and body.
 * Two jobs:
 *   1. Provide *priors* (bulk?, VIP?, deadline?) that the LLM path also uses.
 *   2. Produce a full {@link Analysis} on its own when no local LLM is available,
 *      so draft-mate still ranks the inbox (degraded, but useful).
 */

import type { Analysis, Email, Scores } from "./types.js";
import {
  bandFromScores,
  categorize,
  clampScore,
  scoreTotal,
} from "./scoring.js";

export const HEURISTIC_PROMPT_VERSION = "heuristics-v1";

// --- keyword banks --------------------------------------------------------

const URGENT_WORDS = [
  "urgent", "asap", "immediately", "right away", "time sensitive",
  "time-sensitive", "deadline", "overdue", "as soon as possible", "critical",
  "emergency", "expedite", "expedite", "by eod", "end of day", "by cob",
];
const BUSINESS_WORDS = [
  "invoice", "payment", "wire", "contract", "legal", "lawsuit", "compliance",
  "renewal", "budget", "purchase order", "po ", "refund", "overdue", "audit",
  "nda", "agreement", "sign-off", "sign off", "approval", "approve", "quote",
  "proposal", "client", "customer", "escalation", "outage", "incident", "sla",
];
const MEETING_WORDS = [
  "meeting", "calendar", "invite", "reschedule", "availability", "available",
  "schedule", "call", "zoom", "google meet", "teams", "appointment", "agenda",
  "rsvp", "1:1", "sync", "catch up", "catch-up",
];
const ACTION_WORDS = [
  "please", "could you", "can you", "would you", "kindly", "need you to",
  "action required", "action needed", "follow up", "follow-up", "review",
  "complete", "submit", "send me", "provide", "confirm", "let me know",
  "fill out", "respond", "reply",
];
const WAITING_WORDS = [
  "i'll get back to you", "will get back to you", "i will send", "i'll send",
  "once i", "will follow up", "get back to you", "waiting on", "pending",
  "will let you know", "as soon as i", "i'll update you",
];
const NEWSLETTER_HINTS = [
  "newsletter", "unsubscribe", "no-reply", "noreply", "donotreply",
  "do-not-reply", "notifications@", "mailer", "marketing@", "digest",
  "weekly update", "promo", "% off", "sale", "deals",
];

// --- detectors ------------------------------------------------------------

function lc(s: string): string {
  return s.toLowerCase();
}

function countHits(haystack: string, words: string[]): number {
  let n = 0;
  for (const w of words) if (haystack.includes(w)) n++;
  return n;
}

/** Bulk / automated mail: List-Unsubscribe, no-reply sender, or newsletter cues. */
export function detectBulk(email: Email): boolean {
  if (email.listUnsubscribe) return true;
  const headerKeys = Object.keys(email.headers ?? {});
  if (headerKeys.some((k) => k === "list-unsubscribe" || k === "list-id")) return true;
  const sender = lc(email.from.email);
  if (
    sender.includes("no-reply") ||
    sender.includes("noreply") ||
    sender.includes("donotreply") ||
    sender.includes("do-not-reply") ||
    sender.startsWith("notifications@") ||
    sender.startsWith("mailer") ||
    sender.startsWith("bounce")
  ) {
    return true;
  }
  const subject = lc(email.subject);
  return NEWSLETTER_HINTS.some((h) => subject.includes(h));
}

/** Is the sender a configured VIP (exact address or domain match)? */
export function isVip(email: Email, vips: string[]): boolean {
  if (vips.length === 0) return false;
  const sender = lc(email.from.email);
  const domain = sender.split("@")[1] ?? "";
  return vips.some((v) => {
    const needle = lc(v.trim());
    if (!needle) return false;
    if (needle.startsWith("@")) return domain === needle.slice(1) || sender.endsWith(needle);
    if (needle.includes("@")) return sender === needle;
    return domain === needle || domain.endsWith("." + needle);
  });
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Detect a deadline phrase in text, resolved relative to `base` (the time the
 * message was received). Returns an ISO date + the matched phrase, if any.
 */
export function detectDeadline(
  text: string,
  base: Date,
): { iso: string; phrase: string } | null {
  const t = lc(text);

  // Relative day words.
  if (/\b(today|by eod|end of day|by cob|tonight)\b/.test(t)) {
    return { iso: toIsoDate(base), phrase: "today" };
  }
  if (/\btomorrow\b/.test(t)) {
    return { iso: toIsoDate(addDays(base, 1)), phrase: "tomorrow" };
  }
  if (/\b(this week|by (the )?end of (the )?week|by eow)\b/.test(t)) {
    const dow = base.getUTCDay();
    const daysToFri = (5 - dow + 7) % 7 || 5;
    return { iso: toIsoDate(addDays(base, daysToFri)), phrase: "end of week" };
  }

  // Named weekday, optionally "by <weekday>" / "next <weekday>".
  const dayMatch = t.match(/\b(?:by |next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayMatch && dayMatch[1]) {
    const target = WEEKDAYS.indexOf(dayMatch[1]);
    const dow = base.getUTCDay();
    let delta = (target - dow + 7) % 7;
    if (delta === 0) delta = 7; // "Friday" said on a Friday means next Friday
    return { iso: toIsoDate(addDays(base, delta)), phrase: dayMatch[1] };
  }

  // Explicit ISO date.
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && iso[1]) return { iso: iso[1], phrase: iso[1] };

  // "Jun 19", "June 19", "19 June".
  const monthName = MONTHS.join("|");
  const md = t.match(new RegExp(`\\b(${monthName})[a-z]*\\.?\\s+(\\d{1,2})\\b`));
  const dm = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthName})[a-z]*\\b`));
  const hit = md ?? dm;
  if (hit) {
    const monthStr = (md ? hit[1] : hit[2])!;
    const dayStr = (md ? hit[2] : hit[1])!;
    const month = MONTHS.findIndex((m) => m.startsWith(monthStr.slice(0, 3)));
    const day = parseInt(dayStr, 10);
    if (month >= 0 && day >= 1 && day <= 31) {
      let year = base.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, month, day));
      if (candidate.getTime() < base.getTime() - 86_400_000) year += 1; // past -> next year
      return { iso: toIsoDate(new Date(Date.UTC(year, month, day))), phrase: `${monthStr} ${day}` };
    }
  }

  return null;
}

/** First ~2 sentences of the body (or the snippet) as a quick summary. */
function buildSummary(email: Email): string {
  const source = (email.snippet || email.bodyText || "").replace(/\s+/g, " ").trim();
  if (!source) return "(no preview available)";
  const sentences = source.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return sentences.length > 200 ? sentences.slice(0, 197) + "…" : sentences;
}

/** Pull out up to 3 imperative-looking request lines. */
function extractRequestedActions(email: Email): string[] {
  const text = `${email.subject}\n${email.bodyText}`;
  const lines = text.split(/[\n.;]+/).map((l) => l.trim()).filter(Boolean);
  const actions: string[] = [];
  for (const line of lines) {
    const l = lc(line);
    if (ACTION_WORDS.some((w) => l.includes(w)) || /\?\s*$/.test(line)) {
      const clean = line.replace(/\s+/g, " ").slice(0, 120);
      if (clean.length > 4) actions.push(clean);
    }
    if (actions.length >= 3) break;
  }
  return actions;
}

function suggestReplyDeadline(
  base: Date,
  needsReply: boolean,
  deadline: string | undefined,
  priority: string,
): string | undefined {
  if (!needsReply) return undefined;
  if (deadline) {
    // Reply a day before the hard deadline (but not in the past relative to base).
    const dl = new Date(deadline + "T00:00:00Z");
    const dayBefore = addDays(dl, -1);
    return toIsoDate(dayBefore.getTime() < base.getTime() ? dl : dayBefore);
  }
  const lead = priority === "Critical" ? 1 : priority === "High" ? 2 : 4;
  return toIsoDate(addDays(base, lead));
}

// --- main heuristic analyzer ---------------------------------------------

export interface HeuristicResult {
  scores: Scores;
  isBulk: boolean;
  isVip: boolean;
  needsReply: boolean;
  waitingOnSomeone: boolean;
  /** True when explicitly urgent wording was found (not merely a deadline). */
  urgentLanguage: boolean;
  deadline?: string;
}

/** Phrases that explicitly say no reply/action is expected. */
const NO_ACTION_RE =
  /\b(no action (needed|required)|nothing (is )?needed from you|no (response|reply) (needed|required|necessary)|just (keeping you in the loop|fyi|for your awareness))\b/;

/** Compute raw heuristic signals (also reused as priors for the LLM path). */
export function computeSignals(email: Email, vips: string[]): HeuristicResult {
  const haystack = lc(`${email.subject}\n${email.snippet}\n${email.bodyText}`);
  const bulk = detectBulk(email);
  const vip = isVip(email, vips);
  const base = new Date(email.receivedAt);
  const deadline = detectDeadline(haystack, isNaN(base.getTime()) ? new Date() : base);

  const questionCount = (haystack.match(/\?/g) ?? []).length;
  const actionHits = countHits(haystack, ACTION_WORDS);
  const urgentHits = countHits(haystack, URGENT_WORDS);
  const businessHits = countHits(haystack, BUSINESS_WORDS);
  const meetingHits = countHits(haystack, MEETING_WORDS);
  const waitingHits = countHits(haystack, WAITING_WORDS);
  const saysNoAction = NO_ACTION_RE.test(haystack);

  const needsReply = !bulk && !saysNoAction && (questionCount > 0 || actionHits > 0);
  const waitingOnSomeone = !bulk && waitingHits > 0 && !needsReply;

  const scores: Scores = {
    // A bare deadline nudges urgency by 1; explicit urgent wording adds more.
    urgency: clampScore((deadline ? 1 : 0) + Math.min(urgentHits, 2)),
    replyNeeded: clampScore(
      needsReply ? Math.min(questionCount, 2) + Math.min(actionHits, 1) : 0,
    ),
    senderImportance: clampScore(vip ? 3 : bulk ? 0 : 1),
    businessImpact: clampScore(Math.min(businessHits, 3)),
    meetingRelevance: clampScore(Math.min(meetingHits, 2) + (meetingHits > 0 && needsReply ? 1 : 0)),
    actionItems: clampScore(needsReply ? Math.min(actionHits, 3) : 0),
  };

  return {
    scores,
    isBulk: bulk,
    isVip: vip,
    needsReply,
    waitingOnSomeone,
    urgentLanguage: urgentHits > 0,
    ...(deadline ? { deadline: deadline.iso } : {}),
  };
}

/** Produce a complete Analysis from heuristics alone (no LLM). */
export function analyzeHeuristically(email: Email, vips: string[]): Analysis {
  const sig = computeSignals(email, vips);
  const total = scoreTotal(sig.scores);
  const priority = bandFromScores(sig.scores, total, {
    isBulk: sig.isBulk,
    hasDeadline: Boolean(sig.deadline),
  });
  const category = categorize(sig.scores, priority, {
    isBulk: sig.isBulk,
    needsReply: sig.needsReply,
    waitingOnSomeone: sig.waitingOnSomeone,
  });

  const reasonParts: string[] = [];
  if (sig.deadline) reasonParts.push(`deadline ~${sig.deadline}`);
  if (sig.urgentLanguage) reasonParts.push("urgent language");
  if (sig.isVip) reasonParts.push("VIP sender");
  if (sig.scores.businessImpact >= 2) reasonParts.push("business/financial impact");
  if (sig.needsReply) reasonParts.push("direct request/question");
  if (sig.isBulk) reasonParts.push("bulk/automated mail");
  const priorityReason = reasonParts.length
    ? reasonParts.join("; ")
    : "no strong priority signals detected";

  const base = new Date(email.receivedAt);
  const replyBy = suggestReplyDeadline(
    isNaN(base.getTime()) ? new Date() : base,
    sig.needsReply,
    sig.deadline,
    priority,
  );

  const recommendedAction = sig.isBulk
    ? "Skim or archive; no reply needed."
    : sig.waitingOnSomeone
      ? "Track — you are waiting on a response from the sender."
      : sig.needsReply
        ? "Reply" + (replyBy ? ` by ${replyBy}.` : ".")
        : "Review for awareness.";

  return {
    messageId: email.id,
    account: email.account,
    provider: email.provider,
    from: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt,
    summary: buildSummary(email),
    scores: sig.scores,
    scoreTotal: total,
    priority,
    priorityReason,
    category,
    ...(sig.deadline ? { deadline: sig.deadline } : {}),
    requestedActions: extractRequestedActions(email),
    recommendedAction,
    ...(replyBy ? { suggestedReplyDeadline: replyBy } : {}),
    needsReply: sig.needsReply,
    source: "heuristics",
    model: "none",
    promptVersion: HEURISTIC_PROMPT_VERSION,
    analysedAt: new Date().toISOString(),
  };
}

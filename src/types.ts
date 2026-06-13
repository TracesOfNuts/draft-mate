/**
 * Core domain model for draft-mate.
 *
 * Everything the pipeline produces flows through these types. Provider adapters
 * normalise Gmail / Microsoft Graph messages into {@link Email}; the triage
 * pipeline turns each Email into an {@link Analysis}.
 */

export type ProviderId = "gmail" | "graph" | "mock";

/** A normalised email address. */
export interface Contact {
  name: string;
  email: string;
}

/**
 * Provider-agnostic representation of a single message. Adapters are responsible
 * for mapping their native payloads onto this shape.
 */
export interface Email {
  /** Provider-native message id. */
  id: string;
  /** Provider-native thread/conversation id (if any). */
  threadId?: string;
  provider: ProviderId;
  /** The account (email address) this message belongs to. */
  account: string;
  from: Contact;
  to: Contact[];
  cc: Contact[];
  subject: string;
  /** Short provider-supplied snippet, when available. */
  snippet: string;
  /** Plain-text body (HTML stripped by the adapter). May be truncated. */
  bodyText: string;
  receivedAt: string; // ISO 8601
  isUnread: boolean;
  hasAttachments: boolean;
  /** Present when the message carries a List-Unsubscribe header (bulk mail). */
  listUnsubscribe?: boolean;
  /** Raw headers the heuristics care about (lower-cased keys). */
  headers?: Record<string, string>;
}

/** Priority bands, highest first. */
export type Priority = "Critical" | "High" | "Medium" | "Low";

/** Actionable buckets the inbox is grouped into. */
export type Category =
  | "reply_immediately"
  | "needs_review_today"
  | "waiting_on_someone"
  | "informational"
  | "newsletter_automated"
  | "low_or_spam";

/**
 * The six rubric dimensions, each scored 0–3. See the priority rubric in the
 * build plan (section 8).
 */
export interface Scores {
  urgency: number;
  replyNeeded: number;
  senderImportance: number;
  businessImpact: number;
  meetingRelevance: number;
  actionItems: number;
}

export const SCORE_DIMENSIONS: (keyof Scores)[] = [
  "urgency",
  "replyNeeded",
  "senderImportance",
  "businessImpact",
  "meetingRelevance",
  "actionItems",
];

/** How a given analysis was produced. */
export type AnalysisSource = "llm" | "heuristics";

/** The full triage result for one email. */
export interface Analysis {
  messageId: string;
  account: string;
  provider: ProviderId;
  from: Contact;
  subject: string;
  receivedAt: string;
  summary: string;
  scores: Scores;
  /** Weighted total of the rubric (see scoring.ts). */
  scoreTotal: number;
  priority: Priority;
  priorityReason: string;
  category: Category;
  /** ISO date (YYYY-MM-DD) of any detected deadline, if present. */
  deadline?: string;
  requestedActions: string[];
  recommendedAction: string;
  /** ISO date the user should aim to reply by, if a reply is needed. */
  suggestedReplyDeadline?: string;
  needsReply: boolean;
  /** "llm" when an Ollama model produced this, else "heuristics". */
  source: AnalysisSource;
  model: string;
  promptVersion: string;
  analysedAt: string; // ISO 8601
}

/** A locally-generated draft reply (Phase 2). Never sent automatically. */
export interface Draft {
  id: string;
  messageId: string;
  account: string;
  provider: ProviderId;
  subject: string;
  body: string;
  /** True once the user has approved it for saving to the provider Drafts. */
  approved: boolean;
  /** Provider draft id, set only after it is saved to the provider. */
  providerDraftId?: string;
  source: AnalysisSource;
  model: string;
  createdAt: string;
}

/** Selection criteria for fetching messages. */
export interface FetchFilter {
  /** Only unread messages. */
  unread?: boolean;
  /** Inclusive lower bound (ISO date or datetime). */
  since?: string;
  /** Max messages to fetch. */
  limit: number;
}

/** A record of one triage run, persisted for auditing. */
export interface RunLog {
  id: string;
  account: string;
  provider: ProviderId;
  filter: FetchFilter;
  startedAt: string;
  finishedAt: string;
  analysedCount: number;
  source: AnalysisSource;
  model: string;
  counts: Record<Priority, number>;
}

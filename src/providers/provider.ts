/**
 * Provider abstraction.
 *
 * Every concrete adapter (Gmail, Graph, mock) normalises its native payloads
 * into the shared {@link Email} model and exposes the same small surface. The
 * triage pipeline is written entirely against this interface.
 */

import type { AccountConfig, Config } from "../config.js";
import type { Email, FetchFilter, ProviderId } from "../types.js";

export interface MailProvider {
  readonly id: ProviderId;
  readonly account: string;
  /** Return message ids matching the filter (most-recent first). */
  listMessages(filter: FetchFilter): Promise<string[]>;
  /** Fetch + normalise a single message. */
  getMessage(id: string): Promise<Email>;
  /**
   * Save a reply DRAFT to the provider's Drafts folder. NEVER sends.
   * Returns the provider's draft id.
   */
  createDraft(original: Email, subject: string, body: string): Promise<string>;
}

/** Provides a fresh OAuth access token for a given account. */
export type TokenProvider = () => Promise<string>;

// --- shared helpers used by real adapters --------------------------------

/** Very small HTML → text reduction (no deps). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Parse a "Display Name <addr@x>" string into a Contact. */
export function parseContact(raw: string | undefined): { name: string; email: string } {
  if (!raw) return { name: "", email: "" };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), email: (m[2] ?? "").trim().toLowerCase() };
  const addr = raw.trim().toLowerCase();
  return { name: addr, email: addr };
}

export function parseContactList(raw: string | undefined): { name: string; email: string }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseContact);
}

/** base64url helpers (Gmail uses base64url for raw message bodies). */
export function base64UrlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
export function base64UrlEncode(data: string): string {
  return Buffer.from(data, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a minimal RFC 822 reply message for saving as a draft.
 * Sets In-Reply-To/References so the draft threads correctly.
 */
export function buildReplyMime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): string {
  const subject = opts.subject.toLowerCase().startsWith("re:") ? opts.subject : `Re: ${opts.subject}`;
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (opts.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    lines.push(`References: ${opts.inReplyTo}`);
  }
  lines.push("", opts.body);
  return lines.join("\r\n");
}

/**
 * Construct the provider for an account. Real providers are wired with a
 * token provider; the mock needs neither network nor tokens.
 */
export async function getProvider(
  acct: AccountConfig,
  cfg: Config,
): Promise<MailProvider> {
  switch (acct.provider) {
    case "mock": {
      const { MockProvider } = await import("./mock.js");
      return MockProvider.fromFixtures(acct.email);
    }
    case "gmail": {
      const { GmailProvider } = await import("./gmail.js");
      const { getAccessToken } = await import("../auth/oauth.js");
      return new GmailProvider(acct.email, () => getAccessToken(acct, cfg));
    }
    case "graph": {
      const { GraphProvider } = await import("./graph.js");
      const { getAccessToken } = await import("../auth/oauth.js");
      return new GraphProvider(acct.email, () => getAccessToken(acct, cfg));
    }
    default:
      throw new Error(`Unknown provider: ${acct.provider satisfies never}`);
  }
}

/** Apply unread/since/limit filtering to an in-memory list (used by mock + tests). */
export function applyFilter(emails: Email[], filter: FetchFilter): Email[] {
  let out = emails;
  if (filter.unread) out = out.filter((e) => e.isUnread);
  if (filter.since) {
    const since = new Date(filter.since).getTime();
    out = out.filter((e) => new Date(e.receivedAt).getTime() >= since);
  }
  out = [...out].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return out.slice(0, filter.limit);
}

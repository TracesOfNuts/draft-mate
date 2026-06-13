/**
 * Gmail adapter (REST, no SDK).
 *
 * Read scope (gmail.readonly) covers list + get. Draft creation needs
 * gmail.compose. We never request or call any send endpoint.
 */

import type { Email, FetchFilter, ProviderId } from "../types.js";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildReplyMime,
  htmlToText,
  parseContact,
  parseContactList,
  type MailProvider,
  type TokenProvider,
} from "./provider.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPart;
}

export class GmailProvider implements MailProvider {
  readonly id: ProviderId = "gmail";

  constructor(
    readonly account: string,
    private readonly token: TokenProvider,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.token();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Gmail API ${res.status} on ${path}: ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as T;
  }

  async listMessages(filter: FetchFilter): Promise<string[]> {
    const q: string[] = [];
    if (filter.unread) q.push("is:unread");
    if (filter.since) {
      const d = new Date(filter.since);
      q.push(`after:${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
    }
    const params = new URLSearchParams({ maxResults: String(filter.limit) });
    if (q.length) params.set("q", q.join(" "));
    const data = await this.req<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return (data.messages ?? []).map((m) => m.id);
  }

  async getMessage(id: string): Promise<Email> {
    const msg = await this.req<GmailMessage>(`/messages/${id}?format=full`);
    return this.normalise(msg);
  }

  async createDraft(original: Email, subject: string, body: string): Promise<string> {
    const messageId = original.headers?.["message-id"];
    const mime = buildReplyMime({
      from: this.account,
      to: `${original.from.name} <${original.from.email}>`,
      subject,
      body,
      ...(messageId ? { inReplyTo: messageId } : {}),
    });
    const payload: Record<string, unknown> = { raw: base64UrlEncode(mime) };
    if (original.threadId) payload["threadId"] = original.threadId;
    const data = await this.req<{ id: string }>(`/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: payload }),
    });
    return data.id;
  }

  private normalise(msg: GmailMessage): Email {
    const headers = new Map<string, string>();
    for (const h of msg.payload?.headers ?? []) headers.set(h.name.toLowerCase(), h.value);

    const bodyText = extractText(msg.payload);
    const received = headers.get("date");

    return {
      id: msg.id,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      provider: "gmail",
      account: this.account,
      from: parseContact(headers.get("from")),
      to: parseContactList(headers.get("to")),
      cc: parseContactList(headers.get("cc")),
      subject: headers.get("subject") ?? "(no subject)",
      snippet: decodeEntities(msg.snippet ?? ""),
      bodyText,
      receivedAt: received ? new Date(received).toISOString() : new Date().toISOString(),
      isUnread: true, // listed via is:unread; Gmail labels are not fetched in MVP
      hasAttachments: hasAttachment(msg.payload),
      ...(headers.has("list-unsubscribe") ? { listUnsubscribe: true } : {}),
      headers: Object.fromEntries(headers),
    };
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/** Walk the MIME tree, preferring text/plain, falling back to stripped HTML. */
function extractText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }
  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    if (plain?.body?.data) return base64UrlDecode(plain.body.data);
    const html = part.parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    if (html?.body?.data) return htmlToText(base64UrlDecode(html.body.data));
    for (const p of part.parts) {
      const nested = extractText(p);
      if (nested) return nested;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return htmlToText(base64UrlDecode(part.body.data));
  }
  return "";
}

function hasAttachment(part: GmailPart | undefined): boolean {
  if (!part) return false;
  if (part.filename && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachment);
}

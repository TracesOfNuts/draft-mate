/**
 * Microsoft Graph adapter (REST, no SDK).
 *
 * Read scope (Mail.Read) covers list + get. Draft creation needs Mail.ReadWrite.
 * Creating a message via POST /me/messages saves it to Drafts — it is never sent.
 */

import type { Email, FetchFilter, ProviderId } from "../types.js";
import {
  htmlToText,
  type MailProvider,
  type TokenProvider,
} from "./provider.js";

const API = "https://graph.microsoft.com/v1.0/me";

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
}

function contact(r: GraphRecipient | undefined): { name: string; email: string } {
  const ea = r?.emailAddress;
  return { name: ea?.name ?? "", email: (ea?.address ?? "").toLowerCase() };
}

export class GraphProvider implements MailProvider {
  readonly id: ProviderId = "graph";

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
      throw new Error(`Graph API ${res.status} on ${path}: ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as T;
  }

  async listMessages(filter: FetchFilter): Promise<string[]> {
    const params = new URLSearchParams({
      $top: String(filter.limit),
      $select: "id",
      $orderby: "receivedDateTime desc",
    });
    const clauses: string[] = [];
    if (filter.unread) clauses.push("isRead eq false");
    if (filter.since) clauses.push(`receivedDateTime ge ${new Date(filter.since).toISOString()}`);
    if (clauses.length) params.set("$filter", clauses.join(" and "));
    const data = await this.req<{ value: { id: string }[] }>(`/messages?${params}`);
    return data.value.map((m) => m.id);
  }

  async getMessage(id: string): Promise<Email> {
    const select =
      "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageHeaders";
    const msg = await this.req<GraphMessage>(`/messages/${id}?$select=${select}`);
    return this.normalise(msg);
  }

  async createDraft(original: Email, subject: string, body: string): Promise<string> {
    const finalSubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
    const data = await this.req<{ id: string }>(`/messages`, {
      method: "POST",
      body: JSON.stringify({
        subject: finalSubject,
        body: { contentType: "Text", content: body },
        toRecipients: [
          { emailAddress: { address: original.from.email, name: original.from.name } },
        ],
      }),
    });
    return data.id;
  }

  private normalise(msg: GraphMessage): Email {
    const headers: Record<string, string> = {};
    for (const h of msg.internetMessageHeaders ?? []) headers[h.name.toLowerCase()] = h.value;

    const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
    const content = msg.body?.content ?? "";
    const bodyText = isHtml ? htmlToText(content) : content;

    return {
      id: msg.id,
      ...(msg.conversationId ? { threadId: msg.conversationId } : {}),
      provider: "graph",
      account: this.account,
      from: contact(msg.from),
      to: (msg.toRecipients ?? []).map(contact),
      cc: (msg.ccRecipients ?? []).map(contact),
      subject: msg.subject ?? "(no subject)",
      snippet: msg.bodyPreview ?? "",
      bodyText,
      receivedAt: msg.receivedDateTime ?? new Date().toISOString(),
      isUnread: msg.isRead === false,
      hasAttachments: Boolean(msg.hasAttachments),
      ...("list-unsubscribe" in headers ? { listUnsubscribe: true } : {}),
      headers,
    };
  }
}

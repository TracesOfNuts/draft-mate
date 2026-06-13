/**
 * Reply-draft generation (Phase 2).
 *
 * Uses the local LLM when available; otherwise produces a safe template draft
 * with [[NEEDS INPUT]] placeholders. Drafts are always returned for human
 * review and are NEVER sent automatically.
 */

import type { Config } from "./config.js";
import type { Analysis, Draft, Email } from "./types.js";
import { draftWithLlm, isAvailable } from "./llm/ollama.js";

let draftCounter = 0;
function draftId(messageId: string): string {
  return `draft-${messageId}-${Date.now().toString(36)}-${draftCounter++}`;
}

function templateBody(email: Email, analysis: Analysis | undefined): string {
  const greetingName = email.from.name?.split(/\s+/)[0] || "there";
  const actions =
    analysis && analysis.requestedActions.length
      ? analysis.requestedActions.map((a) => `- Re: ${a} — [[NEEDS INPUT: your response]]`).join("\n")
      : "- [[NEEDS INPUT: your reply]]";
  return [
    `Hi ${greetingName},`,
    "",
    "Thanks for your email. Here's my response:",
    "",
    actions,
    "",
    "[[NEEDS INPUT: any closing remarks]]",
    "",
    "Best regards,",
    "[[NEEDS INPUT: your name]]",
  ].join("\n");
}

/** Generate a draft reply for an email (local LLM if available, else template). */
export async function makeDraft(
  email: Email,
  analysis: Analysis | undefined,
  cfg: Config,
): Promise<Draft> {
  const subject = email.subject.toLowerCase().startsWith("re:")
    ? email.subject
    : `Re: ${email.subject}`;

  if (await isAvailable(cfg)) {
    try {
      const summary = analysis?.summary ?? email.snippet;
      const out = await draftWithLlm(email, summary, cfg);
      return {
        id: draftId(email.id),
        messageId: email.id,
        account: email.account,
        provider: email.provider,
        subject: out.subject || subject,
        body: out.body,
        approved: false,
        source: "llm",
        model: cfg.ollama.model,
        createdAt: new Date().toISOString(),
      };
    } catch {
      /* fall through to template */
    }
  }

  return {
    id: draftId(email.id),
    messageId: email.id,
    account: email.account,
    provider: email.provider,
    subject,
    body: templateBody(email, analysis),
    approved: false,
    source: "heuristics",
    model: "none",
    createdAt: new Date().toISOString(),
  };
}

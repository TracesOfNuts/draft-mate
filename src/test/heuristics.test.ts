import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeHeuristically,
  computeSignals,
  detectBulk,
  detectDeadline,
  isVip,
} from "../heuristics.js";
import type { Email } from "../types.js";

function email(partial: Partial<Email>): Email {
  return {
    id: "e1",
    provider: "mock",
    account: "demo",
    from: { name: "Test", email: "test@example.com" },
    to: [{ name: "You", email: "you@work.com" }],
    cc: [],
    subject: "",
    snippet: "",
    bodyText: "",
    receivedAt: "2026-06-12T09:00:00Z", // a Friday
    isUnread: true,
    hasAttachments: false,
    ...partial,
  };
}

test("detectBulk: List-Unsubscribe header marks bulk", () => {
  assert.equal(detectBulk(email({ listUnsubscribe: true })), true);
});

test("detectBulk: no-reply sender marks bulk", () => {
  assert.equal(detectBulk(email({ from: { name: "X", email: "no-reply@x.com" } })), true);
});

test("detectBulk: a normal person is not bulk", () => {
  assert.equal(detectBulk(email({ from: { name: "Jane", email: "jane@client.com" } })), false);
});

test("isVip matches exact address and domain", () => {
  const e = email({ from: { name: "Boss", email: "boss@vip.com" } });
  assert.equal(isVip(e, ["boss@vip.com"]), true);
  assert.equal(isVip(e, ["vip.com"]), true);
  assert.equal(isVip(e, ["@vip.com"]), true);
  assert.equal(isVip(e, ["other.com"]), false);
});

test("detectDeadline resolves relative + explicit dates", () => {
  const base = new Date("2026-06-12T09:00:00Z"); // Friday
  assert.equal(detectDeadline("please reply today", base)?.iso, "2026-06-12");
  assert.equal(detectDeadline("due tomorrow", base)?.iso, "2026-06-13");
  assert.equal(detectDeadline("sign by 2026-06-20", base)?.iso, "2026-06-20");
  assert.equal(detectDeadline("let's meet on Monday", base)?.iso, "2026-06-15");
});

test("urgent client email lands Critical with a reply suggestion", () => {
  const a = analyzeHeuristically(
    email({
      from: { name: "Jane", email: "jane@client.com" },
      subject: "Contract sign-off needed by Friday",
      bodyText: "Urgent: please review and confirm sign-off before Friday. This is time sensitive.",
    }),
    ["client.com"],
  );
  assert.equal(a.priority, "Critical");
  assert.equal(a.needsReply, true);
  assert.ok(a.suggestedReplyDeadline, "should suggest a reply deadline");
  assert.equal(a.source, "heuristics");
});

test("newsletter lands Low / newsletter_automated", () => {
  const a = analyzeHeuristically(
    email({
      from: { name: "Deals", email: "marketing@deals.com" },
      subject: "50% off this weekend only",
      bodyText: "Big sale. Unsubscribe anytime.",
      listUnsubscribe: true,
    }),
    [],
  );
  assert.equal(a.priority, "Low");
  assert.equal(a.category, "newsletter_automated");
  assert.equal(a.needsReply, false);
});

test("computeSignals flags waiting-on-someone", () => {
  const sig = computeSignals(
    email({
      from: { name: "Vendor", email: "support@vendor.com" },
      subject: "Re: ticket",
      bodyText: "We will get back to you within 2 business days.",
    }),
    [],
  );
  assert.equal(sig.waitingOnSomeone, true);
  assert.equal(sig.needsReply, false);
});

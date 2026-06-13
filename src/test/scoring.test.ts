import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandFromScores,
  categorize,
  compareAnalyses,
  scoreTotal,
  MAX_TOTAL,
} from "../scoring.js";
import type { Analysis, Scores } from "../types.js";

const zero: Scores = {
  urgency: 0,
  replyNeeded: 0,
  senderImportance: 0,
  businessImpact: 0,
  meetingRelevance: 0,
  actionItems: 0,
};

test("scoreTotal sums weighted dimensions; max is 36", () => {
  assert.equal(scoreTotal(zero), 0);
  const full: Scores = {
    urgency: 3,
    replyNeeded: 3,
    senderImportance: 3,
    businessImpact: 3,
    meetingRelevance: 3,
    actionItems: 3,
  };
  assert.equal(scoreTotal(full), MAX_TOTAL);
  assert.equal(MAX_TOTAL, 36);
});

test("bandFromScores: urgency+replyNeeded both 3 => Critical", () => {
  const s: Scores = { ...zero, urgency: 3, replyNeeded: 3 };
  assert.equal(bandFromScores(s, scoreTotal(s)), "Critical");
});

test("bandFromScores: high business impact + deadline => Critical", () => {
  const s: Scores = { ...zero, businessImpact: 3 };
  assert.equal(bandFromScores(s, scoreTotal(s), { hasDeadline: true }), "Critical");
});

test("bandFromScores: bulk mail is capped at Low", () => {
  const s: Scores = { ...zero, urgency: 3, replyNeeded: 3, businessImpact: 3 };
  assert.equal(bandFromScores(s, scoreTotal(s), { isBulk: true }), "Low");
});

test("bandFromScores: numeric thresholds", () => {
  assert.equal(bandFromScores(zero, 24), "Critical");
  assert.equal(bandFromScores(zero, 16), "High");
  assert.equal(bandFromScores(zero, 8), "Medium");
  assert.equal(bandFromScores(zero, 7), "Low");
});

test("categorize: bulk => newsletter_automated", () => {
  assert.equal(
    categorize(zero, "Low", { isBulk: true, needsReply: false }),
    "newsletter_automated",
  );
});

test("categorize: high priority needing reply => reply_immediately", () => {
  assert.equal(
    categorize(zero, "Critical", { needsReply: true }),
    "reply_immediately",
  );
});

test("categorize: waiting flag => waiting_on_someone", () => {
  assert.equal(
    categorize(zero, "Medium", { needsReply: false, waitingOnSomeone: true }),
    "waiting_on_someone",
  );
});

test("compareAnalyses orders Critical before Low", () => {
  const mk = (priority: Analysis["priority"], total: number): Analysis => ({
    messageId: "x",
    account: "a",
    provider: "mock",
    from: { name: "", email: "" },
    subject: "",
    receivedAt: "2026-06-01T00:00:00Z",
    summary: "",
    scores: zero,
    scoreTotal: total,
    priority,
    priorityReason: "",
    category: "informational",
    requestedActions: [],
    recommendedAction: "",
    needsReply: false,
    source: "heuristics",
    model: "none",
    promptVersion: "v",
    analysedAt: "2026-06-01T00:00:00Z",
  });
  const arr = [mk("Low", 2), mk("Critical", 30), mk("Medium", 10)];
  arr.sort(compareAnalyses);
  assert.deepEqual(arr.map((a) => a.priority), ["Critical", "Medium", "Low"]);
});

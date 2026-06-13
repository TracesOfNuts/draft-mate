import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the data dir at a throwaway location BEFORE loading config.
const TMP = mkdtempSync(join(tmpdir(), "draft-mate-test-"));
process.env["DRAFT_MATE_HOME"] = TMP;

const { loadConfig, _resetConfigCache } = await import("../config.js");
const { Store } = await import("../store/store.js");
const { runTriage } = await import("../pipeline.js");
const { makeDraft } = await import("../drafting.js");
const { MockProvider } = await import("../providers/mock.js");

before(() => {
  _resetConfigCache();
});
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const DEMO = { key: "demo", provider: "mock" as const, email: "demo" };

test("runTriage on the sample inbox ranks and persists (heuristics mode)", async () => {
  const cfg = loadConfig();
  cfg.vips = ["bigclient.com", "partner.com"];
  const store = Store.open(cfg);

  const result = await runTriage(
    { account: DEMO, filter: { unread: true, limit: 50 }, forceHeuristics: true },
    cfg,
    store,
  );

  assert.equal(result.source, "heuristics");
  assert.equal(result.llmAvailable, false);
  assert.equal(result.analyses.length, 10, "all 10 sample emails analysed");

  // Sorted: first item must be the highest band.
  assert.equal(result.analyses[0]!.priority, "Critical");

  // The newsletter + promo should be Low / bulk.
  const promo = result.analyses.find((a) => a.messageId === "m-007");
  assert.equal(promo?.priority, "Low");
  assert.equal(promo?.category, "newsletter_automated");

  // The contract email should be Critical and need a reply.
  const contract = result.analyses.find((a) => a.messageId === "m-001");
  assert.equal(contract?.priority, "Critical");
  assert.equal(contract?.needsReply, true);

  // Run + analyses were persisted.
  assert.equal(store.getAnalyses("demo").length, 10);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.listRuns()[0]!.analysedCount, 10);
});

test("re-running uses the cache (idempotent) unless refresh", async () => {
  const cfg = loadConfig();
  const store = Store.open(cfg);
  const first = await runTriage(
    { account: DEMO, filter: { unread: true, limit: 50 }, forceHeuristics: true },
    cfg,
    store,
  );
  const second = await runTriage(
    { account: DEMO, filter: { unread: true, limit: 50 }, forceHeuristics: true },
    cfg,
    store,
  );
  assert.deepEqual(
    first.analyses.map((a) => a.messageId),
    second.analyses.map((a) => a.messageId),
  );
});

test("makeDraft produces a safe template draft offline (no LLM)", async () => {
  const cfg = loadConfig();
  const provider = MockProvider.fromFixtures("demo");
  const email = await provider.getMessage("m-001");
  const draft = await makeDraft(email, undefined, cfg);

  assert.equal(draft.approved, false, "drafts are never pre-approved");
  assert.match(draft.subject, /^Re: /);
  assert.match(draft.body, /\[\[NEEDS INPUT/, "template marks missing info for the human");
  assert.equal(draft.source, "heuristics");
});

test("mock createDraft saves to provider Drafts and never sends", async () => {
  const provider = MockProvider.fromFixtures("demo");
  const email = await provider.getMessage("m-002");
  const id = await provider.createDraft(email, "Re: test", "body");
  assert.match(id, /^mock-draft-/);
  assert.equal(provider.listDrafts().length, 1);
});

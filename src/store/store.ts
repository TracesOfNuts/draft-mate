/**
 * Local JSON store.
 *
 * Holds analyses, run logs and drafts in a single JSON file under the data dir.
 * Deliberately dependency-free for the MVP; the build plan's SQLite/SQLCipher
 * store is a drop-in replacement behind this same shape later.
 *
 * NOTE: secrets (OAuth tokens) are NOT kept here — see auth/keychain.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, paths, type Config } from "../config.js";
import type { Analysis, Draft, RunLog } from "../types.js";

interface StoreData {
  version: 1;
  analyses: Record<string, Analysis>; // key: `${account}::${messageId}`
  runs: RunLog[];
  drafts: Record<string, Draft>; // key: draft id
}

function emptyData(): StoreData {
  return { version: 1, analyses: {}, runs: [], drafts: {} };
}

const key = (account: string, messageId: string) => `${account}::${messageId}`;

export class Store {
  private constructor(
    private readonly file: string,
    private data: StoreData,
  ) {}

  static open(cfg: Config = loadConfig()): Store {
    const file = paths.store(cfg);
    let data = emptyData();
    if (existsSync(file)) {
      try {
        data = JSON.parse(readFileSync(file, "utf8")) as StoreData;
      } catch {
        data = emptyData();
      }
    }
    return new Store(file, data);
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  // --- analyses ----------------------------------------------------------

  saveAnalyses(analyses: Analysis[]): void {
    for (const a of analyses) this.data.analyses[key(a.account, a.messageId)] = a;
    this.flush();
  }

  getAnalysis(account: string, messageId: string): Analysis | undefined {
    return this.data.analyses[key(account, messageId)];
  }

  getAnalyses(account?: string): Analysis[] {
    const all = Object.values(this.data.analyses);
    return account ? all.filter((a) => a.account === account) : all;
  }

  // --- runs --------------------------------------------------------------

  saveRun(run: RunLog): void {
    this.data.runs.push(run);
    this.flush();
  }

  listRuns(): RunLog[] {
    return [...this.data.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // --- drafts ------------------------------------------------------------

  saveDraft(draft: Draft): void {
    this.data.drafts[draft.id] = draft;
    this.flush();
  }

  getDraft(id: string): Draft | undefined {
    return this.data.drafts[id];
  }

  listDrafts(account?: string): Draft[] {
    const all = Object.values(this.data.drafts);
    return account ? all.filter((d) => d.account === account) : all;
  }

  deleteDraft(id: string): boolean {
    if (!this.data.drafts[id]) return false;
    delete this.data.drafts[id];
    this.flush();
    return true;
  }
}

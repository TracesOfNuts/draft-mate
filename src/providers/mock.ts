/**
 * Mock provider — reads a fixture inbox from disk.
 *
 * Lets the entire pipeline run end-to-end with no credentials and no network,
 * which is how draft-mate is verified locally and in tests. Drafts are kept in
 * memory only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Email, FetchFilter, ProviderId } from "../types.js";
import { applyFilter, type MailProvider } from "./provider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/providers/mock.js → project root → fixtures/
const DEFAULT_FIXTURES = join(HERE, "..", "..", "fixtures", "sample-emails.json");

export class MockProvider implements MailProvider {
  readonly id: ProviderId = "mock";
  private byId = new Map<string, Email>();
  private drafts: { id: string; messageId: string; subject: string; body: string }[] = [];

  constructor(
    readonly account: string,
    emails: Email[],
  ) {
    for (const e of emails) this.byId.set(e.id, { ...e, account, provider: "mock" });
  }

  /** Load the bundled fixture inbox. */
  static fromFixtures(account = "demo", file = DEFAULT_FIXTURES): MockProvider {
    const raw = readFileSync(file, "utf8");
    const emails = JSON.parse(raw) as Email[];
    return new MockProvider(account, emails);
  }

  async listMessages(filter: FetchFilter): Promise<string[]> {
    return applyFilter([...this.byId.values()], filter).map((e) => e.id);
  }

  async getMessage(id: string): Promise<Email> {
    const email = this.byId.get(id);
    if (!email) throw new Error(`Mock message not found: ${id}`);
    return email;
  }

  async createDraft(original: Email, subject: string, body: string): Promise<string> {
    const id = `mock-draft-${this.drafts.length + 1}`;
    this.drafts.push({ id, messageId: original.id, subject, body });
    return id;
  }

  /** Test/inspection helper. */
  listDrafts() {
    return [...this.drafts];
  }
}

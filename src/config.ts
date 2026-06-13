/**
 * Configuration + local data paths.
 *
 * draft-mate is local-first: all state lives under a single data directory
 * (default: ~/.draft-mate). Config is loaded from <dataDir>/config.json if
 * present, with sensible defaults otherwise. No network endpoints other than
 * the email providers and the local Ollama server are ever contacted.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { ProviderId } from "./types.js";

export interface OllamaConfig {
  /** Base URL of the local Ollama server. Must be loopback. */
  baseUrl: string;
  /** Model tag to use for analysis + drafting. */
  model: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Sampling temperature (low for deterministic classification). */
  temperature: number;
}

export interface AccountConfig {
  /** Friendly key used on the CLI, e.g. "work" or "demo". */
  key: string;
  provider: ProviderId;
  /** The email address / UPN. */
  email: string;
}

export interface Config {
  dataDir: string;
  ollama: OllamaConfig;
  /** Senders/domains considered important (boosts sender score). */
  vips: string[];
  /** Max chars of body sent to the LLM (truncated for speed). */
  maxBodyChars: number;
  /** Configured accounts (added via `draft-mate connect`). */
  accounts: AccountConfig[];
}

const DEFAULT_DATA_DIR = process.env.DRAFT_MATE_HOME ?? join(homedir(), ".draft-mate");

const DEFAULTS: Omit<Config, "dataDir" | "accounts"> = {
  ollama: {
    baseUrl: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    model: process.env.DRAFT_MATE_MODEL ?? "qwen2.5:7b-instruct",
    timeoutMs: 60_000,
    temperature: 0.1,
  },
  vips: [],
  maxBodyChars: 4000,
};

/** Loopback hosts the LLM client is permitted to talk to. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Guard: refuse a non-loopback Ollama URL so email content can't leave the box. */
export function assertLocalOllama(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`Invalid OLLAMA base URL: ${baseUrl}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to use non-local Ollama host "${host}". draft-mate only sends email content to a loopback address.`,
    );
  }
}

let cached: Config | null = null;

/** Load config from disk (merging defaults) and ensure the data dir exists. */
export function loadConfig(): Config {
  if (cached) return cached;
  const dataDir = DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });

  const configPath = join(dataDir, "config.json");
  let fileConfig: Partial<Config> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
    }
  }

  const config: Config = {
    dataDir,
    ollama: { ...DEFAULTS.ollama, ...(fileConfig.ollama ?? {}) },
    vips: fileConfig.vips ?? DEFAULTS.vips,
    maxBodyChars: fileConfig.maxBodyChars ?? DEFAULTS.maxBodyChars,
    accounts: fileConfig.accounts ?? [],
  };
  assertLocalOllama(config.ollama.baseUrl);
  cached = config;
  return config;
}

/** Reset the in-memory cache (used by tests). */
export function _resetConfigCache(): void {
  cached = null;
}

export const paths = {
  store: (cfg: Config) => join(cfg.dataDir, "store.json"),
  secrets: (cfg: Config) => join(cfg.dataDir, "secrets.enc"),
  secretKey: (cfg: Config) => join(cfg.dataDir, "secret.key"),
  runsDir: (cfg: Config) => join(cfg.dataDir, "runs"),
};

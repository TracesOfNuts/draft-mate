/**
 * Secret storage.
 *
 * MVP implementation: an AES-256-GCM encrypted file under the data dir, with the
 * key in a sibling 0600 file. This is the documented stand-in for the OS keychain
 * (Windows Credential Manager) named in the build plan — same interface, so it
 * can be swapped for a native keychain binding without touching callers.
 *
 * Tokens are NEVER written to the JSON store or logs in plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, paths, type Config } from "../config.js";

type Vault = Record<string, { iv: string; tag: string; data: string }>;

function loadKey(cfg: Config): Buffer {
  const keyFile = paths.secretKey(cfg);
  if (existsSync(keyFile)) {
    return Buffer.from(readFileSync(keyFile, "utf8"), "hex");
  }
  mkdirSync(dirname(keyFile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return key;
}

function loadVault(cfg: Config): Vault {
  const file = paths.secrets(cfg);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Vault;
  } catch {
    return {};
  }
}

function saveVault(cfg: Config, vault: Vault): void {
  const file = paths.secrets(cfg);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(vault), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function setSecret(name: string, value: string, cfg: Config = loadConfig()): void {
  const key = loadKey(cfg);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const vault = loadVault(cfg);
  vault[name] = { iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc.toString("hex") };
  saveVault(cfg, vault);
}

export function getSecret(name: string, cfg: Config = loadConfig()): string | undefined {
  const vault = loadVault(cfg);
  const entry = vault[name];
  if (!entry) return undefined;
  const key = loadKey(cfg);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(entry.data, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function deleteSecret(name: string, cfg: Config = loadConfig()): void {
  const vault = loadVault(cfg);
  if (vault[name]) {
    delete vault[name];
    saveVault(cfg, vault);
  }
}

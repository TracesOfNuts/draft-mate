/**
 * OAuth 2.0 (Authorization Code + PKCE, loopback redirect).
 *
 * Works for both Gmail (Google "Desktop app" client) and Microsoft Graph
 * (Entra "public client"). Refresh tokens are stored via the keychain module;
 * access tokens are cached in memory until shortly before expiry.
 *
 * Client ids come from the environment so no secrets live in the repo:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (Google desktop clients issue a
 *     non-confidential secret), GMAIL_SCOPES (optional override)
 *   GRAPH_CLIENT_ID, GRAPH_TENANT (default "common"), GRAPH_SCOPES (optional)
 *
 * The interactive flow is not exercised in the sandbox (no browser/creds); the
 * mock provider covers the pipeline end-to-end instead.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AccountConfig, Config } from "../config.js";
import type { ProviderId } from "../types.js";
import { getSecret, setSecret } from "./keychain.js";

interface OAuthEndpoints {
  authorize: string;
  token: string;
  defaultScopes: string;
  clientId: () => string;
  clientSecret?: () => string | undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Set it to your OAuth client id before connecting an account. See README.`,
    );
  }
  return v;
}

function endpointsFor(provider: ProviderId): OAuthEndpoints {
  switch (provider) {
    case "gmail":
      return {
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        defaultScopes:
          process.env["GMAIL_SCOPES"] ??
          "https://www.googleapis.com/auth/gmail.readonly",
        clientId: () => requireEnv("GMAIL_CLIENT_ID"),
        clientSecret: () => process.env["GMAIL_CLIENT_SECRET"],
      };
    case "graph": {
      const tenant = process.env["GRAPH_TENANT"] ?? "common";
      return {
        authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        defaultScopes:
          process.env["GRAPH_SCOPES"] ?? "Mail.Read offline_access",
        clientId: () => requireEnv("GRAPH_CLIENT_ID"),
      };
    }
    default:
      throw new Error(`OAuth not supported for provider: ${provider}`);
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* fall back to printing the URL */
  }
}

const refreshKey = (acct: AccountConfig) => `refresh:${acct.provider}:${acct.email}`;

/**
 * Run the interactive authorization flow and persist the refresh token.
 * Returns once tokens are stored.
 */
export async function authorize(acct: AccountConfig, cfg: Config): Promise<void> {
  const ep = endpointsFor(acct.provider);
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");

  // Computed once, when the loopback server starts listening, and reused for
  // BOTH the auth request and the token exchange so they match exactly. (Do not
  // re-derive from server.address() after close() — it returns null → port 0.)
  let redirectUri = "";
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h3>draft-mate: you can close this tab.</h3></body></html>");
      server.close();
      if (returnedState !== state || !returnedCode) {
        reject(new Error("OAuth callback failed (state mismatch or no code)."));
      } else {
        resolve(returnedCode);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const params = new URLSearchParams({
        client_id: ep.clientId(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: ep.defaultScopes,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      });
      const authUrl = `${ep.authorize}?${params}`;
      console.log(`\nOpen this URL to authorize draft-mate:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
    server.on("error", reject);
  });

  const body = new URLSearchParams({
    client_id: ep.clientId(),
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const secret = ep.clientSecret?.();
  if (secret) body.set("client_secret", secret);

  const res = await fetch(ep.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = (await res.json()) as { refresh_token?: string };
  if (!tokens.refresh_token) {
    throw new Error("No refresh_token returned. Ensure offline access / consent prompt is enabled.");
  }
  setSecret(refreshKey(acct), tokens.refresh_token, cfg);
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** Return a valid access token, refreshing via the stored refresh token. */
export async function getAccessToken(acct: AccountConfig, cfg: Config): Promise<string> {
  const cacheKey = `${acct.provider}:${acct.email}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  const refreshToken = getSecret(refreshKey(acct), cfg);
  if (!refreshToken) {
    throw new Error(`No stored credentials for ${acct.email}. Run: draft-mate connect.`);
  }
  const ep = endpointsFor(acct.provider);
  const body = new URLSearchParams({
    client_id: ep.clientId(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (acct.provider === "graph") body.set("scope", ep.defaultScopes);
  const secret = ep.clientSecret?.();
  if (secret) body.set("client_secret", secret);

  const res = await fetch(ep.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const tokens = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  if (tokens.refresh_token) setSecret(refreshKey(acct), tokens.refresh_token, cfg);

  const entry: CachedToken = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  tokenCache.set(cacheKey, entry);
  return entry.accessToken;
}

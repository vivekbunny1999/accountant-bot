import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { getE2EApiBaseUrl, getE2ECredentials } from "./env";

type AuthLoginResponse = {
  token?: string;
  expires_at?: string | null;
};

type ClientAuthStorageConfig = {
  sessionTokenKey: string;
  sessionExpiresAtKey: string;
  sessionEvent: string;
};

function readClientAuthStorageConfig(): ClientAuthStorageConfig {
  const apiSourcePath = path.join(process.cwd(), "src", "lib", "api.tsx");
  const source = fs.readFileSync(apiSourcePath, "utf8");

  const tokenMatch = source.match(/const SESSION_TOKEN_KEY = "([^"]+)"/);
  const expiresMatch = source.match(/const SESSION_EXPIRES_AT_KEY = "([^"]+)"/);
  const eventMatch = source.match(/const SESSION_EVENT = "([^"]+)"/);

  if (!tokenMatch || !expiresMatch || !eventMatch) {
    throw new Error(`Could not extract auth storage keys from ${apiSourcePath}.`);
  }

  return {
    sessionTokenKey: tokenMatch[1],
    sessionExpiresAtKey: expiresMatch[1],
    sessionEvent: eventMatch[1],
  };
}

export async function loginViaApi() {
  const { email, password } = getE2ECredentials();
  const apiBaseUrl = getE2EApiBaseUrl();
  const loginUrl = new URL("/auth/login", `${apiBaseUrl}/`).toString();

  let response: Response;
  try {
    response = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new Error(
      `API login request failed for ${loginUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const responseText = await response.text();
  let body: AuthLoginResponse | Record<string, unknown> | null = null;

  try {
    body = responseText ? (JSON.parse(responseText) as AuthLoginResponse | Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(
      `API login failed with ${response.status} ${response.statusText} at ${loginUrl}. Body: ${
        responseText || "(empty body)"
      }`
    );
  }

  const token = typeof body?.token === "string" ? body.token : null;
  const expiresAt = typeof body?.expires_at === "string" ? body.expires_at : null;

  if (!token) {
    throw new Error(
      `API login succeeded but no token was returned from ${loginUrl}. Body: ${
        responseText || "(empty body)"
      }`
    );
  }

  return {
    token,
    expiresAt,
    apiBaseUrl,
  };
}

export async function seedAuthenticatedSession(page: Page) {
  const auth = await loginViaApi();
  const storage = readClientAuthStorageConfig();

  await page.addInitScript(
    ({ token, expiresAt, sessionTokenKey, sessionExpiresAtKey, sessionEvent }) => {
      window.localStorage.setItem(sessionTokenKey, token);
      if (expiresAt) {
        window.localStorage.setItem(sessionExpiresAtKey, expiresAt);
      } else {
        window.localStorage.removeItem(sessionExpiresAtKey);
      }
      window.dispatchEvent(new CustomEvent(sessionEvent));
    },
    {
      token: auth.token,
      expiresAt: auth.expiresAt,
      sessionTokenKey: storage.sessionTokenKey,
      sessionExpiresAtKey: storage.sessionExpiresAtKey,
      sessionEvent: storage.sessionEvent,
    }
  );

  await page.evaluate(
    ({ token, expiresAt, sessionTokenKey, sessionExpiresAtKey, sessionEvent }) => {
      window.localStorage.setItem(sessionTokenKey, token);
      if (expiresAt) {
        window.localStorage.setItem(sessionExpiresAtKey, expiresAt);
      } else {
        window.localStorage.removeItem(sessionExpiresAtKey);
      }
      window.dispatchEvent(new CustomEvent(sessionEvent));
    },
    {
      token: auth.token,
      expiresAt: auth.expiresAt,
      sessionTokenKey: storage.sessionTokenKey,
      sessionExpiresAtKey: storage.sessionExpiresAtKey,
      sessionEvent: storage.sessionEvent,
    }
  );

  return {
    ...auth,
    storage,
  };
}

import { expect, test, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import { runStepWithArtifacts } from "./support/artifacts";
import { getE2ECredentials } from "./support/env";

const LOGIN_TIMEOUT_MS = 15_000;

type LoginConsoleError = {
  text: string;
  location?: string;
};

type LoginNetworkFailure = {
  url: string;
  method: string;
  resourceType: string;
  reason: string;
};

function main(page: Page) {
  return page.locator("main");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMoneyForLabel(text: string, label: string) {
  const pattern = new RegExp(`${escapeRegExp(label)}\\s*\\$([0-9,]+(?:\\.\\d{2})?)`, "i");
  const match = pattern.exec(text);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

async function openLogin(page: Page) {
  return runStepWithArtifacts(page, {
    name: "login",
    action: async () => {
      await page.goto("/login", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /log in/i })).toBeVisible();
      await expect(page.getByPlaceholder("Email")).toBeVisible();
      await expect(page.getByPlaceholder("Password")).toBeVisible();
    },
  });
}

function formatConsoleLocation(message: ConsoleMessage) {
  const location = message.location();
  if (!location.url) return undefined;
  const line = typeof location.lineNumber === "number" ? location.lineNumber + 1 : null;
  const column = typeof location.columnNumber === "number" ? location.columnNumber + 1 : null;
  return `${location.url}${line != null ? `:${line}` : ""}${column != null ? `:${column}` : ""}`;
}

function formatNetworkFailure(record: LoginNetworkFailure) {
  return `${record.method} ${record.url} [${record.resourceType}] -> ${record.reason}`;
}

async function getVisibleLoginError(page: Page) {
  const errorMessage = page.locator("form div.text-rose-300").first();
  const isVisible = await errorMessage.isVisible().catch(() => false);
  if (!isVisible) return null;
  return (await errorMessage.textContent())?.trim() || null;
}

async function signIn(page: Page) {
  const { email, password } = getE2ECredentials();
  const consoleErrors: LoginConsoleError[] = [];
  const failedNetworkRequests: LoginNetworkFailure[] = [];
  const seenFailures = new Set<string>();

  const pushFailedRequest = (record: LoginNetworkFailure) => {
    const key = `${record.method}|${record.url}|${record.resourceType}|${record.reason}`;
    if (seenFailures.has(key)) return;
    seenFailures.add(key);
    failedNetworkRequests.push(record);
  };

  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    consoleErrors.push({
      text: message.text(),
      location: formatConsoleLocation(message),
    });
  };

  const onRequestFailed = (request: Request) => {
    const failure = request.failure();
    pushFailedRequest({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      reason: failure?.errorText || "Request failed",
    });
  };

  const onResponse = (response: Response) => {
    if (response.ok()) return;
    const request = response.request();
    pushFailedRequest({
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      reason: `HTTP ${response.status()} ${response.statusText()}`.trim(),
    });
  };

  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);

  try {
    await page.getByRole("button", { name: /^log in$/i }).click();

    await page.waitForFunction(
      () => {
        if (window.location.pathname.startsWith("/dashboard")) return true;
        const errorNode = document.querySelector("form div.text-rose-300");
        if (!(errorNode instanceof HTMLElement)) return false;
        return Boolean(errorNode.offsetWidth || errorNode.offsetHeight || errorNode.getClientRects().length);
      },
      undefined,
      { timeout: LOGIN_TIMEOUT_MS }
    );

    if (page.url().includes("/dashboard")) return;

    const visibleAuthError = await getVisibleLoginError(page);
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const failedRequestsSummary = failedNetworkRequests.length
      ? failedNetworkRequests.map((record) => `- ${formatNetworkFailure(record)}`).join("\n")
      : "- none";
    const consoleErrorsSummary = consoleErrors.length
      ? consoleErrors
          .map((record) => `- ${record.text}${record.location ? ` (${record.location})` : ""}`)
          .join("\n")
      : "- none";

    throw new Error(
      [
        `Login stayed on ${page.url()} instead of reaching /dashboard within ${LOGIN_TIMEOUT_MS}ms.`,
        `Visible auth error: ${visibleAuthError || "none"}`,
        "Failed network requests:",
        failedRequestsSummary,
        "Console errors:",
        consoleErrorsSummary,
        "Visible login page text:",
        pageText || "(empty)",
      ].join("\n")
    );
  } catch (error) {
    if (error instanceof Error && /Login stayed on/.test(error.message)) {
      throw error;
    }

    const visibleAuthError = await getVisibleLoginError(page);
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const failedRequestsSummary = failedNetworkRequests.length
      ? failedNetworkRequests.map((record) => `- ${formatNetworkFailure(record)}`).join("\n")
      : "- none";
    const consoleErrorsSummary = consoleErrors.length
      ? consoleErrors
          .map((record) => `- ${record.text}${record.location ? ` (${record.location})` : ""}`)
          .join("\n")
      : "- none";

    const originalMessage = error instanceof Error ? error.message : String(error);

    throw new Error(
      [
        `Login did not reach /dashboard. Last URL: ${page.url()}.`,
        `Reason: ${originalMessage}`,
        `Visible auth error: ${visibleAuthError || "none"}`,
        "Failed network requests:",
        failedRequestsSummary,
        "Console errors:",
        consoleErrorsSummary,
        "Visible login page text:",
        pageText || "(empty)",
      ].join("\n")
    );
  } finally {
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  }
}

test.describe.serial("Accountant Bot preview QA", () => {
  test("logs in and captures the main Financial OS pages", async ({ page }) => {
    await openLogin(page);

    const dashboardArtifact = await runStepWithArtifacts(page, {
      name: "dashboard",
      action: async () => {
        await signIn(page);
        await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
        await expect(main(page).getByText("Dashboard", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Safe-to-Spend", { exact: true })).toBeVisible();
      },
    });

    await runStepWithArtifacts(page, {
      name: "accounts",
      action: async () => {
        await page.goto("/accounts", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Accounts", { exact: true })).toBeVisible();
        await expect(main(page).getByText(/cash accounts feeding your Financial OS plan/i)).toBeVisible();
      },
    });

    const activityArtifact = await runStepWithArtifacts(page, {
      name: "activity",
      action: async () => {
        await page.goto("/activity", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Activity", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Plaid Activity", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Statement Source", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Manual Activity", { exact: true })).toBeVisible();
      },
    });

    await runStepWithArtifacts(page, {
      name: "bills",
      action: async () => {
        await page.goto("/bills", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Bills", { exact: true })).toBeVisible();
        await expect(main(page).getByText("This feeds Safe-to-Spend", { exact: true })).toBeVisible();
      },
    });

    await runStepWithArtifacts(page, {
      name: "debts",
      action: async () => {
        await page.goto("/debts", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Debts", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Debt registry", { exact: true })).toBeVisible();
      },
    });

    await runStepWithArtifacts(page, {
      name: "settings",
      action: async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Settings", { exact: true })).toBeVisible();
        await expect(main(page).getByText("Connections & Data Sources", { exact: true })).toBeVisible();
      },
    });

    await runStepWithArtifacts(page, {
      name: "settings-account-security",
      action: async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Account Security", { exact: true })).toBeVisible();
        await expect(main(page).getByText(/Change password without breaking the existing session-based auth flow/i)).toBeVisible();
        await main(page).getByText("Account Security", { exact: true }).scrollIntoViewIfNeeded();
        await expect(main(page).getByPlaceholder("Current password").nth(1)).toBeVisible();
        await expect(main(page).getByPlaceholder(/New password/i)).toBeVisible();
        await expect(main(page).getByPlaceholder("Confirm new password")).toBeVisible();
      },
    });

    const visibleSpend = extractMoneyForLabel(activityArtifact.pageText, "Total spend shown");
    if (visibleSpend != null && visibleSpend > 0) {
      expect(dashboardArtifact.pageText).not.toMatch(
        /This Month Spend(?:.|\n)*?\$0\.00(?:.|\n)*?\$0\.00(?:.|\n)*?\$0\.00(?:.|\n)*?\$0\.00/i
      );
    }
  });

  test("shows a specific wrong-current-password error in account security", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await signIn(page);
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);

    const passwordErrorArtifact = await runStepWithArtifacts(page, {
      name: "settings-password-error",
      action: async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(main(page).getByText("Account Security", { exact: true })).toBeVisible();

        await main(page).getByPlaceholder("Current password").nth(1).fill("TotallyWrongPassword123!");
        await main(page).getByPlaceholder(/New password/i).fill("ValidPassword123!");
        await main(page).getByPlaceholder("Confirm new password").fill("ValidPassword123!");
        await main(page).getByRole("button", { name: /change password/i }).click();

        await expect(main(page).getByText("Current password is incorrect.", { exact: true })).toBeVisible();
      },
    });

    expect(passwordErrorArtifact.pageText).toContain("Current password is incorrect.");
    expect(passwordErrorArtifact.pageText).not.toMatch(/Failed to fetch/i);
  });
});

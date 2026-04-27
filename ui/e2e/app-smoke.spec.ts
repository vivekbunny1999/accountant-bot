import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { runStepWithArtifacts, type PageArtifactResult } from "./support/artifacts";
import { seedAuthenticatedSession } from "./support/auth";

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

function extractWeeklySpendAmounts(text: string) {
  const normalizedText = text.replace(/\r/g, "");
  const weeklySectionMatch = /This Month Spend[\s\S]{0,20}?Weekly([\s\S]*?)(?:This Month Categories|Balance Trend)/i.exec(
    normalizedText
  );
  if (!weeklySectionMatch) return [];

  const weekAmounts = [...weeklySectionMatch[1].matchAll(/\bW[1-4]\b[\s\S]*?\$([0-9,]+(?:\.\d{2})?)/g)].map(
    ([, amount]) => Number(amount.replace(/,/g, ""))
  );

  if (weekAmounts.length > 0) return weekAmounts;

  return [...weeklySectionMatch[1].matchAll(/\$([0-9,]+(?:\.\d{2})?)/g)].map(([, amount]) =>
    Number(amount.replace(/,/g, ""))
  );
}

type RequiredPageCapture = {
  name: string;
  route: string;
  assertions: (page: Page) => Promise<void>;
};

const REQUIRED_PAGE_CAPTURES: RequiredPageCapture[] = [
  {
    name: "dashboard",
    route: "/dashboard",
    assertions: async (page) => {
      await expect(main(page).getByText("Dashboard", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Discretionary spend allowance", { exact: true }).first()).toBeVisible();
      await page.getByTestId("dashboard-ready").waitFor({ state: "attached", timeout: 20_000 });
      await expect(page.getByTestId("dashboard-ready")).toHaveAttribute(
        "data-os-state-status",
        /^(ready|unavailable)$/
      );
      await expect(page.getByTestId("dashboard-ready")).toHaveAttribute(
        "data-next-best-dollar-status",
        /^(ready|unavailable)$/
      );
    },
  },
  {
    name: "accounts",
    route: "/accounts",
    assertions: async (page) => {
      await expect(main(page).getByText("Accounts", { exact: true })).toBeVisible();
      await expect(main(page).getByText(/cash accounts feeding your Financial OS plan/i)).toBeVisible();
    },
  },
  {
    name: "activity",
    route: "/activity",
    assertions: async (page) => {
      await expect(main(page).getByText("Activity", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Plaid Activity", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Statement Source", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Manual Activity", { exact: true })).toBeVisible();
    },
  },
  {
    name: "bills",
    route: "/bills",
    assertions: async (page) => {
      await expect(main(page).getByText("Bills", { exact: true })).toBeVisible();
      await expect(main(page).getByText("This feeds Safe-to-Spend", { exact: true })).toBeVisible();
    },
  },
  {
    name: "debts",
    route: "/debts",
    assertions: async (page) => {
      await expect(main(page).getByText("Debts", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Debt registry", { exact: true })).toBeVisible();
    },
  },
  {
    name: "settings",
    route: "/settings",
    assertions: async (page) => {
      await expect(main(page).getByText("Settings", { exact: true })).toBeVisible();
      await expect(main(page).getByText("Connections & Data Sources", { exact: true })).toBeVisible();
    },
  },
];
const QA_PAGES_DIR = path.join(process.cwd(), "test-results", "accountant-qa", "pages");

async function expectSavedArtifact(relativePath: string, label: string) {
  const absolutePath = path.join(process.cwd(), relativePath);
  const stats = await fs.stat(absolutePath).catch(() => null);
  expect(stats?.isFile(), `${label} should exist at ${relativePath}`).toBeTruthy();
  expect(stats?.size ?? 0, `${label} should not be empty at ${relativePath}`).toBeGreaterThan(0);
}

async function expectArtifactOutput(artifact: PageArtifactResult) {
  expect(artifact.pageUrl).toBeTruthy();
  expect(artifact.pageText.trim().length, `${artifact.name} should include visible page text`).toBeGreaterThan(0);

  await Promise.all([
    expectSavedArtifact(artifact.screenshotPath, `Screenshot for ${artifact.name}`),
    expectSavedArtifact(artifact.textPath, `Visible text file for ${artifact.name}`),
    expectSavedArtifact(artifact.artifactPath, `Artifact record for ${artifact.name}`),
  ]);
}

async function captureRequiredPage(page: Page, config: RequiredPageCapture) {
  const artifact = await runStepWithArtifacts(page, {
    name: config.name,
    action: async () => {
      await page.goto(config.route, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`${escapeRegExp(config.route)}(?:\\?.*)?$`));
      await config.assertions(page);
    },
  });

  await expectArtifactOutput(artifact);
  return artifact;
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

async function authenticateSession(page: Page) {
  await openLogin(page);
  return seedAuthenticatedSession(page);
}

test.describe.serial("Accountant Bot preview QA", () => {
  test.beforeAll(async () => {
    await fs.rm(QA_PAGES_DIR, { recursive: true, force: true });
  });

  test("logs in and captures the main Financial OS pages", async ({ page }) => {
    await authenticateSession(page);

    const capturedPages = new Map<string, PageArtifactResult>();
    for (const config of REQUIRED_PAGE_CAPTURES) {
      const artifact = await captureRequiredPage(page, config);
      capturedPages.set(config.name, artifact);
    }

    expect(capturedPages.size, "At least one required page should be captured").toBeGreaterThan(0);
    expect([...capturedPages.keys()]).toEqual(REQUIRED_PAGE_CAPTURES.map((config) => config.name));

    const dashboardArtifact = capturedPages.get("dashboard");
    const activityArtifact = capturedPages.get("activity");
    expect(dashboardArtifact, "Dashboard artifact should be present").toBeDefined();
    expect(activityArtifact, "Activity artifact should be present").toBeDefined();

    const settingsSecurityArtifact = await runStepWithArtifacts(page, {
      name: "settings-account-security",
      action: async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/settings(?:\?.*)?$/);
        await expect(main(page).getByText("Account Security", { exact: true })).toBeVisible();
        await main(page).getByText("Account Security", { exact: true }).scrollIntoViewIfNeeded();
        await expect(main(page).getByPlaceholder("Current password").nth(1)).toBeVisible();
        await expect(main(page).getByPlaceholder("New password (8+ characters)")).toBeVisible();
        await expect(main(page).getByPlaceholder("Confirm new password")).toBeVisible();
        await expect(main(page).getByRole("button", { name: /change password/i })).toBeVisible();
      },
    });
    await expectArtifactOutput(settingsSecurityArtifact);

    const visibleSpend = extractMoneyForLabel(activityArtifact!.pageText, "Total spend shown");
    if (visibleSpend != null && visibleSpend > 0) {
      const weeklySpendAmounts = extractWeeklySpendAmounts(dashboardArtifact!.pageText);
      expect(
        weeklySpendAmounts.length,
        "Dashboard weekly spend section should expose at least one bucket amount when Activity total spend is positive"
      ).toBeGreaterThan(0);
      expect(
        weeklySpendAmounts.some((amount) => amount > 0),
        `Dashboard weekly spend buckets were all zero despite Activity total spend being ${visibleSpend}. Parsed weekly amounts: ${weeklySpendAmounts.join(", ")}`
      ).toBeTruthy();
    }
  });

  test("shows a specific wrong-current-password error in account security", async ({ page }) => {
    await authenticateSession(page);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);

    const passwordErrorArtifact = await runStepWithArtifacts(page, {
      name: "settings-password-error",
      action: async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/settings(?:\?.*)?$/);
        await expect(main(page).getByText("Account Security", { exact: true })).toBeVisible();

        await main(page).getByPlaceholder("Current password").nth(1).fill("TotallyWrongPassword123!");
        await main(page).getByPlaceholder("New password (8+ characters)").fill("ValidPassword123!");
        await main(page).getByPlaceholder("Confirm new password").fill("ValidPassword123!");
        await main(page).getByRole("button", { name: /change password/i }).click();

        await expect(main(page).getByText("Current password is incorrect.", { exact: true })).toBeVisible();
      },
    });
    await expectArtifactOutput(passwordErrorArtifact);

    expect(passwordErrorArtifact.pageText).toContain("Current password is incorrect.");
    expect(passwordErrorArtifact.pageText).not.toMatch(/Failed to fetch/i);
  });
});

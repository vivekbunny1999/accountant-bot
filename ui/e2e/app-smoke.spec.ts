import { expect, test, type Page } from "@playwright/test";
import { runStepWithArtifacts } from "./support/artifacts";
import { getE2ECredentials } from "./support/env";

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

async function signIn(page: Page) {
  const { email, password } = getE2ECredentials();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^log in$/i }).click();
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

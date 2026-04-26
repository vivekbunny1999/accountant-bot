import fs from "node:fs/promises";
import path from "node:path";
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";

type ConsoleErrorRecord = {
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
};

type FailedRequestRecord = {
  url: string;
  method: string;
  resourceType: string;
  reason: string;
  status?: number;
  statusText?: string;
};

type PageArtifactRecord = {
  name: string;
  slug: string;
  capturedAt: string;
  pageUrl: string;
  pageTitle: string;
  artifactPath: string;
  screenshotPath: string;
  textPath: string;
  consoleErrors: ConsoleErrorRecord[];
  failedNetworkRequests: FailedRequestRecord[];
};

export type PageArtifactResult = PageArtifactRecord & {
  pageText: string;
};

const QA_DIR = path.join(process.cwd(), "test-results", "accountant-qa");
const PAGES_DIR = path.join(QA_DIR, "pages");

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function relativeToUi(filePath: string) {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

async function assertWrittenArtifact(filePath: string, label: string) {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`${label} was not written: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
}

export async function runStepWithArtifacts(
  page: Page,
  options: {
    name: string;
    action: () => Promise<void>;
    settleMs?: number;
  }
): Promise<PageArtifactResult> {
  await fs.mkdir(PAGES_DIR, { recursive: true });

  const consoleErrors: ConsoleErrorRecord[] = [];
  const failedNetworkRequests: FailedRequestRecord[] = [];
  const seenFailures = new Set<string>();

  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    consoleErrors.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  };

  const pushFailedRequest = (record: FailedRequestRecord) => {
    const key = `${record.method}|${record.url}|${record.reason}|${record.status ?? ""}`;
    if (seenFailures.has(key)) return;
    seenFailures.add(key);
    failedNetworkRequests.push(record);
  };

  const requestFailedHandler = (request: Request) => {
    const failure = request.failure();
    pushFailedRequest({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      reason: failure?.errorText || "Request failed",
    });
  };

  const responseHandler = (response: Response) => {
    if (response.ok()) return;
    const request = response.request();
    pushFailedRequest({
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      reason: `HTTP ${response.status()} ${response.statusText()}`.trim(),
      status: response.status(),
      statusText: response.statusText(),
    });
  };

  page.on("console", onConsole as never);
  page.on("requestfailed", requestFailedHandler as never);
  page.on("response", responseHandler as never);

  let actionError: unknown;

  try {
    await options.action();
  } catch (error) {
    actionError = error;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(actionError ? 250 : options.settleMs ?? 750);

  const slug = slugify(options.name);
  const screenshotFile = path.join(PAGES_DIR, `${slug}.png`);
  const textFile = path.join(PAGES_DIR, `${slug}.txt`);
  const recordFile = path.join(PAGES_DIR, `${slug}.json`);

  let captureError: unknown;
  let result: PageArtifactResult | null = null;

  try {
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const pageTitle = await page.title().catch(() => "");

    if (!pageText.trim()) {
      throw new Error(`Visible text extraction returned empty content for ${options.name}.`);
    }

    await Promise.all([
      page.screenshot({ path: screenshotFile, fullPage: true }),
      fs.writeFile(textFile, pageText, "utf8"),
    ]);

    const record: PageArtifactRecord = {
      name: options.name,
      slug,
      capturedAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle,
      artifactPath: relativeToUi(recordFile),
      screenshotPath: relativeToUi(screenshotFile),
      textPath: relativeToUi(textFile),
      consoleErrors,
      failedNetworkRequests,
    };

    await fs.writeFile(recordFile, JSON.stringify(record, null, 2), "utf8");
    await Promise.all([
      assertWrittenArtifact(screenshotFile, `Screenshot for ${options.name}`),
      assertWrittenArtifact(textFile, `Visible text file for ${options.name}`),
      assertWrittenArtifact(recordFile, `Artifact record for ${options.name}`),
    ]);

    result = {
      ...record,
      pageText,
    };
  } catch (error) {
    captureError = error;
  } finally {
    page.off("console", onConsole as never);
    page.off("requestfailed", requestFailedHandler as never);
    page.off("response", responseHandler as never);
  }

  if (actionError) throw actionError;
  if (captureError) throw captureError;
  if (!result) throw new Error(`Failed to capture QA artifacts for ${options.name}.`);
  return result;
}

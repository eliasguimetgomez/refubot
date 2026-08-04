import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const TARGET_URL = "https://www.alberguesyrefugios.com/goriz/reservar";
const OUTPUT_DIR = path.resolve("artifacts");
const MAX_CAPTURE_CHARS = 200_000;

await mkdir(OUTPUT_DIR, { recursive: true });

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  throw new Error("No Chrome/Chromium executable was found on the runner");
}

const executablePath = await firstExistingPath([
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
]);

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

const context = await browser.newContext({
  locale: "es-ES",
  timezoneId: "Europe/Madrid",
  viewport: { width: 1440, height: 1200 }
});

const page = await context.newPage();
const consoleMessages = [];
const failedRequests = [];
const networkResponses = [];

page.on("console", (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});

page.on("pageerror", (error) => {
  consoleMessages.push({ type: "pageerror", text: error.message });
});

page.on("requestfailed", (request) => {
  failedRequests.push({
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    failure: request.failure()?.errorText ?? "unknown"
  });
});

page.on("response", async (response) => {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!["document", "fetch", "xhr"].includes(resourceType)) return;

  const contentType = response.headers()["content-type"] ?? "";
  const entry = {
    url: response.url(),
    status: response.status(),
    method: request.method(),
    resourceType,
    contentType
  };

  if (/json|text|javascript|html/i.test(contentType)) {
    try {
      const body = await response.text();
      entry.body = body.slice(0, MAX_CAPTURE_CHARS);
      entry.bodyTruncated = body.length > MAX_CAPTURE_CHARS;
    } catch (error) {
      entry.bodyError = error.message;
    }
  }

  networkResponses.push(entry);
});

async function acceptCookiesIfPresent(targetPage) {
  const labels = [
    /aceptar todas/i,
    /aceptar todo/i,
    /^aceptar$/i,
    /allow all/i,
    /accept all/i
  ];

  for (const label of labels) {
    const button = targetPage.getByRole("button", { name: label }).first();
    try {
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout: 2_000 });
        await targetPage.waitForTimeout(1_000);
        return true;
      }
    } catch {
      // Cookie controls differ across locales; continue safely.
    }
  }
  return false;
}

async function summarizeFrame(frame) {
  try {
    return await frame.evaluate(() => {
      const text = (element) => (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const attrs = (element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        name: element.getAttribute("name"),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        type: element.getAttribute("type"),
        value: element.value ?? null,
        placeholder: element.getAttribute("placeholder"),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        className: typeof element.className === "string" ? element.className : null,
        text: text(element).slice(0, 500)
      });

      return {
        url: location.href,
        title: document.title,
        bodyText: text(document.body).slice(0, 30_000),
        buttons: [...document.querySelectorAll("button,[role='button']")].map(attrs),
        inputs: [...document.querySelectorAll("input,textarea")].map(attrs),
        selects: [...document.querySelectorAll("select")].map((select) => ({
          ...attrs(select),
          options: [...select.options].map((option) => ({
            value: option.value,
            text: text(option),
            selected: option.selected,
            disabled: option.disabled
          }))
        })),
        links: [...document.querySelectorAll("a[href]")].map((link) => ({
          text: text(link).slice(0, 300),
          href: link.href,
          title: link.getAttribute("title"),
          className: typeof link.className === "string" ? link.className : null
        })),
        dateLikeElements: [...document.querySelectorAll(
          "[data-date],[data-day],[aria-label*='agosto' i],[aria-label*='august' i],.calendar,.datepicker"
        )].map(attrs)
      };
    });
  } catch (error) {
    return { url: frame.url(), error: error.message };
  }
}

try {
  const response = await page.goto(TARGET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await acceptCookiesIfPresent(page);
  await page.waitForTimeout(10_000);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "booking-page.png"),
    fullPage: true
  });

  await writeFile(
    path.join(OUTPUT_DIR, "main-page.html"),
    await page.content(),
    "utf8"
  );

  const frameSummaries = [];
  for (const [index, frame] of page.frames().entries()) {
    const summary = await summarizeFrame(frame);
    frameSummaries.push(summary);
    try {
      await writeFile(
        path.join(OUTPUT_DIR, `frame-${index}.html`),
        await frame.content(),
        "utf8"
      );
    } catch {
      // A cross-origin frame may deny snapshotting; its metadata remains recorded.
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    targetUrl: TARGET_URL,
    finalUrl: page.url(),
    documentStatus: response?.status() ?? null,
    frameCount: page.frames().length,
    frameSummaries,
    failedRequests,
    consoleMessages,
    networkResponses
  };

  await writeFile(
    path.join(OUTPUT_DIR, "diagnostic-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  const compactReport = {
    ...report,
    consoleMessages: consoleMessages.slice(0, 100),
    failedRequests: failedRequests.slice(0, 100),
    networkResponses: networkResponses
      .filter((entry) => /reserv|dispon|avail|calendar|booking|plaza|aloj|fecha|date/i.test(
        entry.url + " " + (entry.body ?? "")
      ))
      .slice(0, 50)
      .map((entry) => ({
        ...entry,
        body: entry.body?.slice(0, 30_000),
        bodyTruncated: Boolean(entry.bodyTruncated || (entry.body?.length ?? 0) > 30_000)
      }))
  };

  await writeFile(
    path.join(OUTPUT_DIR, "diagnostic-compact.json"),
    JSON.stringify(compactReport, null, 2),
    "utf8"
  );

  console.log(JSON.stringify({
    checkedAt: report.checkedAt,
    finalUrl: report.finalUrl,
    documentStatus: report.documentStatus,
    frameCount: report.frameCount,
    frames: frameSummaries.map((frame) => ({
      url: frame.url,
      title: frame.title,
      buttons: frame.buttons?.slice(0, 50),
      inputs: frame.inputs?.slice(0, 50),
      selects: frame.selects?.slice(0, 20),
      dateLikeElements: frame.dateLikeElements?.slice(0, 50),
      bodyText: frame.bodyText?.slice(0, 12_000),
      error: frame.error
    })),
    failedRequests,
    relevantResponses: compactReport.networkResponses
  }, null, 2));
} finally {
  await browser.close();
}

import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { classifyBookingState, EXPECTED_RANGE } from "./availability-logic.mjs";

const TARGET_URL = "https://www.alberguesyrefugios.com/goriz/reservar";
const CHECK_IN = { year: 2026, month: 8, day: 17 };
const CHECK_OUT = { year: 2026, month: 8, day: 18 };
const STOP_AT = new Date("2026-08-17T14:00:00.000Z"); // 16:00 in Europe/Madrid.
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");

function formatMadridTime(date = new Date()) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "medium"
  }).format(date);
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard runner path.
    }
  }
  throw new Error("Chrome or Chromium was not found");
}

async function findDateCell(page, target) {
  const cells = page.locator(".datepicker__month-day[time]");
  const index = await cells.evaluateAll((elements, wanted) => elements.findIndex((element) => {
    const timestamp = Number(element.getAttribute("time"));
    if (!Number.isFinite(timestamp)) return false;
    const date = new Date(timestamp);
    return date.getFullYear() === wanted.year
      && date.getMonth() + 1 === wanted.month
      && date.getDate() === wanted.day
      && element.getAttribute("daytype") === "visibleMonth";
  }), target);

  return index >= 0 ? cells.nth(index) : null;
}

async function checkAvailability() {
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

  try {
    const context = await browser.newContext({
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    const response = await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });

    if (!response || response.status() >= 500) {
      return { status: "unknown", reason: "temporary-page-error" };
    }

    await page.waitForSelector("#habitacion", { state: "visible" });

    const pageSignals = `${await page.title()} ${(await page.locator("body").innerText()).slice(0, 2_000)}`;
    if (/verify you are human|checking your browser|unusual traffic|captcha|access denied.+bot/i.test(pageSignals)) {
      return { status: "unknown", reason: "human-verification-block" };
    }

    const accommodation = page.locator("#habitacion");
    const optionLabels = await accommodation.locator("option").allTextContents();
    const interiorIndex = optionLabels.findIndex((label) => (
      /refugio/i.test(label)
      && /dormitorio compartido/i.test(label)
      && !/acampada/i.test(label)
    ));

    if (interiorIndex < 0) {
      return { status: "unknown", reason: "interior-accommodation-not-found" };
    }

    await accommodation.selectOption({ index: interiorIndex });
    await page.waitForSelector("#datepickerCalendar", { state: "visible" });
    await page.locator("#personas").selectOption("1");

    await page.locator("#t-check-in").click();

    const arrival = await findDateCell(page, CHECK_IN);
    if (!arrival) {
      return { status: "unknown", reason: "arrival-date-not-found" };
    }
    if (await arrival.getAttribute("aria-disabled") === "true") {
      return { status: "unavailable", reason: "arrival-date-disabled" };
    }

    await arrival.click();

    const departure = await findDateCell(page, CHECK_OUT);
    if (!departure) {
      return { status: "unknown", reason: "departure-date-not-found" };
    }
    if (await departure.getAttribute("aria-disabled") === "true") {
      return { status: "unavailable", reason: "departure-date-disabled" };
    }

    await departure.click();
    await page.waitForTimeout(1_200);

    const selectedRange = await page.locator("#checkInOutValues").inputValue();
    const bookingText = await page.locator(".fechas-reserva").innerText();
    const continueButton = page.getByRole("button", {
      name: /^(continue|continuar|continuer)$/i
    });
    const continueVisible = await continueButton.isVisible().catch(() => false);
    const continueEnabled = continueVisible
      ? await continueButton.isEnabled().catch(() => false)
      : false;

    return classifyBookingState({
      selectedRange,
      continueVisible,
      continueEnabled,
      bookingText
    });
  } finally {
    await browser.close();
  }
}

async function sendAlert(checkedAt) {
  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  const alertTo = process.env.ALERT_TO?.trim() || gmailUser;

  if (!gmailUser || !gmailPassword || !alertTo) {
    throw new Error("Email secrets are not configured");
  }

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPassword }
  });

  const madridTime = formatMadridTime(checkedAt);
  await transporter.sendMail({
    from: `RefuBot Góriz <${gmailUser}>`,
    to: alertTo,
    subject: "PLAZA DISPONIBLE EN GÓRIZ – 17 agosto",
    text: [
      "PLAZA DISPONIBLE EN GÓRIZ",
      "",
      "Noche del 17 al 18 de agosto de 2026, 1 persona, alojamiento interior.",
      `Comprobado: ${madridTime} (Europe/Madrid).`,
      `Reserva cuanto antes: ${TARGET_URL}`
    ].join("\n")
  });

  const statePath = path.resolve("state", "alert-sent.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    alertSent: true,
    checkedAt: checkedAt.toISOString(),
    dateRange: EXPECTED_RANGE,
    people: 1,
    accommodation: "interior"
  }, null, 2) + "\n", "utf8");
}

const checkedAt = new Date();

if (!DRY_RUN && checkedAt >= STOP_AT) {
  console.log("RESULT expired: target monitoring window ended");
  await setOutput("status", "expired");
  await setOutput("stop", "true");
  process.exit(0);
}

try {
  const result = await checkAvailability();
  console.log(`RESULT ${result.status}: ${result.reason}`);
  await setOutput("status", result.status);
  await setOutput("stop", "false");

  if (result.status !== "available") {
    await setOutput("emailed", "false");
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log("DRY RUN: no email sent and monitoring remains active");
    await setOutput("emailed", "false");
    process.exit(0);
  }

  await sendAlert(checkedAt);
  console.log("ALERT sent successfully; stop marker created");
  await setOutput("emailed", "true");
  await setOutput("stop", "true");
} catch (error) {
  console.error(`RESULT unknown: ${String(error.message ?? error).slice(0, 300)}`);
  await setOutput("status", "unknown");
  await setOutput("emailed", "false");
  await setOutput("stop", "false");
  process.exitCode = 1;
}

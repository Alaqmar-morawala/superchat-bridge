#!/usr/bin/env node
/**
 * Capture a SuperApp (superapp.chat) session by logging in with Playwright.
 * Produces cookies.json (storage state) for superapp.mjs.
 *
 * Usage:
 *   node capture_session.mjs                 # headless
 *   node capture_session.mjs --headed        # watch it
 *   SUPERAPP_EMAIL=... SUPERAPP_PASSWORD=... node capture_session.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = "https://superapp.chat";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "cookies.json");

const email = process.env.SUPERAPP_EMAIL;
const password = process.env.SUPERAPP_PASSWORD;
const headed = process.argv.includes("--headed");

if (!email || !password) {
  console.error("Error: SUPERAPP_EMAIL and SUPERAPP_PASSWORD environment variables are required.");
  console.error("Usage: SUPERAPP_EMAIL=you@example.com SUPERAPP_PASSWORD='...' node capture_session.mjs");
  process.exit(1);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(`${BASE}/h/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("button", { name: "Continue with Email" }).click({ timeout: 20000 });

  await page.waitForURL("**auth.superapp.chat/u/login**", { timeout: 20000 });
  await page
    .getByRole("textbox", { name: "Email address" })
    .or(page.locator("#username"))
    .first()
    .fill(email);
  await page
    .getByRole("textbox", { name: "Password" })
    .or(page.locator("#password"))
    .first()
    .fill(password);
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .or(page.locator('button[name="action"]'))
    .first()
    .click();

  await page.waitForURL(`${BASE}/h**`, { timeout: 30000 });
  await page.getByRole("textbox", { name: "Ask anything" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // let the app mint its session cookie

  await context.storageState({ path: OUT });
  const cookies = (await context.cookies())
    .filter((c) => c.domain.endsWith("superapp.chat") && !c.domain.startsWith("auth."));
  console.log(`Saved ${OUT}`);
  console.log("superapp.chat cookies:", cookies.map((c) => c.name).join(", ") || "(none!)");
  if (cookies.length === 0) process.exit(1);
} catch (e) {
  console.error("Login flow failed:", e.message.split("\n")[0]);
  console.error("Try `node capture_session.mjs --headed` to inspect.");
  process.exit(1);
} finally {
  await browser.close();
}

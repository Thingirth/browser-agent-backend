import express from "express";
import cors from "cors";
import Steel from "steel-sdk";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const steel = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

// Active sessions: sessionId -> { steelSession, browser, page }
const sessions = {};

async function getOrCreateSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const steelSession = await steel.sessions.create({
    useProxy: false,
    solveCaptchas: true,
  });

  const browser = await chromium.connectOverCDP(steelSession.websocketUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  sessions[sessionId] = { steelSession, browser, page };
  return sessions[sessionId];
}

async function releaseSession(sessionId) {
  const s = sessions[sessionId];
  if (!s) return;
  try {
    await s.browser.close();
    await steel.sessions.release(s.steelSession.id);
  } catch (e) {
    console.error("Error releasing session:", e.message);
  }
  delete sessions[sessionId];
}

app.post("/execute", async (req, res) => {
  const { sessionId, tool, input } = req.body;
  if (!sessionId || !tool || !input)
    return res.status(400).json({ error: "Missing sessionId, tool, or input" });

  try {
    const { page } = await getOrCreateSession(sessionId);
    let result = "";
    let screenshot = null;

    switch (tool) {
      case "navigate": {
        const url = input.url.startsWith("http") ? input.url : "https://" + input.url;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
        result = `Navigated to ${url}`;
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        screenshot = buf.toString("base64");
        break;
      }
      case "screenshot": {
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        screenshot = buf.toString("base64");
        result = `Screenshot taken of: ${page.url()}`;
        break;
      }
      case "click": {
        const { selector, description } = input;
        try {
          await page.click(selector, { timeout: 5000 });
        } catch {
          try {
            await page.getByText(selector, { exact: false }).first().click({ timeout: 5000 });
          } catch {
            await page.locator(`text=${selector}`).first().click({ timeout: 5000 });
          }
        }
        await page.waitForTimeout(1200);
        result = `Clicked: ${description}`;
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        screenshot = buf.toString("base64");
        break;
      }
      case "type": {
        const { selector, text, description } = input;
        try {
          await page.fill(selector, text, { timeout: 5000 });
        } catch {
          await page.locator(selector).first().fill(text);
        }
        result = `Typed "${text}" into ${description}`;
        break;
      }
      case "scroll": {
        const amount = input.direction === "down" ? input.amount : -input.amount;
        await page.evaluate((y) => window.scrollBy(0, y), amount);
        await page.waitForTimeout(500);
        result = `Scrolled ${input.direction} by ${input.amount}px`;
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        screenshot = buf.toString("base64");
        break;
      }
      case "extract": {
        const text = await page.evaluate((sel) => {
          const el = sel === "body" ? document.body : document.querySelector(sel);
          return el ? el.innerText.slice(0, 3000) : "Element not found";
        }, input.selector);
        result = text;
        break;
      }
      case "wait": {
        await page.waitForTimeout(input.seconds * 1000);
        result = `Waited ${input.seconds} seconds`;
        break;
      }
      case "task_complete": {
        result = input.summary;
        await releaseSession(sessionId);
        break;
      }
      default:
        result = `Unknown tool: ${tool}`;
    }

    res.json({ result, screenshot, url: page.url() });
  } catch (err) {
    console.error(`Tool error [${tool}]:`, err.message);
    res.json({ result: `Error executing ${tool}: ${err.message}`, screenshot: null, url: "" });
  }
});

app.post("/release", async (req, res) => {
  await releaseSession(req.body.sessionId);
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

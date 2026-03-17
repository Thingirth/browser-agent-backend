const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Active sessions
const sessions = {};

async function getOrCreateSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  sessions[sessionId] = { browser, page };
  console.log(`Created session: ${sessionId}`);
  return sessions[sessionId];
}

async function closeSession(sessionId) {
  const s = sessions[sessionId];
  if (!s) return;
  try { await s.browser.close(); } catch {}
  delete sessions[sessionId];
  console.log(`Closed session: ${sessionId}`);
}

app.post("/execute", async (req, res) => {
  const { sessionId, tool, input } = req.body;
  if (!sessionId || !tool || !input)
    return res.status(400).json({ success: false, result: "Missing parameters" });

  try {
    const { page } = await getOrCreateSession(sessionId);
    let result = "";

    if (tool === "navigate") {
      const url = input.url.startsWith("http") ? input.url : "https://" + input.url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      result = `Navigated to ${url}. Title: ${await page.title()}`;
    }

    else if (tool === "screenshot") {
      const buffer = await page.screenshot({ type: "jpeg", quality: 60 });
      result = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }

    else if (tool === "click") {
      let clicked = false;
      try {
        await page.getByText(input.selector, { exact: false }).first().click({ timeout: 4000 });
        clicked = true;
      } catch {}
      if (!clicked) {
        try {
          await page.click(input.selector, { timeout: 4000 });
          clicked = true;
        } catch {}
      }
      if (!clicked) {
        try {
          await page.getByRole("button", { name: input.selector }).first().click({ timeout: 3000 });
          clicked = true;
        } catch {}
      }
      result = clicked ? `Clicked: ${input.description}` : `Could not find: ${input.description}`;
    }

    else if (tool === "type") {
      try {
        await page.fill(input.selector, input.text, { timeout: 5000 });
        result = `Typed "${input.text}" into ${input.description}`;
      } catch {
        try {
          await page.locator(input.selector).first().fill(input.text, { timeout: 3000 });
          result = `Typed "${input.text}" into ${input.description}`;
        } catch {
          result = `Could not find input: ${input.description}`;
        }
      }
    }

    else if (tool === "scroll") {
      const amount = input.direction === "down" ? input.amount : -input.amount;
      await page.evaluate((y) => window.scrollBy(0, y), amount);
      result = `Scrolled ${input.direction} ${input.amount}px`;
    }

    else if (tool === "extract") {
      try {
        const text = await page.locator(input.selector).first().innerText({ timeout: 5000 });
        result = text.slice(0, 2000);
      } catch {
        const body = await page.evaluate(() => document.body.innerText);
        result = body.slice(0, 2000);
      }
    }

    else if (tool === "wait") {
      await page.waitForTimeout(Math.min(input.seconds * 1000, 10000));
      result = `Waited ${input.seconds}s`;
    }

    else if (tool === "task_complete") {
      await closeSession(sessionId);
      result = input.summary;
    }

    else {
      result = `Unknown tool: ${tool}`;
    }

    res.json({ success: true, result });

  } catch (err) {
    console.error(`[${tool}] Error:`, err.message);
    res.json({ success: false, result: `Error: ${err.message}` });
  }
});

app.post("/close", async (req, res) => {
  await closeSession(req.body.sessionId);
  res.json({ success: true });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

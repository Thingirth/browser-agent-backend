const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const sessions = {};

async function getOrCreateSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  sessions[sessionId] = { browser, page };
  console.log(`Session created: ${sessionId}`);
  return sessions[sessionId];
}

async function closeSession(sessionId) {
  const s = sessions[sessionId];
  if (!s) return;
  try { await s.browser.close(); } catch {}
  delete sessions[sessionId];
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
      // Try CSS selector
      try {
        await page.click(input.selector, { timeout: 4000 });
        clicked = true;
      } catch {}
      // Try XPath by text
      if (!clicked) {
        try {
          await page.evaluate((text) => {
            const els = [...document.querySelectorAll("button, a, [role='button']")];
            const el = els.find(e => e.textContent.trim().toLowerCase().includes(text.toLowerCase()));
            if (el) el.click();
            else throw new Error("not found");
          }, input.selector);
          clicked = true;
        } catch {}
      }
      result = clicked ? `Clicked: ${input.description}` : `Could not find: ${input.description}`;
    }

    else if (tool === "type") {
      try {
        await page.$eval(input.selector, el => el.value = "");
        await page.type(input.selector, input.text, { delay: 30 });
        result = `Typed "${input.text}" into ${input.description}`;
      } catch {
        result = `Could not find input: ${input.description}`;
      }
    }

    else if (tool === "scroll") {
      const amount = input.direction === "down" ? input.amount : -input.amount;
      await page.evaluate((y) => window.scrollBy(0, y), amount);
      result = `Scrolled ${input.direction} ${input.amount}px`;
    }

    else if (tool === "extract") {
      try {
        const text = await page.$eval(input.selector, el => el.innerText);
        result = text.slice(0, 2000);
      } catch {
        const body = await page.evaluate(() => document.body.innerText);
        result = body.slice(0, 2000);
      }
    }

    else if (tool === "wait") {
      await new Promise(r => setTimeout(r, Math.min(input.seconds * 1000, 10000)));
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

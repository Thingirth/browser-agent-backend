const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const sessions = {};

function getChromePath() {
  const paths = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    process.env.CHROME_PATH
  ].filter(Boolean);
  return paths[0];
}

async function getOrCreateSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Human-like user agent
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  // Extra headers to appear more human
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });

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

// Human-like random delay
function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
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
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
      await randomDelay(1000, 2000);
      result = `Navigated to ${url}. Title: ${await page.title()}`;
    }

    else if (tool === "screenshot") {
      const buffer = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
      result = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }

    else if (tool === "click") {
      let clicked = false;
      // Try CSS selector
      try {
        await page.waitForSelector(input.selector, { visible: true, timeout: 5000 });
        await randomDelay(300, 700);
        await page.click(input.selector);
        clicked = true;
      } catch {}
      // Try by text content
      if (!clicked) {
        try {
          await page.evaluate((text) => {
            const els = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button'], span, div")];
            const el = els.find(e => e.textContent.trim().toLowerCase().includes(text.toLowerCase()));
            if (el) el.click();
            else throw new Error("not found");
          }, input.selector);
          clicked = true;
        } catch {}
      }
      await randomDelay(500, 1000);
      result = clicked ? `Clicked: ${input.description}` : `Could not find: ${input.description}`;
    }

    else if (tool === "type_slow") {
      // Clear field first
      try {
        await page.waitForSelector(input.selector, { visible: true, timeout: 5000 });
        await page.click(input.selector);
        await randomDelay(300, 600);
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, input.selector);
      } catch {}

      // Type character by character with random delays (50-150ms per char)
      for (const char of input.text) {
        await page.type(input.selector, char, { delay: 50 + Math.random() * 100 });
      }
      await randomDelay(400, 800);
      result = `Typed into ${input.description}`;
    }

    else if (tool === "press_key") {
      await page.keyboard.press(input.key);
      await randomDelay(500, 1000);
      result = `Pressed key: ${input.key}`;
    }

    else if (tool === "scroll") {
      const amount = input.direction === "down" ? input.amount : -input.amount;
      await page.evaluate((y) => window.scrollBy(0, y), amount);
      await randomDelay(300, 600);
      result = `Scrolled ${input.direction} ${input.amount}px`;
    }

    else if (tool === "extract") {
      // Try specific selector first, fall back to body
      try {
        const text = await page.$eval(input.selector, el => el.innerText);
        result = text.slice(0, 5000);
      } catch {
        try {
          const text = await page.evaluate(() => document.body.innerText);
          result = text.slice(0, 5000);
        } catch {
          result = "Could not extract text";
        }
      }
    }

    else if (tool === "wait") {
      const ms = Math.min(input.seconds * 1000, 15000);
      await new Promise(r => setTimeout(r, ms));
      result = `Waited ${input.seconds}s`;
    }

    else if (tool === "task_complete") {
      result = input.summary;
      // Close session after completion
      setTimeout(() => closeSession(sessionId), 2000);
    }

    else {
      result = `Unknown tool: ${tool}`;
    }

    res.json({ success: true, result });

  } catch (err) {
    console.error(`[${tool}] Error:`, err.message);
    res.json({ success: false, result: `Error executing ${tool}: ${err.message}` });
  }
});

app.post("/close", async (req, res) => {
  await closeSession(req.body.sessionId);
  res.json({ success: true });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

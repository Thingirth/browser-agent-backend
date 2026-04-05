const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const sessions = {};

async function getOrCreateSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
    defaultViewport: null
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  // Set large viewport to satisfy eCW resolution requirement
  await page.setViewport({ width: 1920, height: 1080 });

  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
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
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
      } catch {
        // fallback if networkidle2 times out
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      await randomDelay(1500, 2500);
      result = `Navigated to ${url}. Title: ${await page.title()}`;
    }

    else if (tool === "screenshot") {
      const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
      result = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }

    else if (tool === "click") {
      let clicked = false;

      // Method 1: direct CSS selector
      try {
        await page.waitForSelector(input.selector, { visible: true, timeout: 4000 });
        const el = await page.$(input.selector);
        if (el) {
          await el.scrollIntoView();
          await randomDelay(200, 400);
          await el.click();
          clicked = true;
        }
      } catch {}

      // Method 2: evaluate click (bypasses some overlays)
      if (!clicked) {
        try {
          const didClick = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
            return false;
          }, input.selector);
          if (didClick) clicked = true;
        } catch {}
      }

      // Method 3: find by text
      if (!clicked) {
        try {
          const didClick = await page.evaluate((text) => {
            const all = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']")];
            const el = all.find(e => e.textContent.trim().toLowerCase().includes(text.toLowerCase()) || e.value?.toLowerCase().includes(text.toLowerCase()));
            if (el) { el.click(); return true; }
            return false;
          }, input.selector);
          if (didClick) clicked = true;
        } catch {}
      }

      // Method 4: keyboard Enter on focused element
      if (!clicked) {
        try {
          await page.keyboard.press("Enter");
          clicked = true;
        } catch {}
      }

      await randomDelay(600, 1200);
      result = clicked ? `Clicked: ${input.description}` : `Could not find: ${input.description}`;
    }

    else if (tool === "type_slow") {
      let typed = false;

      // Try to find and focus the field
      try {
        await page.waitForSelector(input.selector, { visible: true, timeout: 5000 });
        await page.click(input.selector);
        await randomDelay(300, 500);

        // Clear existing value
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, input.selector);

        await page.focus(input.selector);
        await randomDelay(200, 400);

        // Type character by character
        for (const char of input.text) {
          await page.type(input.selector, char, { delay: 60 + Math.random() * 80 });
        }
        typed = true;
      } catch {}

      // Fallback: set value via JS then type
      if (!typed) {
        try {
          await page.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, input.selector, input.text);
          typed = true;
        } catch {}
      }

      await randomDelay(400, 800);
      result = typed ? `Typed into ${input.description}` : `Could not find field: ${input.description}`;
    }

    else if (tool === "press_key") {
      await page.keyboard.press(input.key);
      await randomDelay(500, 1000);
      result = `Pressed: ${input.key}`;
    }

    else if (tool === "scroll") {
      const amount = input.direction === "down" ? input.amount : -input.amount;
      await page.evaluate((y) => window.scrollBy(0, y), amount);
      await randomDelay(300, 600);
      result = `Scrolled ${input.direction} ${input.amount}px`;
    }

    else if (tool === "extract") {
      try {
        const text = await page.$eval(input.selector, el => el.innerText);
        result = text.slice(0, 6000);
      } catch {
        try {
          const text = await page.evaluate(() => document.body.innerText);
          result = text.slice(0, 6000);
        } catch {
          result = "Could not extract text from page";
        }
      }
    }

    else if (tool === "wait") {
      await new Promise(r => setTimeout(r, Math.min(input.seconds * 1000, 15000)));
      result = `Waited ${input.seconds}s`;
    }

    else if (tool === "task_complete") {
      result = input.summary;
      setTimeout(() => closeSession(sessionId), 3000);
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

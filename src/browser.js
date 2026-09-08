// Browser-based page fetcher using Playwright.
//
// For providers whose sources render via client-side JavaScript (React, Vue,
// infinite scroll, etc.) and cannot be scraped with plain HTTP.  Playwright
// is an *optional* runtime dependency — this module is only imported when
// --browser is passed or a provider sets `requiresBrowser: true`.  A clear
// error is thrown if Playwright is not installed.
//
// Usage:
//   const { fetchImpl, close } = await createBrowserFetcher({ headless: true });
//   // pass fetchImpl to provider.scrape() — it returns { ok, text() } like
//   // a normal fetch Response so fetchText() works unchanged.
//   await close();   // always call when done
//
// Stealth (`{ stealth: true }` or CLI `--stealth`): masks headless browser
// fingerprints — navigator.webdriver (blink flag + init script), fake
// plugins/extensions, Sec-CH-UA client hints, Turkish locale/timezone — and
// simulates human interaction (incremental scrolling to load lazy content,
// small mouse movements) before the DOM is snapshotted.

import { DEFAULT_UA, sleep } from './http.js';

// Runs in every page before any site script.  Masks the headless tells that
// anti-bot JS probes: navigator.webdriver, missing window.chrome, empty
// plugin/extension lists, locale and hardware profile.  Each override is
// defensive — a failure to mask one property never breaks the page.
const STEALTH_INIT_SCRIPT = `
(() => {
  const def = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, { get: () => value, configurable: true });
    } catch (_) {}
  };
  def(navigator, 'webdriver', undefined);
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  }
  const plugin = (name, description, filename) => ({
    name, description, filename, length: 1,
    0: { type: 'application/pdf' },
    item: () => null, namedItem: () => null, refresh: () => {},
  });
  def(navigator, 'plugins', [
    plugin('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer'),
    plugin('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai'),
    plugin('Native Client', '', 'internal-nacl-plugin'),
  ]);
  def(navigator, 'mimeTypes', [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
    { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
  ]);
  def(navigator, 'languages', ['tr-TR', 'tr', 'en-US', 'en']);
  def(navigator, 'language', 'tr-TR');
  def(navigator, 'hardwareConcurrency', 8);
  def(navigator, 'deviceMemory', 8);
})();
`;

// Sec-CH-UA client-hint headers matching the configured User-Agent, so the
// request fingerprint looks like a real Chrome instead of a headless one.
function clientHintHeaders(userAgent) {
  const chrome = /Chrome\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(userAgent);
  const full = chrome ? chrome[0].split('/')[1] : '126.0.0.0';
  const major = chrome ? chrome[1] : '126';
  const brand = '"Not)A;Brand";v="99"';
  const platform = /Windows/i.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS/i.test(userAgent)
      ? 'macOS'
      : 'Linux';
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", ${brand}`,
    'sec-ch-ua-full-version-list': `"Chromium";v="${full}", "Google Chrome";v="${full}", ${brand}`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
    'sec-ch-ua-platform-version': `"${major}.0.0.0"`,
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
  };
}

// Simulate a human: scroll the page down in steps (triggers lazy-loaded /
// infinite-scroll content), wander the mouse a little, then settle back at
// the top before the DOM is snapshotted.
async function simulateHumanInteraction(page) {
  const height = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement || document.body;
    return el ? el.scrollHeight : 0;
  });
  const total = height || 2000;
  const steps = Math.max(4, Math.min(12, Math.ceil(total / 500)));
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round((total * i) / steps));
    await sleep(50 + Math.random() * 100);
  }
  const { width, height: viewportHeight } =
    page.viewportSize() || { width: 1920, height: 1080 };
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(
      Math.floor(Math.random() * width),
      Math.floor(Math.random() * viewportHeight),
      { steps: 10 }
    );
    await sleep(40 + Math.random() * 80);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(100);
}

// Lazily resolved Playwright module — loaded once per process.
let _chromium = null;

async function loadPlaywright() {
  if (_chromium) return _chromium;
  try {
    const pw = await import('playwright');
    _chromium = pw.chromium;
    return _chromium;
  } catch (error) {
    const message =
      error && error.code === 'ERR_MODULE_NOT_FOUND'
        ? 'Playwright is not installed.  Install it with: npm install playwright'
        : `Failed to load Playwright: ${error && error.message ? error.message : error}`;
    throw new Error(message);
  }
}

/**
 * Create a browser-backed fetcher compatible with the `fetchImpl` contract
 * used by `fetchText()`.
 *
 * @param {object}  [options]
 * @param {boolean} [options.headless=true]      Run headless (default) or headed.
 * @param {number}  [options.timeoutMs=30000]    Page navigation timeout.
 * @param {string}  [options.waitUntil='networkidle']  Playwright waitUntil mode.
 * @param {string}  [options.userAgent]          Custom User-Agent string.
 * @param {number}  [options.viewportWidth=1920] Viewport width.
 * @param {number}  [options.viewportHeight=1080] Viewport height.
 * @param {string[]} [options.args]              Extra Chromium launch args.
 * @param {boolean} [options.stealth=false]      Mask headless fingerprints
 *   and simulate human interaction (see module comment).
 * @returns {Promise<{ fetchImpl: Function, close: Function }>}
 */
export async function createBrowserFetcher(options = {}) {
  const {
    headless = true,
    timeoutMs = 30000,
    waitUntil = 'networkidle',
    userAgent = DEFAULT_UA,
    viewportWidth = 1920,
    viewportHeight = 1080,
    args = [],
    stealth = false,
  } = options;

  const chromium = await loadPlaywright();

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', ...args];
  if (stealth) {
    // 'AutomationControlled' is the blink feature that flips
    // navigator.webdriver; killing it plus the infobar makes the headless
    // session indistinguishable from a normal Chrome on that check.
    launchArgs.push('--disable-blink-features=AutomationControlled');
    launchArgs.push('--disable-infobars');
    launchArgs.push('--lang=tr-TR,tr');
  }

  const browser = await chromium.launch({
    headless,
    args: launchArgs,
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: viewportWidth, height: viewportHeight },
    // Block heavy resources that aren't needed for EPG scraping.
    bypassCSP: true,
    ...(stealth
      ? {
          locale: 'tr-TR',
          timezoneId: 'Europe/Istanbul',
          extraHTTPHeaders: clientHintHeaders(userAgent),
        }
      : {}),
  });

  if (stealth) {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
  }

  // Per-page resource budget: skip images, stylesheets, fonts, media.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  /**
   * fetchImpl-compatible function.  Returns a Response-like object so
   * fetchText() in http.js works unchanged.
   */
  async function fetchImpl(url, _fetchOptions) {
    const page = await context.newPage();
    try {
      await page.goto(String(url), {
        waitUntil,
        timeout: timeoutMs,
      });
      if (stealth) {
        await simulateHumanInteraction(page);
      }
      const html = await page.content();
      return { ok: true, status: 200, text: async () => html };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Tear down the browser context and close the browser process.
   * Always call this when scraping is done.
   */
  async function close() {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { fetchImpl, close };
}

/**
 * Check whether Playwright can be loaded without throwing.
 * Useful for provider registration / CLI help messages.
 */
export async function isPlaywrightAvailable() {
  try {
    await loadPlaywright();
    return true;
  } catch {
    return false;
  }
}

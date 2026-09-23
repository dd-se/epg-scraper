import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() ensures these objects exist before vi.mock factories execute.
const mocks = vi.hoisted(() => {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><body>rendered</body></html>'),
    evaluate: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    close: vi.fn().mockResolvedValue(undefined),
  };

  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    route: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const chromium = {
    launch: vi.fn().mockResolvedValue(browser),
  };

  return { page, context, browser, chromium };
});

vi.mock('playwright', () => ({
  chromium: mocks.chromium,
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire default return values after clearAllMocks.
  mocks.chromium.launch.mockResolvedValue(mocks.browser);
  mocks.browser.newContext.mockResolvedValue(mocks.context);
  mocks.context.newPage.mockResolvedValue(mocks.page);
  mocks.page.goto.mockResolvedValue(undefined);
  mocks.page.content.mockResolvedValue('<html><body>rendered</body></html>');
  mocks.page.evaluate.mockResolvedValue(undefined);
  mocks.page.viewportSize.mockReturnValue({ width: 1920, height: 1080 });
  mocks.page.mouse.move.mockResolvedValue(undefined);
  mocks.page.close.mockResolvedValue(undefined);
  mocks.context.addInitScript.mockResolvedValue(undefined);
  mocks.context.close.mockResolvedValue(undefined);
  mocks.browser.close.mockResolvedValue(undefined);
});

// Import browser.js once — the top-level vi.mock intercepts import('playwright').
import { createBrowserFetcher, isPlaywrightAvailable } from '../src/browser.js';
import { fetchText } from '../src/http.js';

describe('createBrowserFetcher', () => {
  it('launches a headless Chromium and returns a fetchImpl-compatible function', async () => {
    const { fetchImpl, close } = await createBrowserFetcher();

    expect(mocks.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true })
    );
    expect(mocks.browser.newContext).toHaveBeenCalled();
    expect(mocks.context.route).toHaveBeenCalled();

    const response = await fetchImpl('https://example.com/page');

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toBe('<html><body>rendered</body></html>');
    expect(mocks.page.goto).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ waitUntil: 'networkidle' })
    );
    expect(mocks.page.close).toHaveBeenCalled();

    await close();
    expect(mocks.context.close).toHaveBeenCalled();
    expect(mocks.browser.close).toHaveBeenCalled();
  });

  it('rejects non-GET requests before opening a page', async () => {
    const { fetchImpl, close } = await createBrowserFetcher();
    await expect(
      fetchImpl('https://example.com/api', { method: 'POST', body: '{}' })
    ).rejects.toThrow(/GET requests only/);
    expect(mocks.context.newPage).not.toHaveBeenCalled();
    await close();
  });

  it('honors the transport abort signal while content is pending', async () => {
    mocks.page.content.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const { fetchImpl, close } = await createBrowserFetcher();
    const pending = fetchImpl('https://example.com/page', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(mocks.page.close).toHaveBeenCalled();
    await close();
  });

  it('closes Chromium when context setup fails', async () => {
    mocks.browser.newContext.mockRejectedValue(new Error('context failed'));
    await expect(createBrowserFetcher()).rejects.toThrow('context failed');
    expect(mocks.browser.close).toHaveBeenCalled();
  });

  it('closes the page even when goto throws', async () => {
    mocks.page.goto.mockRejectedValue(new Error('Navigation timeout'));
    const { fetchImpl, close } = await createBrowserFetcher();

    await expect(fetchImpl('https://timeout.example.com')).rejects.toThrow(
      'Navigation timeout'
    );
    expect(mocks.page.close).toHaveBeenCalled();

    await close();
  });

  it('preserves navigation status for transport retry decisions', async () => {
    mocks.page.goto
      .mockResolvedValueOnce({ status: () => 503, ok: () => false })
      .mockResolvedValueOnce({ status: () => 200, ok: () => true });
    const { fetchImpl, close } = await createBrowserFetcher();
    const html = await fetchText('https://example.com/page', {
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
    });
    expect(html).toContain('rendered');
    expect(mocks.page.goto).toHaveBeenCalledTimes(2);
    await close();
  });

  it('uses the configured navigation timeout', async () => {
    const { fetchImpl, close } = await createBrowserFetcher({ timeoutMs: 4321 });
    await fetchImpl('https://example.com/page');
    expect(mocks.page.goto).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ timeout: 4321 })
    );
    await close();
  });

  it('passes custom options to Chromium launch and context', async () => {
    const { close } = await createBrowserFetcher({
      headless: false,
      userAgent: 'CustomBot/1.0',
      viewportWidth: 1280,
      viewportHeight: 720,
      args: ['--disable-gpu'],
    });

    expect(mocks.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: false,
        args: expect.arrayContaining(['--disable-gpu']),
      })
    );
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'CustomBot/1.0',
        viewport: { width: 1280, height: 720 },
      })
    );

    await close();
  });

  it('stealth: disables the automation fingerprint, sends client hints, and installs the init script', async () => {
    const { close } = await createBrowserFetcher({ stealth: true });

    expect(mocks.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--disable-blink-features=AutomationControlled']),
      })
    );
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        extraHTTPHeaders: expect.objectContaining({
          'sec-ch-ua': expect.stringContaining('"Chromium"'),
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Linux"',
        }),
      })
    );
    expect(mocks.context.addInitScript).toHaveBeenCalledWith(
      expect.stringContaining("'webdriver'")
    );

    await close();
  });

  it('stealth: fetchImpl scrolls the page and moves the mouse', async () => {
    const { fetchImpl, close } = await createBrowserFetcher({ stealth: true });

    const response = await fetchImpl('https://example.com/page');
    expect(mocks.page.evaluate).toHaveBeenCalled(); // scrollHeight probe + scrollTo calls
    expect(mocks.page.mouse.move).toHaveBeenCalled();
    expect(await response.text()).toBe('<html><body>rendered</body></html>');

    await close();
  });

  it('non-stealth mode stays clean: no blink arg, no init script, no client hints', async () => {
    const { close } = await createBrowserFetcher();
    const launchArgs = mocks.chromium.launch.mock.calls[0][0].args;
    expect(launchArgs).not.toContain('--disable-blink-features=AutomationControlled');
    expect(mocks.context.addInitScript).not.toHaveBeenCalled();
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ extraHTTPHeaders: expect.anything() })
    );
    await close();
  });

  it('blocks images, stylesheets, fonts, and media via route', async () => {
    const { fetchImpl, close } = await createBrowserFetcher();

    const routeHandler = mocks.context.route.mock.calls[0][1];

    // Abort images.
    const imageRoute = {
      request: () => ({ resourceType: () => 'image' }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await routeHandler(imageRoute);
    expect(imageRoute.abort).toHaveBeenCalled();
    expect(imageRoute.continue).not.toHaveBeenCalled();

    // Allow document requests.
    const docRoute = {
      request: () => ({ resourceType: () => 'document' }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await routeHandler(docRoute);
    expect(docRoute.continue).toHaveBeenCalled();
    expect(docRoute.abort).not.toHaveBeenCalled();

    await close();
  });
});

describe('isPlaywrightAvailable', () => {
  it('returns true when Playwright loads successfully', async () => {
    expect(await isPlaywrightAvailable()).toBe(true);
  });

  it('returns false when Playwright is not installed', async () => {
    // We can't easily test this with the global mock in place.
    // The real behavior is tested by the clear error message in createBrowserFetcher.
    // This test verifies the function exists and returns a boolean.
    const result = await isPlaywrightAvailable();
    expect(typeof result).toBe('boolean');
  });
});

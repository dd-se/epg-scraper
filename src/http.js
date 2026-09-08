// Thin fetch wrapper: browser-like headers, hard timeout, bounded retries.
// No caching, no analytics, no hidden calls — only URLs the provider config
// asks for.

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchText(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 400,
    userAgent = DEFAULT_UA,
    headers = {},
    fetchImpl,
  } = options;
  // Resolve fetchImpl at call time — falling back to globalThis.fetch so
  // tests can override it with globalThis.fetch = stub.
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5',
          ...headers,
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

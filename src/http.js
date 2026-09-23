// Thin fetch wrapper: browser-like headers, hard timeout, bounded retries.
// No caching, no analytics, no hidden calls — only URLs the provider config
// asks for.

export const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPoliteFetch(fetchImpl, delayMs = 0) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return doFetch;
  let nextAllowedAt = 0;
  return async (...args) => {
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextAllowedAt = Date.now() + delayMs;
    return doFetch(...args);
  };
}

async function attemptOnce(doFetch, url, init, timeoutMs, finalize, nonRetryableStatuses) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });
    if (!response || !response.ok) {
      const status = response && response.status;
      const error = new Error(`HTTP ${status == null ? 'undefined' : status} for ${url}`);
      const configuredNonRetryable = nonRetryableStatuses?.includes(status) === true;
      const transient = status === 429 || (status >= 500 && status < 600);
      const sessionPost403 = status === 403 && !configuredNonRetryable;
      error.status = status;
      error.nonRetryable = configuredNonRetryable || (!transient && !sessionPost403);
      throw error;
    }
    return await finalize(response);
  } finally {
    clearTimeout(timer);
  }
}

// Core retry loop shared by every transport (fetchText, and the providers'
// POST helpers).  Retries transport errors (network, timeout, aborted body
// reads) AND non-2xx responses (5xx/429 are transient too) with linear
// backoff.  `finalize` runs inside the loop — a failure there (e.g. a
// truncated body) is retried like any other attempt.  After `retries + 1`
// attempts the last error is rethrown, annotated with the request for
// context (non-2xx errors already carry it).
//
// `nonRetryableStatuses` opts a transport out for deterministic failures:
// a 404/410 page or a WAF 403 will answer the same way on every attempt,
// so retrying only delays the per-page degradation. Session POST transports
// opt into 403 retries; TV+ rebuilds its session after exhaustion, while
// Tivibu records the failed channel-day.
async function requestWithRetry(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 400,
    fetchImpl,
    buildInit = () => ({}),
    finalize = (response) => response.text(),
    describe = () => url,
    nonRetryableStatuses,
  } = options;
  // Resolve fetchImpl at call time — falling back to globalThis.fetch so
  // tests can override it with globalThis.fetch = stub.
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptOnce(
        doFetch,
        url,
        buildInit(),
        timeoutMs,
        finalize,
        nonRetryableStatuses
      );
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable || attempt >= retries) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  if (lastError instanceof Error && lastError.message.startsWith('HTTP ')) {
    throw lastError; // "HTTP 503 for <url>" — already self-describing.
  }
  const cause = lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(`${cause} (${describe()})`);
}

// GET a page and return its text.  Used by the HTML providers (hurriyet,
// mynet, beinsports, sporekrani) and the tivibu session GET.
// 404/410 (page gone) and 403 (WAF-blocked datacenter IPs — digiturk.com.tr
// answers 403 on every path) are deterministic: fail on the first attempt.
const GET_NON_RETRYABLE = [403, 404, 410];

export async function fetchText(url, options = {}) {
  const { userAgent = DEFAULT_UA, headers = {}, fetchImpl, ...retryOptions } = options;
  return await requestWithRetry(url, {
    ...retryOptions,
    fetchImpl,
    nonRetryableStatuses: GET_NON_RETRYABLE,
    describe: () => `GET ${url}`,
    buildInit: () => ({
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5',
        ...headers,
      },
      redirect: 'follow',
    }),
  });
}

async function bufferResponse(response) {
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
  };
}

// POST (or any method) a payload and return a buffered Response-like object.
// Headers and body are captured within the same timeout/retry attempt, while
// preserving the .headers and .text() interface used by session providers.
export async function fetchResponseWithRetry(url, options = {}) {
  const {
    userAgent = DEFAULT_UA,
    headers = {},
    fetchImpl,
    method = 'POST',
    body,
    retry403 = false,
    ...retryOptions
  } = options;
  return await requestWithRetry(url, {
    retries: 1,
    ...retryOptions,
    fetchImpl,
    nonRetryableStatuses:
      method === 'GET' || !retry403 ? [403, 404, 410] : [404, 410],
    finalize: bufferResponse,
    describe: () => `${method} ${url}`,
    buildInit: () => ({
      method,
      ...(body !== undefined ? { body } : {}),
      headers: {
        'user-agent': userAgent,
        ...headers,
      },
      redirect: 'follow',
    }),
  });
}

// Thin fetch wrapper: browser-like headers, hard timeout, bounded retries.
// No caching, no analytics, no hidden calls — only URLs the provider config
// asks for.

export const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One abortable attempt. Resolves with the Response (status NOT checked —
// the caller decides what counts as success), or throws on transport failure.
async function attemptOnce(doFetch, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
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
async function requestWithRetry(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 400,
    fetchImpl,
    buildInit = () => ({}),
    finalize = (response) => response.text(),
    describe = () => url,
  } = options;
  // Resolve fetchImpl at call time — falling back to globalThis.fetch so
  // tests can override it with globalThis.fetch = stub.
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await attemptOnce(doFetch, url, buildInit(), timeoutMs);
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response && response.status} for ${url}`);
      }
      return await finalize(response);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
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
export async function fetchText(url, options = {}) {
  const { userAgent = DEFAULT_UA, headers = {}, fetchImpl, ...retryOptions } = options;
  return await requestWithRetry(url, {
    ...retryOptions,
    fetchImpl,
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

// POST (or any method) a payload and return the Response (NOT consumed —
// some callers need Set-Cookie headers off it before reading the body; they
// must call .text()).  Give the transport-level failsafes (timeout,
// retries, backoff) to the JSON/form providers that the GET providers
// already had.
export async function fetchResponseWithRetry(url, options = {}) {
  const {
    userAgent = DEFAULT_UA,
    headers = {},
    fetchImpl,
    method = 'POST',
    body,
    ...retryOptions
  } = options;
  return await requestWithRetry(url, {
    retries: 1,
    ...retryOptions,
    fetchImpl,
    finalize: (response) => response,
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

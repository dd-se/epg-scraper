// Optional liveness probing for playlist streams.
//
// This is a deliberately *fast* check, not a health monitor: by default it
// fetches each stream's manifest once (`depth: 1`) and keeps the entry only if
// the response is 2xx **and** the body's first bytes carry `#EXTM3U`.
//
// The body check is the valuable half.  A status-only probe would happily ship
// a `200` that serves an HTML block or login page — precisely the failure mode
// worth catching before a merged playlist reaches a player.
//
// What a failure does NOT mean, stated honestly: a `403` here is not a header
// problem.  Measured on the reference sources, the same URL returned 403 under a
// plain UA, a full browser UA, a browser UA plus `Referer`, and a VLC UA.  Those
// links are blocked by the operator's CDN or by region and may well play on the
// operator's own machine.  Probing therefore runs from wherever the tool runs:
// run it at home, not on a CI runner, or you will over-drop.  This is why
// probing is opt-in and why every dropped entry is reported.

import { DEFAULT_UA } from '../http.js';

// Only the head of the body is inspected; a manifest is small and reading a
// multi-megabyte body just to find `#EXTM3U` would be wasteful.
const PROBE_BODY_BYTES = 400;

// Deterministic failures: retrying them only wastes the operator's time.
const DETERMINISTIC_STATUS = new Set([404, 410]);
const DETERMINISTIC_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Map a transport error to `{ retryable, reason }`. */
export function classifyProbeFailure(error) {
  const code = (error && (error.code || (error.cause && error.cause.code))) || '';
  const message = String((error && error.message) || '');
  if (DETERMINISTIC_CODES.has(code)) return { retryable: false, reason: code.toLowerCase() };
  if (/certificate|self.signed|SSL|TLS/i.test(message)) return { retryable: false, reason: 'tls-error' };
  if (code === 'ETIMEDOUT' || /abort|timed? ?out/i.test(message)) return { retryable: true, reason: 'timeout' };
  if (code === 'ECONNRESET' || /socket hang up|reset/i.test(message)) {
    return { retryable: true, reason: 'connection-reset' };
  }
  return { retryable: false, reason: code ? code.toLowerCase() : 'network-error' };
}

async function probeOnce(url, options) {
  const { fetchImpl, timeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
    const response = await doFetch(url, {
      headers: { 'user-agent': DEFAULT_UA },
      redirect: 'follow',
      signal: controller.signal,
    });
    const status = response && response.status;
    if (!response || !response.ok) {
      if (status === 403) return { ok: false, status, reason: 'forbidden', retryable: false };
      if (DETERMINISTIC_STATUS.has(status)) return { ok: false, status, reason: `http-${status}`, retryable: false };
      if (status === 429 || (status >= 500 && status < 600)) {
        return { ok: false, status, reason: `http-${status}`, retryable: true };
      }
      return { ok: false, status, reason: `http-${status}`, retryable: false };
    }
    const body = await response.text();
    const head = body.slice(0, PROBE_BODY_BYTES);
    if (!head.includes('#EXTM3U')) {
      // A 2xx that is not a manifest: an HTML block page, a login wall, or a
      // soft error. Deterministic — never retried.
      return { ok: false, status, reason: 'not-a-manifest', retryable: false };
    }
    return { ok: true, status, head, manifest: body };
  } catch (error) {
    const { retryable, reason } = classifyProbeFailure(error);
    return { ok: false, status: (error && error.status) || 0, reason, retryable };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(url, options) {
  const { retries = 1, delayMs = 250 } = options;
  let attempt = await probeOnce(url, options);
  let tries = 0;
  while (!attempt.ok && attempt.retryable && tries < retries) {
    tries += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs * tries));
    attempt = await probeOnce(url, options);
  }
  return { ...attempt, tries: tries + 1 };
}

/**
 * Probe every entry's stream URL with bounded concurrency.
 *
 * @param {object[]} entries
 * @param {object} [options]
 * @param {number} [options.concurrency=4] parallel probes (max 8)
 * @param {number} [options.timeoutMs=6000] per-probe hard abort
 * @param {number} [options.depth=1] 1 = manifest only, 2 = also first segment
 * @param {number} [options.retries=1] retries for a *retryable* failure
 * @returns {Promise<{ kept: object[], dead: object[], probed: number }>}
 */
export async function probeEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));
  const depth = Number(options.depth) === 2 ? 2 : 1;
  const probeOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: Number(options.timeoutMs) || 6000,
    retries: Number(options.retries) || 0,
    delayMs: options.retryDelayMs || 250,
  };

  const kept = [];
  const dead = [];
  let cursor = 0;

  // A fixed worker pool: concurrency is never exceeded, and a `fetchImpl` that
  // throws for every URL still returns every entry rather than crashing.
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      const entry = list[index];
      const result = await probeOne(entry.url, probeOptions);

      if (!result.ok) {
        dead.push({ name: entry.name, url: entry.url, reason: result.reason, status: result.status });
      } else if (depth === 2) {
        const verdict = await followFirstSegment(result, entry, probeOptions);
        if (verdict.status === 'dead') {
          dead.push({
            name: entry.name,
            url: entry.url,
            reason: verdict.reason,
            status: verdict.httpStatus,
          });
        } else {
          // 'ok' — or 'skipped' for a master playlist, which lists variant
          // playlists rather than segments. Never following it keeps the check
          // from manufacturing a false negative.
          kept.push(entry);
        }
      } else {
        kept.push(entry);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));
  // Preserve input order so a run is deterministic.
  const order = new Map(list.map((entry, index) => [entry, index]));
  kept.sort((a, b) => order.get(a) - order.get(b));
  dead.sort((a, b) => order.get(a) - order.get(b));
  return { kept, dead, probed: list.length };
}

async function followFirstSegment(probeResult, entry, probeOptions) {
  const manifest = String(probeResult.manifest || probeResult.head || '');
  // A master playlist's payload is itself a playlist, so following it would
  // test the wrong thing.
  if (/#EXT-X-STREAM-INF|#EXT-X-I-FRAME-STREAM-INF/i.test(manifest)) return { status: 'skipped' };

  const first = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (!first) return { status: 'ok' };

  let resolved;
  try {
    resolved = new URL(first, entry.url).toString();
  } catch {
    return { status: 'ok' };
  }
  const segment = await probeOnce(resolved, probeOptions);
  if (segment.ok) return { status: 'ok' };
  // NOTE: `verdict` carries `httpStatus`, not a second `status` key — a
  // duplicate `status` would silently overwrite the 'dead'/'ok'/'skipped'
  // sentinel the caller branches on, and every dead segment would be kept.
  return { status: 'dead', reason: segment.reason, httpStatus: segment.status };
}
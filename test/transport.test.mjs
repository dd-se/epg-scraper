// Tests for the hardened transport layer: bounded retries with backoff for
// GET and POST transports, timeout aborts, and the tvplus session
// re-establishment failsafe.  All network behavior is stubbed — no live
// requests (see AGENTS.md).
import { describe, it, expect, vi } from 'vitest';
import { fetchText, fetchResponseWithRetry } from '../src/http.js';
import { scrape as scrapeTvplus, CHANNELS as TVPLUS_CHANNELS } from '../src/providers/tvplus.js';
import { scrape as scrapeDigiturkburada } from '../src/providers/digiturkburada.js';
import { scrape as scrapeTivibu } from '../src/providers/tivibu.js';

const htmlResponse = (html) => ({ ok: true, status: 200, text: async () => html });

describe('fetchResponseWithRetry (POST transport)', () => {
  it('retries POSTs that throw until one succeeds', async () => {
    let calls = 0;
    const response = await fetchResponseWithRetry('https://x/api', {
      fetchImpl: async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNRESET');
        return { ok: true, status: 200, text: async () => 'ok' };
      },
      retries: 2,
      retryDelayMs: 0,
      method: 'POST',
      body: '{}',
    });
    expect(calls).toBe(2);
    expect(await response.text()).toBe('ok');
  });

  it('retries transient 5xx responses on POST', async () => {
    let calls = 0;
    const response = await fetchResponseWithRetry('https://x/api', {
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return { ok: false, status: 503, text: async () => '' };
        return { ok: true, status: 200, text: async () => 'ok' };
      },
      retries: 1,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(response.ok).toBe(true);
  });

  it('does not consume the body — the caller reads .text() (Set-Cookie pattern)', async () => {
    let textReads = 0;
    const response = await fetchResponseWithRetry('https://x/auth', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => (n === 'set-cookie' ? 'SID=1' : undefined) },
        text: async () => {
          textReads++;
          return '{}';
        },
      }),
      retries: 0,
    });
    expect(response.headers.get('set-cookie')).toBe('SID=1');
    expect(textReads).toBe(0); // untouched until the caller reads it
  });

  it('propagates the status error after exhausting retries', async () => {
    let calls = 0;
    await expect(
      fetchResponseWithRetry('https://x/api', {
        fetchImpl: async () => {
          calls++;
          return { ok: false, status: 500, text: async () => '' };
        },
        retries: 1,
        retryDelayMs: 0,
      })
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(2); // retries: 1 -> two attempts
  });

  it('defaults to 1 retry, not the 2 the GET wrapper uses', async () => {
    let calls = 0;
    await expect(
      fetchResponseWithRetry('https://x/api', {
        fetchImpl: async () => {
          calls++;
          throw new Error('down');
        },
        retryDelayMs: 0,
      })
    ).rejects.toThrow(/down/);
    expect(calls).toBe(2); // 1 initial + 1 retry
  });
});

describe('fetchText retries (regression coverage)', () => {
  it('recovers when the first attempt times out and the second succeeds', async () => {
    let calls = 0;
    const html = await fetchText('https://x/page', {
      fetchImpl: (url, opts) =>
        new Promise((resolve, reject) => {
          if (calls++ === 0) {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
          } else {
            resolve(htmlResponse('<html>ok</html>'));
          }
        }),
      retries: 1,
      retryDelayMs: 0,
      timeoutMs: 30,
    });
    expect(html).toContain('ok');
    expect(calls).toBe(2);
  });

  it('annotates transport errors with the request description', async () => {
    await expect(
      fetchText('https://x/page', {
        fetchImpl: async () => {
          throw new Error('EAI_AGAIN');
        },
        retries: 0,
      })
    ).rejects.toThrow(/EAI_AGAIN \(GET https:\/\/x\/page\)/);
  });
});

describe('tvplus session re-establishment failsafe', () => {
  const platformInfo = JSON.stringify({ https: 'https://api.tvplus.com.tr:33207' });
  const playbill = JSON.stringify({
    playbilllist: [
      {
        name: 'Match',
        starttime: '2026-09-09 10:00:00 UTC+03:00',
        endtime: '2026-09-09 11:00:00 UTC+03:00',
      },
    ],
  });

  it('re-authenticates once when a PlayBillList call fails mid-run and recovers', async () => {
    let playbillCalls = 0;
    let authCalls = 0;
    let discoveryCalls = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) {
        discoveryCalls++;
        return htmlResponse(platformInfo);
      }
      if (url.endsWith('/EPG/JSON/Authenticate')) {
        authCalls++;
        return {
          ok: true,
          status: 200,
          headers: { getSetCookie: () => ['XSESSIONID=NEW; Path=/'] },
          text: async () => '{}',
        };
      }
      if (url.endsWith('/EPG/JSON/PlayBillList')) {
        playbillCalls++;
        // The session died: the first channel-day fails both transport
        // attempts (initial + transport retry), which triggers one session
        // re-establishment; after that PlayBillList succeeds.
        if (playbillCalls <= 2) return { ok: false, status: 403, text: async () => '' };
        return htmlResponse(playbill);
      }
      throw new Error(`unexpected url ${url}`);
    };

    const logs = [];
    const result = await scrapeTvplus({
      dates: ['2026-09-09'],
      fetchImpl,
      log: (l) => logs.push(l),
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    expect(discoveryCalls).toBe(2); // initial + one mid-run re-establishment
    expect(authCalls).toBe(2);
    expect(playbillCalls).toBe(3); // 2 failed attempts + 1 after re-auth
    expect(result.failures).toBe(0);
    expect(result.programmes.map((p) => p.title)).toEqual(['Match']);
    expect(logs.some((l) => l.includes('re-authenticating'))).toBe(true);
  });

  it('counts a channel-day as failed when re-authentication cannot save it', async () => {
    let playbillCalls = 0;
    let discoveryCalls = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) {
        discoveryCalls++;
        return htmlResponse(platformInfo);
      }
      if (url.endsWith('/EPG/JSON/Authenticate')) {
        return {
          ok: true,
          status: 200,
          headers: { getSetCookie: () => ['XSESSIONID=X; Path=/'] },
          text: async () => '{}',
        };
      }
      if (url.endsWith('/EPG/JSON/PlayBillList')) {
        playbillCalls++;
        return { ok: false, status: 403, text: async () => '' };
      }
      // (Every attempt fails; the run ends with 2 playbill calls + re-auth.)
      throw new Error(`unexpected url ${url}`);
    };

    const result = await scrapeTvplus({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    // 2 transport attempts + re-auth, then 2 more attempts, then skipped.
    expect(playbillCalls).toBe(4);
    expect(discoveryCalls).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.programmes).toEqual([]);
  });

  it('retries PlayBillList transport failures before triggering re-auth', async () => {
    let playbillCalls = 0;
    let discoveryCalls = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) {
        discoveryCalls++;
        return htmlResponse(platformInfo);
      }
      if (url.endsWith('/EPG/JSON/Authenticate')) {
        return {
          ok: true,
          status: 200,
          headers: { getSetCookie: () => ['XSESSIONID=X; Path=/'] },
          text: async () => '{}',
        };
      }
      if (url.endsWith('/EPG/JSON/PlayBillList')) {
        playbillCalls++;
        // Attempt 1 throws, attempt 2 (transport retry) succeeds — no
        // session re-establishment needed.
        if (playbillCalls === 1) throw new Error('ECONNRESET');
        return htmlResponse(playbill);
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await scrapeTvplus({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    expect(discoveryCalls).toBe(1); // no mid-run re-auth
    expect(playbillCalls).toBe(2);
    expect(result.failures).toBe(0);
    expect(result.programmes).toHaveLength(1);
  });
});

describe('digiturkburada retry transport', () => {
  it('retries a failing form POST and recovers', async () => {
    const page =
      '<h2>8 Eylül 2026 - Salı</h2><table>' +
      '<tr><td style="padding:2px"><strong>A</strong></td><td style="padding:2px"><strong>10:00</strong></td></tr>' +
      '</table>';
    let calls = 0;
    const result = await scrapeDigiturkburada({
      dates: ['2026-09-08'],
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return { ok: false, status: 502, text: async () => '' };
        return htmlResponse(page);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(calls).toBe(2);
    expect(result.programmes.map((p) => p.title)).toEqual(['A']);
    expect(result.failures).toBe(0);
  });
});

describe('tivibu retry transport', () => {
  const channelPage =
    '<input class="token" value="tok"><a href="/rv?i=2|ch00000000000000001356">x</a>';
  const prevueJson = JSON.stringify({
    mobilPrevueViewModel: [
      { prevueName: 'Match', beginTime: '2026.09.09 10:00:00', endTime: '2026.09.09 11:00:00' },
    ],
  });

  it('retries a failing session GET and a failing prevue POST', async () => {
    let gets = 0;
    let posts = 0;
    const result = await scrapeTivibu({
      dates: ['2026-09-09'],
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') {
          posts++;
          if (posts === 1) return { ok: false, status: 503, text: async () => '' };
          return htmlResponse(prevueJson);
        }
        gets++;
        if (gets === 1) throw new Error('ECONNRESET');
        return htmlResponse(channelPage);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(gets).toBe(2);
    expect(posts).toBe(2);
    expect(result.programmes.map((p) => p.title)).toEqual(['Match']);
    expect(result.failures).toBe(0);
  });
});

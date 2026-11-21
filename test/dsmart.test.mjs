import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import {
  buildChannelItemUrl,
  buildEventsUrl,
  buildSiteConfigUrl,
  CATALOG_CHANNELS,
  CMS_BASE_URL,
  CHANNELS,
  parseApiPayload,
  parseChannelLogo,
  parseCmsItem,
  parseDayEvents,
  parseSiteConfig,
  PUBLIC_API_KEY,
  PUBLIC_CMS_API_KEY,
  scrape,
  SITE_CONFIG_TOKEN,
} from '../src/providers/dsmart.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/dsmart/${name}`, import.meta.url)), 'utf8');
const smartDay = fixture('spor-smart.json');
const smart2Day = fixture('spor-smart-2.json');
const item1 = fixture('item-246003.json');
const item2 = fixture('item-246171.json');
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => body,
});

const siteConfigBody = JSON.stringify({
  data: {
    site_config: {
      servicesConfig: {
        contentConfig: {
          epg: {
            apiKey: 'live-key',
            serviceBaseUrl: 'https://global-epg-prod.erstream.com',
          },
          cms: {
            apiKey: 'live-cms-key',
            serviceBaseUrl: 'https://live-cms.example.com',
          },
        },
      },
    },
  },
});
const isSiteConfig = (url) => String(url).includes('/client/site-config');
const isCmsItem = (url) => String(url).includes('/v1/item/');
const isEvent = (url) => String(url).includes('/Epg/GetChannelEpgWithRange');
const stubByChannel = (url) => {
  if (isSiteConfig(url)) return response(siteConfigBody);
  if (isCmsItem(url)) return response(String(url).includes('246171') ? item2 : item1);
  return String(url).includes('cmsId=246171') ? response(smart2Day) : response(smartDay);
};

describe('dsmart EPG contract', () => {
  it('builds the day-scoped authenticated URL with an exclusive end date', () => {
    const url = new URL(buildEventsUrl('246003', '2026-11-21', { key: 'test-key' }));
    expect(url.origin).toBe('https://global-epg-prod.erstream.com');
    expect(url.pathname).toBe('/Epg/GetChannelEpgWithRange');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      includeEnding: 'true',
      fillResponse: 'true',
      key: 'test-key',
      cmsId: '246003',
      startDate: '2026-11-21',
      endDate: '2026-11-22',
      timezone: '03',
      lang: 'tr',
    });
    // The exclusive end rolls over month/year boundaries.
    const rolled = new URL(buildEventsUrl('246003', '2026-12-31'));
    expect(rolled.searchParams.get('endDate')).toBe('2027-01-01');
  });

  it('lets the environment override the public key without logging it', () => {
    const url = new URL(buildEventsUrl('246003', '2026-11-21', { env: { DSMART_EPG_KEY: 'env-key' } }));
    expect(url.searchParams.get('key')).toBe('env-key');
  });

  it('builds and parses the site-config bootstrap response', () => {
    const url = new URL(buildSiteConfigUrl('1.0.6', 'web-desktop', 1234));
    expect(url.origin).toBe('https://bfogwjgq8dbp.merlincdn.net');
    expect(url.pathname).toBe('/client/site-config');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      version: '1.0.6',
      platform: 'web-desktop',
      timestamp: '1234',
    });
    expect(parseSiteConfig(siteConfigBody)).toEqual({
      key: 'live-key',
      cmsApiKey: 'live-cms-key',
      cmsBaseUrl: 'https://live-cms.example.com',
    });
    // A config without the CMS block still yields a usable EPG key.
    expect(parseSiteConfig(JSON.stringify({ data: { site_config: { servicesConfig: { contentConfig: { epg: { apiKey: 'key-only' } } } } } }))).toEqual({
      key: 'key-only',
      cmsApiKey: undefined,
      cmsBaseUrl: undefined,
    });
    expect(parseSiteConfig('not json')).toBeUndefined();
    expect(parseSiteConfig('{"data":{}}')).toBeUndefined();
  });

  it('builds CMS item URLs and picks the Logo image over a Thumbnail', () => {
    const url = new URL(buildChannelItemUrl('246003', { baseUrl: 'https://cms.example.com/' }));
    expect(url.origin).toBe('https://cms.example.com');
    expect(url.pathname).toBe('/v1/item/246003');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'mcdn-langauge-code': 'tr',
      platform: 'web',
    });
    expect(parseChannelLogo(parseCmsItem(item1))).toBe(
      'https://zdi2vdd5r0wt.merlincdn.net/content/7/lm/246003/logo.png?v=638671714024212390'
    );
    expect(parseChannelLogo({ images: [{ type: 'Thumbnail', url: 'https://x/t.png' }] })).toBeUndefined();
    expect(parseChannelLogo({ images: [{ type: 'Logo', url: 'not-a-url' }] })).toBeUndefined();
    expect(parseCmsItem('[]')).toBeUndefined();
  });

  it('documents the full catalog but curates only the two sports feeds', () => {
    expect(CATALOG_CHANNELS.length).toBe(75);
    expect(CATALOG_CHANNELS.map((c) => c.cmsId)).toContain('246003');
    expect(CATALOG_CHANNELS.map((c) => c.cmsId)).toContain('246171');
    expect(CATALOG_CHANNELS.some((c) => c.slug === 'tay-tv')).toBe(true);
    expect(CHANNELS).toEqual([
      { name: 'Spor Smart', cmsId: '246003', id: 'SPORSMART.tr' },
      { name: 'Spor Smart 2', cmsId: '246171', id: 'SPORSMART2.tr' },
    ]);
  });

  it('never hardcodes a logo URL in the provider source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/providers/dsmart.js', import.meta.url)),
      'utf8'
    );
    expect(source).not.toMatch(/merlincdn\.net\/content\//);
    expect(source).not.toContain('logo.png');
  });

  it('degrades malformed payloads to an empty list', () => {
    expect(parseApiPayload('not json')).toEqual([]);
    expect(parseApiPayload('{"data":[]}')).toEqual([]);
    expect(parseApiPayload('[]')).toEqual([]);
  });

  it('parses a live-shaped day payload into canonical +03:00 programmes', () => {
    const programmes = parseDayEvents(parseApiPayload(smartDay), '2026-11-21', '246003');
    expect(programmes).toHaveLength(8);
    expect(programmes[0]).toEqual({
      channel: 'SPORSMART.tr',
      start: '2026-11-21T00:00:00+03:00',
      stop: '2026-11-21T02:00:00+03:00',
      title: 'Baskonia - Real madrid',
    });
    expect(programmes[1]).toEqual({
      channel: 'SPORSMART.tr',
      start: '2026-11-21T02:00:00+03:00',
      stop: '2026-11-21T04:00:00+03:00',
      title: 'Velez - Belgrano',
    });
    for (const programme of programmes) {
      expect(programme.start.endsWith('+03:00')).toBe(true);
      expect(programme.stop.endsWith('+03:00')).toBe(true);
      expect(programme.stop > programme.start).toBe(true);
    }
  });

  it('drops filler, other channels, other dates and hostile clocks', () => {
    const base = parseApiPayload(smartDay)[1];
    const items = [
      { ...base, statusCode: 300, name: 'Spor Smart' },
      { ...base, cmsId: '246171' },
      { ...base, date: '2026-11-22T00:00:00' },
      { ...base, date: '2026-02-30T00:00:00' },
      { ...base, startHour: '24:30:00' },
      { ...base, startHour: '-1:00:00' },
      { ...base, endHour: '99:00:00' },
      { ...base, endHour: '02:00:00' }, // zero-length
      { ...base, name: '' },
      base, // the one real row
    ];
    const programmes = parseDayEvents(items, '2026-11-21', '246003');
    expect(programmes).toHaveLength(1);
    expect(programmes[0].title).toBe(base.name);
  });

  it('wraps a stop past midnight into the next calendar day', () => {
    const base = parseApiPayload(smartDay)[1];
    const programmes = parseDayEvents(
      [{ ...base, startHour: '23:00:00', endHour: '00:30:00' }],
      '2026-11-21',
      '246003'
    );
    expect(programmes).toEqual([
      {
        channel: 'SPORSMART.tr',
        start: '2026-11-21T23:00:00+03:00',
        stop: '2026-11-22T00:30:00+03:00',
        title: base.name,
      },
    ]);
  });

  it('accepts 24:00:00 only as an explicit end-of-day stop', () => {
    const base = parseApiPayload(smartDay)[1];
    const programmes = parseDayEvents(
      [{ ...base, startHour: '23:00:00', endHour: '24:00:00' }],
      '2026-11-21',
      '246003'
    );
    expect(programmes).toEqual([
      {
        channel: 'SPORSMART.tr',
        start: '2026-11-21T23:00:00+03:00',
        stop: '2026-11-22T00:00:00+03:00',
        title: base.name,
      },
    ]);
    // 24:00:00 is not a valid start.
    expect(parseDayEvents([{ ...base, startHour: '24:00:00' }], '2026-11-21', '246003')).toEqual([]);
  });

  it('dedupes identical slots and refuses unknown channels', () => {
    const base = parseApiPayload(smartDay)[1];
    expect(parseDayEvents([base, { ...base }], '2026-11-21', '246003')).toHaveLength(1);
    expect(parseDayEvents([base], '2026-11-21', '999999')).toEqual([]);
  });
});

describe('dsmart scrape (stubbed fetch)', () => {
  it('fetches the live key from site-config once, then scrapes both feeds', async () => {
    const requests = [];
    const logs = [];
    const result = await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return stubByChannel(url);
      },
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });

    expect(requests).toHaveLength(5); // config + 2 logo lookups + 2 channel-days
    expect(isSiteConfig(requests[0].url)).toBe(true);
    expect(requests[0].options.headers.authorization).toBe(`Bearer ${SITE_CONFIG_TOKEN}`);
    const items = requests.filter((request) => isCmsItem(request.url));
    expect(items).toHaveLength(2);
    expect(new URL(items[0].url).origin).toBe('https://live-cms.example.com');
    for (const item of items) expect(item.options.headers.apiKey).toBe('live-cms-key');
    const events = requests.filter((request) => isEvent(request.url));
    expect(events).toHaveLength(2);
    for (const request of events) {
      expect(new URL(request.url).searchParams.get('key')).toBe('live-key');
    }
    expect(result.channels).toHaveLength(2);
    expect(result.channels.map((channel) => channel.icon)).toEqual([
      'https://zdi2vdd5r0wt.merlincdn.net/content/7/lm/246003/logo.png?v=638671714024212390',
      'https://zdi2vdd5r0wt.merlincdn.net/content/a/hB/246171/logo.png?v=638671715480892871',
    ]);
    expect(result.programmes).toHaveLength(16);
    expect(result.failures).toBe(0);
    expect(logs.join('\n')).toContain('2026-11-21: 16 programme(s)');
  });

  it('uses the env key for the EPG but still fetches live CMS settings for logos', async () => {
    const requests = [];
    await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return stubByChannel(url);
      },
      log: () => {},
      politenessDelayMs: 0,
      env: { DSMART_EPG_KEY: 'env-key' },
    });
    expect(requests.some((request) => isSiteConfig(request.url))).toBe(true);
    const events = requests.filter((request) => isEvent(request.url));
    expect(events).toHaveLength(2);
    for (const event of events) expect(new URL(event.url).searchParams.get('key')).toBe('env-key');
    const items = requests.filter((request) => isCmsItem(request.url));
    expect(new URL(items[0].url).origin).toBe('https://live-cms.example.com');
    expect(items[0].options.headers.apiKey).toBe('live-cms-key');
  });

  it('lets the environment override the site-config bearer token', async () => {
    const requests = [];
    await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return stubByChannel(url);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
      env: { DSMART_SITE_CONFIG_TOKEN: 'rotated-token' },
    });
    const config = requests.find((request) => isSiteConfig(request.url));
    expect(config.options.headers.authorization).toBe('Bearer rotated-token');
  });

  it('falls back to the pinned key with a warning when site-config fails', async () => {
    const logs = [];
    const urls = [];
    const itemHeaders = [];
    const itemUrls = [];
    const result = await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url, options) => {
        urls.push(String(url));
        if (isCmsItem(url)) {
          itemHeaders.push(options.headers);
          itemUrls.push(String(url));
        }
        if (isSiteConfig(url)) throw new Error('config down');
        return stubByChannel(url);
      },
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(logs.join('\n')).toContain('site config unavailable');
    const eventUrl = urls.find((url) => isEvent(url));
    expect(eventUrl).toBeDefined();
    expect(new URL(eventUrl).searchParams.get('key')).toBe(PUBLIC_API_KEY);
    expect(result.channels[0].icon).toContain('/246003/logo.png'); // pinned CMS fallback still yields a logo
    expect(itemHeaders[0].apiKey).toBe(PUBLIC_CMS_API_KEY);
    expect(new URL(itemUrls[0]).origin).toBe(CMS_BASE_URL);
    expect(result.failures).toBe(1); // the failed bootstrap is reported, not hidden
  });

  it('keeps the full schedule when only the logo lookups fail', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url) => {
        if (isCmsItem(url)) throw new Error('cms down');
        return stubByChannel(url);
      },
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });
    expect(logs.join('\n')).toContain('logo lookup failed');
    expect(result.channels).toHaveLength(2);
    expect(result.channels.every((channel) => channel.icon === undefined)).toBe(true);
    expect(result.programmes).toHaveLength(16);
    expect(result.failures).toBe(0); // cosmetic lookups are warned, not counted
  });

  it('scrapes a multi-day window with one request per channel-day', async () => {
    const events = [];
    const result = await scrape({
      dates: ['2026-11-21', '2026-11-22'],
      fetchImpl: async (url) => {
        if (!isEvent(url)) return stubByChannel(url);
        events.push(String(url));
        const day = new URL(url).searchParams.get('startDate');
        const body = String(url).includes('cmsId=246171') ? smart2Day : smartDay;
        return response(body.replaceAll('2026-11-21', day));
      },
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(events).toHaveLength(4); // 2 channels x 2 days
    expect(result.programmes).toHaveLength(32);
    expect(result.failures).toBe(0);
  });

  it('degrades to an empty guide when every request fails', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async () => response('down', { ok: false, status: 500 }),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      fetchOptions: { retries: 0 },
    });
    expect(result.programmes).toEqual([]);
    expect(result.channels).toHaveLength(2);
    expect(result.failures).toBe(3); // the failed bootstrap + two channel-days
    expect(logs.join('\n')).toContain('HTTP 500');
    expect(logs.join('\n')).not.toContain(parseApiPayload(smartDay)[1].name);
  });

  it('honours maxChannels', async () => {
    const urls = [];
    const result = await scrape({
      dates: ['2026-11-21'],
      fetchImpl: async (url) => {
        urls.push(String(url));
        return stubByChannel(url);
      },
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(urls.filter((url) => isEvent(url))).toHaveLength(1);
    expect(urls.filter((url) => isCmsItem(url))).toHaveLength(1);
    expect(result.channels.map((c) => c.id)).toEqual(['SPORSMART.tr']);
    expect(result.programmes).toHaveLength(8);
  });
});

describe('dsmart CLI integration', () => {
  let tmpDir;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-dsmart-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    globalThis.fetch = async (url) => stubByChannel(url);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a gzipped guide containing both feeds', async () => {
    const out = path.join(tmpDir, 'dsmart.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'dsmart',
        '--date', '2026-11-21',
        '--out', out,
        '--delay-ms', '0',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(existsSync(out)).toBe(true);
    const xml = gunzipSync(readFileSync(out)).toString('utf8');
    expect(xml).toContain('<channel id="SPORSMART.tr">');
    expect(xml).toContain('<channel id="SPORSMART2.tr">');
    expect(xml).toContain('<icon src="https://zdi2vdd5r0wt.merlincdn.net/content/7/lm/246003/logo.png?v=638671714024212390"');
    expect(xml).toContain('<icon src="https://zdi2vdd5r0wt.merlincdn.net/content/a/hB/246171/logo.png?v=638671715480892871"');
    expect(xml).toContain('start="20261121020000 +0300" stop="20261121040000 +0300"');
  });

  it('--keep-channels keeps both feeds when the window is empty', async () => {
    globalThis.fetch = async () => response('[]');
    const out = path.join(tmpDir, 'channels-only.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'dsmart',
        '--date', '2026-11-21',
        '--out', out,
        '--delay-ms', '0',
        '--keep-channels',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    const xml = gunzipSync(readFileSync(out)).toString('utf8');
    expect(xml).not.toContain('<programme ');
    expect(xml).toContain('<channel id="SPORSMART.tr">');
    expect(xml).toContain('<channel id="SPORSMART2.tr">');
  });

  it('refuses an empty guide without --keep-channels', async () => {
    globalThis.fetch = async () => response('[]');
    const stderr = [];
    const out = path.join(tmpDir, 'none.xml.gz');
    const exit = await runCli({
      argv: ['--provider', 'dsmart', '--date', '2026-11-21', '--out', out, '--delay-ms', '0', '--quiet'],
      stdout: { write: () => {} },
      stderr: { write: (line) => stderr.push(line) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/nothing scraped/);
    expect(existsSync(out)).toBe(false);
  });

  it('rejects --browser before scraping because the source is a JSON API', async () => {
    globalThis.fetch = async () => {
      throw new Error('must not fetch');
    };
    const stderr = [];
    const out = path.join(tmpDir, 'browser.xml.gz');
    const exit = await runCli({
      argv: ['--provider', 'dsmart', '--date', '2026-11-21', '--browser', '--out', out, '--quiet'],
      stdout: { write: () => {} },
      stderr: { write: (line) => stderr.push(line) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/HTTP-only and cannot use browser transport/);
    expect(existsSync(out)).toBe(false);
  });
});

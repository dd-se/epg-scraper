// CLI implementation, separated from bin/epg-scraper.js so tests can drive it
// with injected argv/fetch/cwd (no process exits, no network).

import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadProviders } from './providers/index.js';
import { getProvider, buildDateRange } from './registry.js';
import { writeXmltv } from './xmltv.js';
import {
  compareResults,
  renderCompareReport,
  compareProviderResults,
  renderProviderCompareReport,
} from './compare.js';
import { mergeResults } from './merge.js';
import { loadAliasMap, createCanonicalizer } from './aliases.js';

const HELP_TEXT = `Usage: epg-scraper [options]

  --provider <id>      provider adapter(s); comma-separated for --merge
                       (default: hurriyet)
  --out <path>         output file (default: epg_<provider>_TR.xml[.gz],
                       or epg_merged_TR.xml[.gz] with --merge)
  --gzip / --no-gzip   write .xml.gz (default) or plain .xml
  --date YYYY-MM-DD    anchor date for the scrape window (default: today)
  --days-back N        days before the anchor to include (default: 0)
  --days-forward N     days after the anchor to include (default: 6)
  --delay-ms N         ms to wait between page fetches (default: provider
                       default — hurriyet 250, mynet 500; mynet fetches
                       ~90 channel pages per day, so keep this polite)
  --browser            launch a headless browser for JS-rendered providers
  --stealth            mask headless browser fingerprints in browser mode
                       (webdriver, plugins, Sec-CH-UA hints, locale) and
                       simulate scrolling + mouse movement
  --compare            scrape twice and diff the results: with one provider,
                       plain HTTP vs headless browser; with two providers
                       (--provider a,b), the two providers' guides channel
                       by channel
  --merge              combine the listed providers into one guide: the first
                       provider wins conflicts, later ones fill the gaps
  --alias-map <path>   JSON file { aliasId: canonicalId } mapping channel ids
                       that differ between providers onto one canonical id
                       (used by --compare and --merge)
  --quiet              suppress progress logging
  --list-providers     list registered providers and exit
  --help               this text

Browser mode:
  Providers that set requiresBrowser: true automatically use a headless
  Chromium (via Playwright) to render pages before parsing.  Pass --browser
  explicitly to force browser mode for any provider.  Playwright must be
  installed separately: npm install playwright

Compare mode:
  --compare requires Playwright + Chromium (see Browser mode above).  With
  one provider it diffs plain HTTP vs a headless browser run; with two
  providers (--provider a,b --compare) it diffs the two guides channel by
  channel — e.g. whether hurriyet's and mynet's ATV schedules agree.  Both
  sides are written as epg_compare.<provider>.xml[.gz] (or derived from
  --out).

Merge mode:
  --provider hurriyet,mynet --merge scrapes every listed provider and writes
  one guide (epg_merged_TR.xml[.gz]) with the union of channels and
  programmes.  Conflicting slots (same channel + time) keep the first
  provider's version, so list the most authoritative source first.`;

export async function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
} = {}) {
  const write = (stream, line) => (stream.write ? stream.write(line + '\n') : undefined);

  let values;
  try {
    values = parseArgs({
      args: argv,
      // allowNegative lets --no-gzip flip the gzip:true default to false.
      allowNegative: true,
      options: {
        provider: { type: 'string', default: 'hurriyet' },
        out: { type: 'string' },
        gzip: { type: 'boolean', default: true },
        date: { type: 'string' },
        'days-forward': { type: 'string', default: '6' },
        'days-back': { type: 'string', default: '0' },
        'max-channels': { type: 'string' },
        'delay-ms': { type: 'string' },
        browser: { type: 'boolean', default: false },
        stealth: { type: 'boolean', default: false },
        compare: { type: 'boolean', default: false },
        merge: { type: 'boolean', default: false },
        'alias-map': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        'list-providers': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      argv,
    }).values;
  } catch (error) {
    // Unknown flags, missing option values, ambiguous negatives, ... —
    // surface a clean error instead of an unhandled parseArgs TypeError.
    write(stderr, `error: ${error && error.message ? error.message : String(error)}`);
    return 1;
  }

  if (values.help) {
    write(stdout, HELP_TEXT);
    return 0;
  }

  const loaded = loadProviders();

  if (values['list-providers']) {
    for (const provider of loaded) {
      const flags = [];
      if (provider.requiresBrowser) flags.push('browser');
      const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
      write(stdout, `${provider.id}\t${provider.name}\t${provider.baseUrl}${suffix}`);
    }
    return 0;
  }

  const fail = (message) => write(stderr, `error: ${message}`);

  if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    fail(`--date expects YYYY-MM-DD, got "${values.date}"`);
    return 1;
  }
  if (values.date) {
    // Reject impossible calendar dates (Feb 30, month 13, ...) that a lenient
    // Date parser would silently roll over into a different day.
    const [y, m, d] = values.date.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth) {
      fail(`--date "${values.date}" is not a valid date`);
      return 1;
    }
  }

  const daysForward = Number(values['days-forward']);
  const daysBack = Number(values['days-back']);
  if (
    !Number.isInteger(daysForward) ||
    daysForward < 0 ||
    !Number.isInteger(daysBack) ||
    daysBack < 0
  ) {
    fail('--days-forward/--days-back expect non-negative integers');
    return 1;
  }

  const referenceDate = values.date ? new Date(`${values.date}T12:00:00Z`) : new Date();
  if (Number.isNaN(referenceDate.getTime())) {
    fail(`--date "${values.date}" is not a valid date`);
    return 1;
  }

  const providerIds = String(values.provider)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (providerIds.length === 0) {
    fail('--provider expects at least one provider id');
    return 1;
  }
  if (values.compare && values.merge) {
    fail('--compare and --merge cannot be combined');
    return 1;
  }
  if (values.compare && providerIds.length > 2) {
    fail('--compare supports at most two providers');
    return 1;
  }
  if (providerIds.length > 1 && !values.merge && !values.compare) {
    fail('multiple providers require --merge (combine into one guide) or --compare (diff the providers)');
    return 1;
  }

  const log = values.quiet ? () => {} : (line) => write(stdout, line);

  const delayMs = parseDelayMs(values, fail);
  if (delayMs === null) return 1;

  // Optional channel-id alias map: canonicalize ids before compare/merge so
  // e.g. mynet's "AHABER.tr" and hurriyet's "A.HABER.tr" line up.
  let canonicalize = (id) => id;
  if (values['alias-map'] != null) {
    try {
      const aliasMap = loadAliasMap(path.resolve(cwd, values['alias-map']));
      canonicalize = createCanonicalizer(aliasMap);
      log(`alias-map: loaded ${Object.keys(aliasMap).length} channel id alias(es)`);
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
      return 1;
    }
  }

  const dates = buildDateRange({ referenceDate, daysBack, daysForward });

  if (values.compare) {
    const compareProviders = providerIds.map((id) => getProvider(id));
    if (compareProviders.length === 1) {
      return runCompare({
        provider: compareProviders[0],
        canonicalize,
        dates,
        values,
        delayMs,
        log,
        fail,
        write,
        stdout,
        stderr,
        cwd,
      });
    }
    return runProviderCompare({
      providers: compareProviders,
      canonicalize,
      dates,
      values,
      delayMs,
      log,
      fail,
      write,
      stdout,
      stderr,
      cwd,
    });
  }

  if (values.merge) {
    return runMerge({
      providers: providerIds.map((id) => getProvider(id)),
      canonicalize,
      dates,
      values,
      delayMs,
      log,
      fail,
      write,
      stdout,
      stderr,
      cwd,
    });
  }

  const provider = getProvider(providerIds[0]);

  // Determine whether to use browser rendering.
  const useBrowser = values.browser || provider.requiresBrowser;

  // Lazily created browser fetcher — only when --browser or requiresBrowser.
  let browserFetcher = null;

  if (useBrowser) {
    try {
      const { createBrowserFetcher } = await import('./browser.js');
      browserFetcher = await createBrowserFetcher({ headless: true, stealth: values.stealth });
      log('browser: Playwright headless Chromium launched');
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
      return 1;
    }
  }
  const extension = values.gzip ? '.xml.gz' : '.xml';
  const outputPath =
    values.out != null
      ? values.out
      : path.join(cwd, `epg_${provider.id}_TR${extension}`);

  log(`provider: ${provider.id} (${provider.name})`);
  log(`window:   ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} day(s))`);

  try {
    const scrapeOptions = { dates, log };
    if (delayMs !== undefined) scrapeOptions.politenessDelayMs = delayMs;
    if (browserFetcher) {
      scrapeOptions.fetchImpl = browserFetcher.fetchImpl;
    }
    if (values['max-channels'] != null) {
      const n = Number(values['max-channels']);
      if (!Number.isInteger(n) || n < 1) {
        fail('--max-channels expects a positive integer');
        return 1;
      }
      scrapeOptions.maxChannels = n;
    }

    const { channels, programmes, days, failures } = await provider.scrape(scrapeOptions);
    log(
      `scraped:  ${channels.length} channels, ${programmes.length} programmes from ${days} day page(s), ${failures} failed page(s)`
    );

    if (channels.length === 0 || programmes.length === 0) {
      fail('nothing scraped — refusing to write an empty guide');
      return 1;
    }

    const { bytes } = await writeXmltv({
      channels,
      programmes,
      outputPath,
      gzip: values.gzip,
      generatorInfoName: `epg-scraper (${provider.id})`,
    });
    log(`written:  ${outputPath} (${bytes} bytes uncompressed XML)`);
    return 0;
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  } finally {
    if (browserFetcher) {
      await browserFetcher.close().catch(() => {});
    }
  }
}

// Parse `--delay-ms` once for all modes.  Returns the delay in ms,
// undefined when the flag was not passed (providers use their default),
// or null after reporting an invalid value (caller must exit 1).
function parseDelayMs(values, fail) {
  if (values['delay-ms'] == null) return undefined;
  const n = Number(values['delay-ms']);
  if (!Number.isInteger(n) || n < 0) {
    fail('--delay-ms expects a non-negative integer (milliseconds)');
    return null;
  }
  return n;
}

// Strip a trailing .gz / .xml so `--compare` can derive the per-mode output
// paths (guide.xml.gz -> guide.http.xml.gz + guide.browser.xml.gz).
function stripXmltvExtension(outputPath) {
  let base = String(outputPath);
  if (/[.]gz$/i.test(base)) base = base.slice(0, -3);
  if (/[.]xml$/i.test(base)) base = base.slice(0, -4);
  return base;
}

// --compare: scrape the provider twice (plain HTTP, then headless browser),
// report the structural differences, and write both guides for manual diffing.
async function runCompare({ provider, dates, values, delayMs, log, fail, write, stdout, stderr, cwd, canonicalize }) {
  // Launch the browser first so a missing Playwright fails fast.
  let browserFetcher = null;
  try {
    const { createBrowserFetcher } = await import('./browser.js');
    browserFetcher = await createBrowserFetcher({ headless: true, stealth: values.stealth });
    log('browser: Playwright headless Chromium launched');
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  }

  try {
    const extension = values.gzip ? '.xml.gz' : '.xml';
    const base =
      values.out != null
        ? stripXmltvExtension(values.out)
        : path.join(cwd, `epg_${provider.id}_TR`);
    const httpOutput = `${base}.http${extension}`;
    const browserOutput = `${base}.browser${extension}`;

    const options = { dates };
    if (delayMs !== undefined) options.politenessDelayMs = delayMs;
    if (values['max-channels'] != null) {
      const n = Number(values['max-channels']);
      if (!Number.isInteger(n) || n < 1) {
        fail('--max-channels expects a positive integer');
        return 1;
      }
      options.maxChannels = n;
    }

    log('compare: scraping with plain HTTP fetch');
    const httpResult = await provider.scrape({
      ...options,
      log: (line) => log(`http:    ${line}`),
    });

    log('compare: scraping with headless browser');
    const browserResult = await provider.scrape({
      ...options,
      fetchImpl: browserFetcher.fetchImpl,
      log: (line) => log(`browser: ${line}`),
    });

    const report = compareResults({ http: httpResult, browser: browserResult, canonicalize });
    for (const line of renderCompareReport({ providerId: provider.id, report })) {
      write(stdout, line);
    }

    let wroteAny = false;
    const writeSide = async (label, result, outputPath) => {
      if (result.channels.length === 0 || result.programmes.length === 0) {
        write(stdout, `note: ${label} produced no data — skipping ${outputPath}`);
        return;
      }
      const { bytes } = await writeXmltv({
        channels: result.channels,
        programmes: result.programmes,
        outputPath,
        gzip: values.gzip,
        generatorInfoName: `epg-scraper (${provider.id})`,
      });
      write(stdout, `written: ${outputPath} (${bytes} bytes uncompressed XML) [${label}]`);
      wroteAny = true;
    };
    await writeSide('http', httpResult, httpOutput);
    await writeSide('browser', browserResult, browserOutput);

    if (!wroteAny) {
      fail('nothing scraped in either mode — refusing to write empty guides');
      return 1;
    }
    return 0;
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  } finally {
    if (browserFetcher) {
      await browserFetcher.close().catch(() => {});
    }
  }
}

// --merge: scrape every listed provider (sharing one browser when any of
// them needs JS rendering), combine the results into a single complete guide
// and write one XMLTV file.
async function runMerge({ providers, dates, values, delayMs, log, fail, write, stdout, stderr, cwd, canonicalize }) {
  // Lazily create one browser fetcher shared by every provider that needs it.
  const needBrowser = values.browser || providers.some((p) => p.requiresBrowser);
  let browserFetcher = null;
  if (needBrowser) {
    try {
      const { createBrowserFetcher } = await import('./browser.js');
      browserFetcher = await createBrowserFetcher({ headless: true, stealth: values.stealth });
      log('browser: Playwright headless Chromium launched');
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
      return 1;
    }
  }

  try {
    let maxChannels;
    if (values['max-channels'] != null) {
      const n = Number(values['max-channels']);
      if (!Number.isInteger(n) || n < 1) {
        fail('--max-channels expects a positive integer');
        return 1;
      }
      maxChannels = n;
    }

    const results = [];
    for (const provider of providers) {
      const useBrowser = values.browser || provider.requiresBrowser;
      log(`merge: scraping ${provider.id} (${provider.name})${useBrowser ? ' [browser]' : ''}`);
      const result = await provider.scrape({
        dates,
        maxChannels,
        politenessDelayMs: delayMs,
        fetchImpl: useBrowser ? browserFetcher.fetchImpl : undefined,
        log: (line) => log(`${provider.id}: ${line}`),
      });
      results.push({ providerId: provider.id, ...result });
      log(
        `merge: ${provider.id} contributed ${result.channels.length} channels, ` +
          `${result.programmes.length} programmes (${result.failures} failed page(s))`
      );
    }

    const merged = mergeResults(results, canonicalize);
    log(
      `merge: ${merged.channels.length} channels, ${merged.programmes.length} programmes ` +
        `from ${providers.length} provider(s), ${merged.duplicates} duplicate programme(s) removed`
    );

    if (merged.channels.length === 0 || merged.programmes.length === 0) {
      fail('nothing scraped — refusing to write an empty guide');
      return 1;
    }

    const extension = values.gzip ? '.xml.gz' : '.xml';
    const outputPath =
      values.out != null ? values.out : path.join(cwd, `epg_merged_TR${extension}`);
    const { bytes } = await writeXmltv({
      channels: merged.channels,
      programmes: merged.programmes,
      outputPath,
      gzip: values.gzip,
      generatorInfoName: `epg-scraper (merged: ${providers.map((p) => p.id).join('+')})`,
    });
    log(`written: ${outputPath} (${bytes} bytes uncompressed XML)`);
    return 0;
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  } finally {
    if (browserFetcher) {
      await browserFetcher.close().catch(() => {});
    }
  }
}

// --compare with two providers: scrape both (each in its natural mode,
// sharing one browser when any of them needs JS rendering), diff the guides
// channel by channel, and write both sides for manual diffing.
async function runProviderCompare({ providers, dates, values, delayMs, log, fail, write, stdout, stderr, cwd, canonicalize }) {
  const needBrowser = values.browser || providers.some((p) => p.requiresBrowser);
  let browserFetcher = null;
  if (needBrowser) {
    try {
      const { createBrowserFetcher } = await import('./browser.js');
      browserFetcher = await createBrowserFetcher({ headless: true, stealth: values.stealth });
      log('browser: Playwright headless Chromium launched');
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
      return 1;
    }
  }

  try {
    let maxChannels;
    if (values['max-channels'] != null) {
      const n = Number(values['max-channels']);
      if (!Number.isInteger(n) || n < 1) {
        fail('--max-channels expects a positive integer');
        return 1;
      }
      maxChannels = n;
    }

    const results = [];
    for (const provider of providers) {
      const useBrowser = values.browser || provider.requiresBrowser;
      log(`compare: scraping ${provider.id} (${provider.name})${useBrowser ? ' [browser]' : ''}`);
      const result = await provider.scrape({
        dates,
        maxChannels,
        politenessDelayMs: delayMs,
        fetchImpl: useBrowser ? browserFetcher.fetchImpl : undefined,
        log: (line) => log(`${provider.id}: ${line}`),
      });
      results.push({ providerId: provider.id, ...result });
      log(
        `compare: ${provider.id} produced ${result.channels.length} channels, ` +
          `${result.programmes.length} programmes (${result.failures} failed page(s))`
      );
    }

    const [a, b] = results;
    const report = compareProviderResults({ a, b, canonicalize });
    for (const line of renderProviderCompareReport({
      providerA: a.providerId,
      providerB: b.providerId,
      report,
    })) {
      write(stdout, line);
    }

    const extension = values.gzip ? '.xml.gz' : '.xml';
    const base =
      values.out != null
        ? stripXmltvExtension(values.out)
        : path.join(cwd, 'epg_compare');
    const aOutput = `${base}.${a.providerId}${extension}`;
    const bOutput = `${base}.${b.providerId}${extension}`;

    let wroteAny = false;
    const writeSide = async (label, result, outputPath) => {
      if (result.channels.length === 0 || result.programmes.length === 0) {
        write(stdout, `note: ${label} produced no data — skipping ${outputPath}`);
        return;
      }
      const { bytes } = await writeXmltv({
        channels: result.channels,
        programmes: result.programmes,
        outputPath,
        gzip: values.gzip,
        generatorInfoName: `epg-scraper (${label})`,
      });
      write(stdout, `written: ${outputPath} (${bytes} bytes uncompressed XML) [${label}]`);
      wroteAny = true;
    };
    await writeSide(a.providerId, a, aOutput);
    await writeSide(b.providerId, b, bOutput);

    if (!wroteAny) {
      fail('nothing scraped in either provider — refusing to write empty guides');
      return 1;
    }
    return 0;
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  } finally {
    if (browserFetcher) {
      await browserFetcher.close().catch(() => {});
    }
  }
}

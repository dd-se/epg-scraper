// CLI implementation, separated from bin/epg-scraper.js so tests can drive it
// with injected argv/fetch/cwd (no process exits, no network).

import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadProviders } from './providers/index.js';
import { buildDateRange } from './registry.js';
import { writeXmltv, readXmltvFile } from './xmltv.js';
import {
  compareResults,
  renderCompareReport,
  compareProviderResults,
  renderProviderCompareReport,
} from './compare.js';
import { mergeResults } from './merge.js';
import { loadAliasMap, createCanonicalizer } from './aliases.js';
import { createGuideResult } from './model.js';
import { resolveProviderContext } from './provider-catalog.js';

const HELP_TEXT = `Usage: epg-scraper [options]

  --provider <id>      provider adapter(s); comma-separated for --merge
                       (default: hurriyet)
  --out <path>         output file (default: epg_<provider>_<COUNTRY>.xml[.gz],
                       or epg_merged_<COUNTRY>.xml[.gz] with --merge;
                       COUNTRY is the provider's own — TR unless it
                       declares otherwise, e.g. tvnu writes _SE)
  --gzip / --no-gzip   write .xml.gz (default) or plain .xml
  --date YYYY-MM-DD    anchor date for the scrape window (default: today)
  --days-back N        days before the anchor to include (default: 0, max 60)
  --days-forward N     days after the anchor to include (default: 6, max 60)
  --delay-ms N         ms to wait between page fetches (default: provider
                       default — hurriyet 250, mynet 500, tvplus 400,
                       beinsports 300, digiturkburada 400, sporekrani 500,
                       sporekraniapi 300, tivibu 400, idmantv 250, tvnu 400;
                       mynet fetches
                       ~90 channel pages per day and tvnu one page per
                       channel and day (~46 per window day incl. the
                       small-hours lookback), so keep this polite)
  --retries N          transport retries per request after the first attempt
                       (default: 2 for GET pages, 1 for API POSTs; 5xx/429,
                       transport and body-read errors are retried; 404/410
                       and GET 403 are not; API POST 403 remains retryable)
  --timeout-ms N       per-request hard timeout in ms, including body reads
                       and browser navigation (default: 20000)
  --retry-delay-ms N   base ms between retry attempts, scaled linearly per
                       attempt (default: 400)
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
  --from <files>       with --merge, skip scraping and merge already-scraped
                       XMLTV files instead (comma-separated .xml/.xml.gz
                       paths) — reuses earlier outputs without hitting live
                       servers again
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
  one guide (epg_merged_<COUNTRY>.xml[.gz] — <COUNTRY> follows the first
  provider, e.g. tvnu-led merges write _SE) with the union of channels and
  programmes.  Conflicting slots (same channel + time) keep the first
  provider's version, so list the most authoritative source first.  With
  --from, no server is hit at all: already-scraped guides are merged
  offline (file order sets the precedence):

    node bin/epg-scraper.js --merge --from guides/a.xml.gz,guides/b.xml.gz --out epg_merged_TR.xml.gz`;

export async function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  providerLoader = loadProviders,
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
        retries: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'retry-delay-ms': { type: 'string' },
        browser: { type: 'boolean', default: false },
        stealth: { type: 'boolean', default: false },
        compare: { type: 'boolean', default: false },
        merge: { type: 'boolean', default: false },
        from: { type: 'string' },
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

  const loaded = providerLoader();
  const providersById = new Map(loaded.map((provider) => [provider.id, provider]));

  if (values['list-providers']) {
    for (const provider of loaded) {
      const flags = [];
      if (provider.requiresBrowser) flags.push('browser');
      if (provider.browserCompatible === false) flags.push('http-only');
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
  // A hostile or typo'd window (1e9, 1e21) must be rejected before
  // buildDateRange() materializes it as a date array (hang/OOM), not after.
  const MAX_WINDOW_DAYS = 60;
  if (
    !Number.isInteger(daysForward) ||
    daysForward < 0 ||
    daysForward > MAX_WINDOW_DAYS ||
    !Number.isInteger(daysBack) ||
    daysBack < 0 ||
    daysBack > MAX_WINDOW_DAYS
  ) {
    fail(`--days-forward/--days-back expect integers between 0 and ${MAX_WINDOW_DAYS}`);
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

  // Offline merge inputs: --merge --from a.xml.gz,b.xml.gz reuses
  // already-scraped guides instead of hitting live servers.
  const fromFiles =
    values.from != null
      ? String(values.from)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (values.from != null && !values.merge) {
    fail('--from requires --merge (it merges already-scraped XMLTV files)');
    return 1;
  }
  if (values.from != null && fromFiles.length === 0) {
    fail('--from expects at least one file path');
    return 1;
  }

  const log = values.quiet ? () => {} : (line) => write(stdout, line);

  const delayMs = parseDelayMs(values, fail);
  if (delayMs === null) return 1;

  const transportOptions = parseTransportOptions(values, fail);
  if (transportOptions === null) return 1;
  if (Object.keys(transportOptions).length > 0) {
    log(
      `transport: retries=${transportOptions.retries ?? 'default'} timeout=${
        transportOptions.timeoutMs ?? 'default'
      }ms retry-delay=${transportOptions.retryDelayMs ?? 'default'}ms`
    );
  }

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

  // Resolve provider ids before any mode work so an unknown id fails with the
  // same clean "error: ..." + exit 1 as the other bad flags — not as a raw
  // registry exception from whichever mode hit the registry first.  Runs
  // after the alias-map load to keep the established precedence (a bad
  // alias-map wins over a bad provider id), and --merge --from is exempt by
  // design: it never touches the registry (the --provider value is ignored,
  // no live scrape happens), which tests rely on.
  if (!(values.merge && fromFiles.length > 0)) {
    for (const id of providerIds) {
      if (!providersById.has(id)) {
        const registered = loaded.map((provider) => provider.id).join(', ') || '(none)';
        fail(`Unknown provider "${id}". Registered: ${registered}`);
        return 1;
      }
    }

    const selectedProviders = providerIds.map((id) => providersById.get(id));
    const browserCompare = values.compare && providerIds.length === 1;
    const browserProviders = selectedProviders.filter(
      (provider) => browserCompare || values.browser || provider.requiresBrowser
    );
    const incompatible = browserProviders.filter(
      (provider) => provider.browserCompatible === false
    );
    if (incompatible.length > 0) {
      const ids = incompatible.map((provider) => `"${provider.id}"`).join(', ');
      fail(
        `${incompatible.length === 1 ? 'provider' : 'providers'} ${ids} ` +
          `${incompatible.length === 1 ? 'is' : 'are'} HTTP-only and cannot use browser transport`
      );
      return 1;
    }
  }

  // The default window is anchored on the provider's own time zone, so
  // "today" means today where the guide is watched (Stockholm for tvnu,
  // Istanbul for the Turkish providers); `--date` overrides the anchor.
  // `--merge --from` never touches the registry, so it keeps the default.
  const windowProvider =
    !(values.merge && fromFiles.length > 0) && providerIds.length > 0
      ? providersById.get(providerIds[0])
      : undefined;
  const dates = buildDateRange({
    referenceDate,
    daysBack,
    daysForward,
    timeZone: windowProvider ? resolveProviderContext(windowProvider).timeZone : undefined,
  });

  const offline = values.merge && fromFiles.length > 0;
  const providers = offline ? [] : providerIds.map((id) => providersById.get(id));
  const mode = values.compare
    ? providers.length === 1
      ? 'http-browser-compare'
      : 'provider-compare'
    : values.merge
      ? offline
        ? 'offline-merge'
        : 'live-merge'
      : 'single';

  return executeCliRun({
    mode,
    providers,
    fromFiles,
    canonicalize,
    dates,
    cwd,
    gzip: values.gzip,
    out: values.out,
    forceBrowser: values.browser,
    stealth: values.stealth,
    maxChannelsArg: values['max-channels'],
    delayMs,
    transportOptions,
    log,
    emit: (line) => write(stdout, line),
    fail,
  });
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

// Parse `--retries`, `--timeout-ms` and `--retry-delay-ms` into an options
// object forwarded to every provider (they pass it into the transport
// layer).  Returns {} when no flag was passed, null after reporting an
// invalid value (caller must exit 1).
function parseTransportOptions(values, fail) {
  const options = {};
  if (values.retries != null) {
    const n = Number(values.retries);
    if (!Number.isInteger(n) || n < 0) {
      fail('--retries expects a non-negative integer (retry attempts per request)');
      return null;
    }
    options.retries = n;
  }
  if (values['timeout-ms'] != null) {
    const n = Number(values['timeout-ms']);
    if (!Number.isInteger(n) || n <= 0) {
      fail('--timeout-ms expects a positive integer (milliseconds)');
      return null;
    }
    options.timeoutMs = n;
  }
  if (values['retry-delay-ms'] != null) {
    const n = Number(values['retry-delay-ms']);
    if (!Number.isInteger(n) || n < 0) {
      fail('--retry-delay-ms expects a non-negative integer (milliseconds)');
      return null;
    }
    options.retryDelayMs = n;
  }
  return options;
}

function browserFetchOptions(stealth, transportOptions = {}) {
  return {
    headless: true,
    stealth,
    timeoutMs: transportOptions.timeoutMs ?? 20000,
  };
}

// Strip a trailing .gz / .xml so `--compare` can derive the per-mode output
// paths (guide.xml.gz -> guide.http.xml.gz + guide.browser.xml.gz).
function stripXmltvExtension(outputPath) {
  let base = String(outputPath);
  if (/[.]gz$/i.test(base)) base = base.slice(0, -3);
  if (/[.]xml$/i.test(base)) base = base.slice(0, -4);
  return base;
}

// Parse `--max-channels` once for all modes.  Returns the cap, undefined
// when the flag was not passed, or null after reporting an invalid value
// (caller must exit 1).
function parseMaxChannels(value, fail) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    fail('--max-channels expects a positive integer');
    return null;
  }
  return n;
}

async function executeCliRun(context) {
  const maxChannels = parseMaxChannels(context.maxChannelsArg, context.fail);
  if (maxChannels === null) return 1;

  const needBrowser =
    context.mode === 'http-browser-compare' ||
    (context.mode !== 'offline-merge' &&
      (context.forceBrowser || context.providers.some((provider) => provider.requiresBrowser)));
  let browserFetcher = null;

  if (needBrowser) {
    try {
      const { createBrowserFetcher } = await import('./browser.js');
      browserFetcher = await createBrowserFetcher(
        browserFetchOptions(context.stealth, context.transportOptions)
      );
      context.log('browser: Playwright headless Chromium launched');
    } catch (error) {
      context.fail(errorMessage(error));
      return 1;
    }
  }

  try {
    if (context.mode === 'single') {
      const provider = context.providers[0];
      context.log(`provider: ${provider.id} (${provider.name})`);
      context.log(
        `window:   ${context.dates[0]} .. ${context.dates[context.dates.length - 1]} ` +
          `(${context.dates.length} day(s))`
      );
    }

    const runContext = {
      ...context,
      maxChannels,
      browserFetchImpl: browserFetcher?.fetchImpl,
    };

    switch (runContext.mode) {
      case 'single':
        return await runSingleMode(runContext);
      case 'http-browser-compare':
        return await runHttpBrowserCompareMode(runContext);
      case 'provider-compare':
        return await runProviderCompareMode(runContext);
      case 'live-merge':
      case 'offline-merge':
        return await runMergeMode(runContext);
      default:
        throw new Error(`Unknown CLI mode ${runContext.mode}`);
    }
  } catch (error) {
    context.fail(errorMessage(error));
    return 1;
  } finally {
    if (browserFetcher) {
      await browserFetcher.close().catch(() => {});
    }
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function scrapeProvider(provider, context, { useBrowser = false, logPrefix = '' } = {}) {
  const options = {
    dates: context.dates,
    fetchOptions: { ...context.transportOptions },
    log: (line) => context.log(`${logPrefix}${line}`),
  };
  if (context.delayMs !== undefined) options.politenessDelayMs = context.delayMs;
  if (context.maxChannels !== undefined) options.maxChannels = context.maxChannels;
  if (useBrowser) options.fetchImpl = context.browserFetchImpl;
  const result = await provider.scrape(options);
  return createGuideResult(
    {
      ...result,
      language: result?.language || resolveProviderContext(provider).language,
    },
    {
      onIssue: (code, count) => context.log(`warn: dropped ${count} invalid ${code} result entr(ies)`),
    }
  );
}

async function writeComparisonSides(context, sides) {
  let wroteAny = false;
  for (const side of sides) {
    const { label, result, outputPath, generatorInfoName, language } = side;
    if (result.channels.length === 0 || result.programmes.length === 0) {
      context.emit(`note: ${label} produced no data — skipping ${outputPath}`);
      continue;
    }
    const { bytes } = await writeXmltv({
      channels: result.channels,
      programmes: result.programmes,
      outputPath,
      gzip: context.gzip,
      generatorInfoName,
      language,
    });
    context.emit(`written: ${outputPath} (${bytes} bytes uncompressed XML) [${label}]`);
    wroteAny = true;
  }
  return wroteAny;
}

async function runSingleMode(context) {
  const provider = context.providers[0];
  const extension = context.gzip ? '.xml.gz' : '.xml';
  const outputPath =
    context.out != null
      ? path.resolve(context.cwd, context.out)
      : path.join(context.cwd, `epg_${provider.id}_${resolveProviderContext(provider).country}${extension}`);
  const useBrowser = context.forceBrowser || provider.requiresBrowser;
  const result = await scrapeProvider(provider, context, { useBrowser });
  context.log(
    `scraped:  ${result.channels.length} channels, ${result.programmes.length} programmes ` +
      `from ${result.days} day page(s), ${result.failures} failed page(s)`
  );

  if (result.channels.length === 0 || result.programmes.length === 0) {
    context.fail('nothing scraped — refusing to write an empty guide');
    return 1;
  }

  const { bytes } = await writeXmltv({
    channels: result.channels,
    programmes: result.programmes,
    outputPath,
    gzip: context.gzip,
    generatorInfoName: `epg-scraper (${provider.id})`,
    language: result.language || resolveProviderContext(provider).language,
  });
  context.log(`written:  ${outputPath} (${bytes} bytes uncompressed XML)`);
  return 0;
}

async function runHttpBrowserCompareMode(context) {
  const provider = context.providers[0];
  const extension = context.gzip ? '.xml.gz' : '.xml';
  const base =
    context.out != null
      ? path.resolve(context.cwd, stripXmltvExtension(context.out))
      : path.join(context.cwd, `epg_${provider.id}_${resolveProviderContext(provider).country}`);

  context.log('compare: scraping with plain HTTP fetch');
  const httpResult = await scrapeProvider(provider, context, { logPrefix: 'http:    ' });
  context.log('compare: scraping with headless browser');
  const browserResult = await scrapeProvider(provider, context, {
    useBrowser: true,
    logPrefix: 'browser: ',
  });

  const report = compareResults({
    http: httpResult,
    browser: browserResult,
    canonicalize: context.canonicalize,
  });
  for (const line of renderCompareReport({ providerId: provider.id, report })) {
    context.emit(line);
  }

  const wroteAny = await writeComparisonSides(context, [
    {
      label: 'http',
      result: httpResult,
      outputPath: `${base}.http${extension}`,
      generatorInfoName: `epg-scraper (${provider.id})`,
      language: httpResult.language || resolveProviderContext(provider).language,
    },
    {
      label: 'browser',
      result: browserResult,
      outputPath: `${base}.browser${extension}`,
      generatorInfoName: `epg-scraper (${provider.id})`,
      language: browserResult.language || resolveProviderContext(provider).language,
    },
  ]);
  if (!wroteAny) {
    context.fail('nothing scraped in either mode — refusing to write empty guides');
    return 1;
  }
  return 0;
}

async function runMergeMode(context) {
  const offline = context.mode === 'offline-merge';
  const results = [];

  if (offline) {
    for (const file of context.fromFiles) {
      let parsed;
      try {
        parsed = await readXmltvFile(path.resolve(context.cwd, file));
      } catch (error) {
        context.fail(`--from "${file}": ${errorMessage(error)}`);
        return 1;
      }
      const label = path.basename(file);
      results.push({ providerId: label, ...parsed });
      context.log(
        `merge: ${label} loaded ${parsed.channels.length} channels, ` +
          `${parsed.programmes.length} programmes`
      );
    }
  } else {
    for (const provider of context.providers) {
      const useBrowser = context.forceBrowser || provider.requiresBrowser;
      context.log(
        `merge: scraping ${provider.id} (${provider.name})${useBrowser ? ' [browser]' : ''}`
      );
      const result = await scrapeProvider(provider, context, {
        useBrowser,
        logPrefix: `${provider.id}: `,
      });
      results.push({ providerId: provider.id, ...result });
      context.log(
        `merge: ${provider.id} contributed ${result.channels.length} channels, ` +
          `${result.programmes.length} programmes (${result.failures} failed page(s))`
      );
    }
  }

  const merged = mergeResults(results, context.canonicalize, {
    onIssue: (code, count) => context.log(`warn: merge reported ${count} ${code}`),
  });
  const sourceCount = offline ? context.fromFiles.length : context.providers.length;
  const sourceNoun = offline ? 'file(s)' : 'provider(s)';
  context.log(
    `merge: ${merged.channels.length} channels, ${merged.programmes.length} programmes ` +
      `from ${sourceCount} ${sourceNoun}, ${merged.duplicates} duplicate programme(s) removed`
  );

  if (merged.channels.length === 0 || merged.programmes.length === 0) {
    context.fail(
      offline
        ? 'nothing merged — refusing to write an empty guide'
        : 'nothing scraped — refusing to write an empty guide'
    );
    return 1;
  }

  const extension = context.gzip ? '.xml.gz' : '.xml';
  const leadProvider = offline ? undefined : context.providers[0];
  const outputPath =
    context.out != null
      ? path.resolve(context.cwd, context.out)
      : path.join(context.cwd, `epg_merged_${resolveProviderContext(leadProvider).country}${extension}`);
  const generatorInfoName = offline
    ? `epg-scraper (merged files: ${context.fromFiles.map((file) => path.basename(file)).join('+')})`
    : `epg-scraper (merged: ${context.providers.map((provider) => provider.id).join('+')})`;
  const { bytes } = await writeXmltv({
    channels: merged.channels,
    programmes: merged.programmes,
    outputPath,
    gzip: context.gzip,
    generatorInfoName,
    language: merged.language || resolveProviderContext(leadProvider).language,
  });
  context.log(`written: ${outputPath} (${bytes} bytes uncompressed XML)`);
  return 0;
}

// --compare with two providers: scrape both (each in its natural mode,
// sharing one browser when any of them needs JS rendering), diff the guides
// channel by channel, and write both sides for manual diffing.
async function runProviderCompareMode(context) {
  const sides = [];
  for (const provider of context.providers) {
    const useBrowser = context.forceBrowser || provider.requiresBrowser;
    context.log(
      `compare: scraping ${provider.id} (${provider.name})${useBrowser ? ' [browser]' : ''}`
    );
    const result = await scrapeProvider(provider, context, {
      useBrowser,
      logPrefix: `${provider.id}: `,
    });
    sides.push({ provider, result });
    context.log(
      `compare: ${provider.id} produced ${result.channels.length} channels, ` +
        `${result.programmes.length} programmes (${result.failures} failed page(s))`
    );
  }

  const [a, b] = sides;
  const report = compareProviderResults({
    a: a.result,
    b: b.result,
    canonicalize: context.canonicalize,
  });
  for (const line of renderProviderCompareReport({
    providerA: a.provider.id,
    providerB: b.provider.id,
    report,
  })) {
    context.emit(line);
  }

  const extension = context.gzip ? '.xml.gz' : '.xml';
  const base =
    context.out != null
      ? path.resolve(context.cwd, stripXmltvExtension(context.out))
      : path.join(context.cwd, 'epg_compare');
  const wroteAny = await writeComparisonSides(
    context,
    sides.map(({ provider, result }) => ({
      label: provider.id,
      result,
      outputPath: `${base}.${provider.id}${extension}`,
      generatorInfoName: `epg-scraper (${provider.id})`,
      language: result.language || resolveProviderContext(provider).language,
    }))
  );
  if (!wroteAny) {
    context.fail('nothing scraped in either provider — refusing to write empty guides');
    return 1;
  }
  return 0;
}

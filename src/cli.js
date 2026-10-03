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
import { DEFAULT_ENV_FILE, applyEnv, readEnvFile } from './env-file.js';
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
  --exclusive-channels with --merge, the first provider that lists a channel
                       owns it: later providers contribute nothing for that
                       channel, so a duplicate feed's differing slot
                       boundaries never interleave with the authoritative one
                       (still unions channels, so icons backfill)
  --alias-map <path>   JSON file { aliasId: canonicalId } mapping channel ids
                       that differ between providers onto one canonical id
                       (used by --compare and --merge)
  --dotenv <path>      env file with credentials (default: ./.env when it
                       exists; a named file must exist).  Variables already
                       set in the environment win, so CI secrets are never
                       overridden.  Read by providers that need secrets, e.g.
                       sporekraniapi (SPOREKRANI_API_APP_ID / _API_KEY)
                       (not --env-file: Node intercepts that name in argv —
                       use  node --env-file=<path> bin/epg-scraper.js  instead)
  --quiet              suppress progress logging
  --list-providers     list registered providers and exit
  --help               this text

Credentials:
  Providers that need secrets read them from the environment.  For local live
  runs the CLI loads ./.env (or the file named by --dotenv) before scraping;
  real environment variables always win, so CI secrets are never overridden.
  Values are never printed — only how many variables were applied.  Node's own
  --env-file=<path> option (before the script) also works and wins over the
  default ./.env, because it applies before this script starts.

    cp .env.example .env   # then fill in SPOREKRANI_API_APP_ID / _API_KEY

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

    node bin/epg-scraper.js --merge --from guides/a.xml.gz,guides/b.xml.gz --out epg_merged_TR.xml.gz

M3U playlist mode (no EPG, no XMLTV):
  --m3u <config.json>   build a merged IPTV playlist from several M3U sources.
                        Independent of the guide pipeline: it never launches a
                        browser and cannot be combined with --provider,
                        --merge, --compare, --from, --browser, --stealth,
                        --alias-map, --date or --max-channels.  Output defaults
                        to playlist.m3u (gzip off by default; set the
                        config's output.gzip to true to compress it).
  --m3u-out <path>      output playlist (default: the config's output.path)
  --m3u-sources <urls>  comma-separated source URLs/paths, overriding the config
  --m3u-want <patterns> append channel globs to the config's want list.  The
                        curated catalog (src/m3u/channels.js) is the baseline,
                        so most runs need no --m3u-want at all.  Patterns are
                        anchored globs: "ATV" is exactly ATV and never ATV
                        Alanya; use "ATV*" for the editions.
  --m3u-exclude <pats>  append exclusion globs (exclude always beats want)
  --m3u-style <style>   numbered | parenthesized | none | backup (default) | source
                         | keep-first | fail
                         "none" gives every feed of a channel the same name AND
                         the same tvg-id, which is what a name-keyed consumer
                         (e.g. a strict name-keyed player) needs.
  --m3u-strip-quality   comma-separated quality tokens folded when matching
                        (default HD,FHD,UHD,SD; pass an empty value to disable.
                        4K is NOT folded: TRT 4K is a separate simulcast)
  --m3u-keep-scheme     do not unify http/https when comparing stream URLs
  --m3u-keep-query      do not ignore the query string when comparing URLs
  --m3u-no-infer-tvg-id do not infer a missing tvg-id from the channel name
  --m3u-no-yedek        do not expand Yedek* backup attributes (on by default)
  --m3u-max-copies N    cap copies kept per channel (default 6; 0 = unlimited)
  --m3u-max-bytes N     refuse a source larger than N bytes (default 16 MiB)
  --m3u-report <path>   write the JSON run report (URLs are redacted)
  --m3u-dry-run         resolve and print the plan; fetch nothing, write nothing
  --m3u-list            print the resolved plan's sources and want list
  --m3u-live            probe each stream and DROP the dead ones.  A pass needs
                        both a 2xx and "#EXTM3U" in the first bytes, so a 200
                        serving an HTML block page counts as dead.  Run it from
                        home, not CI: a 403 is usually region-locked rather than
                        dead, and every drop is listed in the report
  --m3u-live-keep       probe but KEEP failures, reporting them instead
  --m3u-live-depth N    1 (default) = manifest only, 2 = also the first segment
  --m3u-live-timeout-ms N   per-probe timeout (default 6000)
  --m3u-live-concurrency N  parallel probes (default 4, max 8)
  --m3u-live-retry N    retries for a retryable probe failure (default 1)

    node bin/epg-scraper.js --m3u m3u.config.json --m3u-list
    node bin/epg-scraper.js --m3u m3u.config.json --m3u-out playlist.m3u`;

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
        'exclusive-channels': { type: 'boolean', default: false },
        // `--dotenv`, not `--env-file`: Node parses `--env-file` (and
        // `--env-file-if-exists`) anywhere in argv — even after the script
        // path — so a flag with that name never reaches this parser.
        dotenv: { type: 'string' },
        // --m3u playlist mode.  `--m3u` takes a config path; the `--m3u-*`
        // flags are overrides that are applied after the config is loaded.
        m3u: { type: 'string' },
        'm3u-out': { type: 'string' },
        'm3u-sources': { type: 'string' },
        'm3u-want': { type: 'string' },
        'm3u-exclude': { type: 'string' },
        'm3u-style': { type: 'string' },
        'm3u-strip-quality': { type: 'string' },
        'm3u-keep-scheme': { type: 'boolean', default: false },
        'm3u-keep-query': { type: 'boolean', default: false },
        'm3u-no-infer-tvg-id': { type: 'boolean', default: false },
        'm3u-no-yedek': { type: 'boolean', default: false },
        'm3u-max-copies': { type: 'string' },
        'm3u-max-bytes': { type: 'string' },
        'm3u-report': { type: 'string' },
        'm3u-dry-run': { type: 'boolean', default: false },
        'm3u-list': { type: 'boolean', default: false },
        'm3u-live': { type: 'boolean', default: false },
        'm3u-live-keep': { type: 'boolean', default: false },
        'm3u-live-timeout-ms': { type: 'string' },
        'm3u-live-concurrency': { type: 'string' },
        'm3u-live-depth': { type: 'string' },
        'm3u-live-retry': { type: 'string' },
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
  // `--m3u` reports every mutually exclusive flag in one line further down, so
  // defer to it here rather than emitting a second, narrower complaint first.
  if (values.from != null && !values.merge && values.m3u == null) {
    fail('--from requires --merge (it merges already-scraped XMLTV files)');
    return 1;
  }
  if (values.from != null && values.m3u == null && fromFiles.length === 0) {
    fail('--from expects at least one file path');
    return 1;
  }
  if (values['exclusive-channels'] && !values.merge && values.m3u == null) {
    fail('--exclusive-channels requires --merge (it only changes how providers are combined)');
    return 1;
  }

  const log = values.quiet ? () => {} : (line) => write(stdout, line);

  // Local credentials for live runs: load `.env` (or the --dotenv path)
  // before any provider reads the environment.  The default file is optional;
  // a file the user named explicitly must exist.  Existing environment values
  // win over file values, so CI secrets are never overridden — and Node's own
  // `--env-file=<path>` (applied before this script starts) therefore also
  // wins over the default .env.
  try {
    const envLabel = values.dotenv ?? DEFAULT_ENV_FILE;
    const envEntries = readEnvFile(path.resolve(cwd, envLabel));
    if (envEntries === undefined) {
      if (values.dotenv != null) {
        fail(`--dotenv "${values.dotenv}" not found`);
        return 1;
      }
    } else {
      const applied = applyEnv(envEntries);
      const total = Object.keys(envEntries).length;
      log(
        `env: ${envLabel}: applied ${applied.length}/${total} variable(s)` +
          (applied.length < total ? ' (existing environment values kept)' : '')
      );
    }
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
    return 1;
  }

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

  // The M3U playlist builder is a separate capability with its own result
  // type.  It is dispatched *before* provider resolution so it never touches
  // the guide registry, never enters the browser lifecycle, and cannot be
  // perturbed by a provider id.  It does reuse the delay/transport/quiet
  // plumbing parsed just above.
  if (values.m3u != null) {
    // `provider` has a parser default of "hurriyet", so a *value* comparison
    // cannot tell an explicit `--provider hurriyet` from the default. Scan argv
    // for the flag itself so passing it is still rejected as exclusive.
    const providerFlagPassed = argv.includes('--provider') || argv.some((a) => a.startsWith('--provider='));
    const exclusive = [
      ['--provider', providerFlagPassed],
      ['--merge', values.merge],
      ['--compare', values.compare],
      ['--from', values.from != null],
      ['--browser', values.browser],
      ['--stealth', values.stealth],
      ['--alias-map', values['alias-map'] != null],
      ['--exclusive-channels', values['exclusive-channels']],
      ['--date', values.date != null],
      ['--max-channels', values['max-channels'] != null],
    ].filter(([, present]) => present).map(([name]) => name);

    if (exclusive.length > 0) {
      fail(`--m3u cannot be combined with ${exclusive.join(', ')} (it builds a playlist, not a guide)`);
      return 1;
    }

    return runM3uMode({ values, cwd, log, fail, delayMs, transportOptions });
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
    exclusiveChannels: values['exclusive-channels'] === true,
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

/**
 * The `--m3u` playlist mode.
 *
 * Reads the config, applies the `--m3u-*` overrides on top of it, collects and
 * merges the sources, optionally probes liveness, and writes one playlist plus
 * (on request) a JSON report.  Exit codes follow the degradation table: 0 on
 * success, 1 on a validation error, all-sources-failed, nothing-matched, or a
 * `style: fail` conflict.
 */
async function runM3uMode({ values, cwd, log, fail, delayMs, transportOptions }) {
  const { loadM3uConfig, ConfigError } = await import('./m3u/config.js');
  const { collectEntries, buildM3uReport } = await import('./m3u/collect.js');
  const { writeM3U } = await import('./m3u/writer.js');
  const { probeEntries } = await import('./m3u/liveness.js');
  const { NAMING_STYLES } = await import('./m3u/identity.js');
  const path = await import('node:path');
  const fs = await import('node:fs');

  let plan;
  try {
    plan = loadM3uConfig(values.m3u, { cwd, env: process.env });
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : errorMessage(error));
    return 1;
  }

  // CLI overrides are applied last, so a flag always beats the config file.
  const splitList = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (values['m3u-sources'] != null) {
    plan.sources = splitList(values['m3u-sources']).map((url, index) => ({
      id: `source-${index + 1}`,
      name: `source-${index + 1}`,
      url,
      weight: 0,
    }));
  }
  if (values['m3u-want'] != null) plan.want = [...plan.want, ...splitList(values['m3u-want'])];
  if (values['m3u-exclude'] != null) plan.exclude = [...plan.exclude, ...splitList(values['m3u-exclude'])];
  if (values['m3u-style'] != null) {
    // Derived from NAMING_STYLES rather than repeated here, so a new style
    // cannot be accepted by the config file but rejected by the flag (or worse).
    if (!NAMING_STYLES.includes(values['m3u-style'])) {
      fail(`--m3u-style expects one of: ${NAMING_STYLES.join(', ')}`);
      return 1;
    }
    plan.style = values['m3u-style'];
  }
  if (values['m3u-strip-quality'] != null) plan.stripQuality = splitList(values['m3u-strip-quality']);
  if (values['m3u-keep-scheme']) plan.unifyScheme = false;
  if (values['m3u-keep-query']) plan.keepQuery = true;
  if (values['m3u-no-infer-tvg-id']) plan.inferTvgId = false;
  if (values['m3u-no-yedek']) plan.useYedek = false;

  const intFlag = (raw, name, { min, max }) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      fail(`${name} expects an integer between ${min} and ${max}`);
      return null;
    }
    return n;
  };
  if (values['m3u-max-copies'] != null) {
    const n = intFlag(values['m3u-max-copies'], '--m3u-max-copies', { min: 0, max: 1000 });
    if (n === null) return 1;
    plan.maxCopies = n;
  }
  if (values['m3u-max-bytes'] != null) {
    const n = intFlag(values['m3u-max-bytes'], '--m3u-max-bytes', { min: 1024, max: 256 * 1024 * 1024 });
    if (n === null) return 1;
    plan.maxBytes = n;
  }

  if (values['m3u-live']) plan.live.enabled = true;
  if (values['m3u-live-keep']) {
    plan.live.enabled = true;
    plan.live.keepFailed = true;
  }
  const liveInt = [
    ['m3u-live-timeout-ms', 'timeoutMs', 100, 120000],
    ['m3u-live-concurrency', 'concurrency', 1, 8],
    ['m3u-live-depth', 'depth', 1, 2],
    ['m3u-live-retry', 'retries', 0, 5],
  ];
  for (const [flag, key, min, max] of liveInt) {
    if (values[flag] == null) continue;
    const n = intFlag(values[flag], `--${flag}`, { min, max });
    if (n === null) return 1;
    plan.live[key] = n;
  }

  const outputPath = path.resolve(cwd, values['m3u-out'] || plan.output.path);
  // Gzip defaults OFF for this mode: a playlist is normally handed to a player
  // or a local app, which reads plain text.  The config's output.gzip opts in.
  const useGzip = plan.output.gzip === true;

  log(`m3u: ${plan.sources.length} source(s), ${plan.want.length} want pattern(s), style=${plan.style}`);

  // --m3u-list / --m3u-dry-run: resolve and report, but touch no network and
  // write no file.
  if (values['m3u-list'] || values['m3u-dry-run']) {
    for (const source of plan.sources) log(`  source ${source.id}: ${source.url}`);
    log(`  output: ${outputPath}`);
    if (values['m3u-list']) log(`  want: ${plan.want.join(', ') || '(all channels)'}`);
    log(values['m3u-dry-run'] ? 'm3u: dry run — nothing fetched, nothing written' : 'm3u: plan resolved');
    return 0;
  }

  const result = await collectEntries({
    sources: plan.sources,
    log,
    politenessDelayMs: delayMs || 0,
    transportOptions,
    want: plan.want,
    exclude: plan.exclude,
    groupOverrides: plan.groupOverrides,
    identityOverrides: plan.identityOverrides,
    style: plan.style,
    stripQuality: plan.stripQuality,
    useYedek: plan.useYedek,
    dedupeIdenticalUrls: plan.dedupeIdenticalUrls,
    unifyGroups: plan.unifyGroups,
    unifyScheme: plan.unifyScheme,
    keepQuery: plan.keepQuery,
    inferTvgId: plan.inferTvgId,
    idSuffix: plan.idSuffix,
    maxCopies: plan.maxCopies,
    maxBytes: plan.maxBytes,
    cwd,
  });

  if (result.failures.length > 0 && result.failures.length === plan.sources.length) {
    fail(`all ${plan.sources.length} source(s) failed`);
    return 1;
  }
  if (result.conflicts.length > 0) {
    fail(`duplicate channels under style "fail": ${result.conflicts.join(', ')}`);
    return 1;
  }

  if (plan.live.enabled && result.entries.length > 0) {
    const { kept, dead } = await probeEntries(result.entries, {
      concurrency: plan.live.concurrency,
      timeoutMs: plan.live.timeoutMs,
      depth: plan.live.depth,
      retries: plan.live.retries,
      retryDelayMs: transportOptions.retryDelayMs,
    });
    // Either drop the failures or keep them and only report, depending on
    // --m3u-live vs --m3u-live-keep.  Both list every dead entry in the report,
    // so nothing ever disappears silently.
    result.deadEntries = dead;
    if (plan.live.keepFailed) {
      log(`live: ${dead.length} dead of ${result.entries.length} reported (kept in the playlist)`);
    } else {
      log(`live: ${dead.length} dead of ${result.entries.length} dropped`);
      result.entries = kept;
    }
  }

  if (result.entries.length === 0) {
    fail(
      result.unmatchedPatterns.length > 0
        ? `no channel matched: ${result.unmatchedPatterns.join(', ')}`
        : 'no channel matched'
    );
    return 1;
  }

  const written = await writeM3U(result, {
    outputPath,
    gzip: useGzip,
    keepAttributes: plan.keepAttributes,
    allowSharedIdentity: plan.style === 'none',
  });
  log(`m3u: wrote ${result.entries.length} entries -> ${outputPath}${useGzip ? '.gz' : ''} (${written.bytes} bytes)`);
  if (result.failures.length > 0) {
    log(`m3u: ${result.failures.length} source(s) failed during the run`);
  }

  if (values['m3u-report'] != null) {
    const reportPath = path.resolve(cwd, values['m3u-report']);
    fs.writeFileSync(reportPath, JSON.stringify(buildM3uReport(result), null, 2) + '\n');
    log(`m3u: report -> ${reportPath}`);
  }
  return 0;
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
    exclusiveChannels: context.exclusiveChannels === true,
  });
  const sourceCount = offline ? context.fromFiles.length : context.providers.length;
  const sourceNoun = offline ? 'file(s)' : 'provider(s)';
  context.log(
    `merge: ${merged.channels.length} channels, ${merged.programmes.length} programmes ` +
      `from ${sourceCount} ${sourceNoun}, ${merged.duplicates} duplicate programme(s) removed` +
      (merged.shadowed > 0 ? `, ${merged.shadowed} programme(s) shadowed by an earlier provider's channel` : '')
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

import { describe, it, expect } from 'vitest';
import {
  DELAY_FLAG,
  FLAG_VALIDATORS,
  MAX_CHANNELS_FLAG,
  MAX_WINDOW_DAYS,
  TRANSPORT_FLAGS,
  deriveFlags,
  firstFlagViolation,
  parseIntFlag,
  parseTransportOptions,
  splitList,
} from '../src/cli-flags.js';

// The table these tests exercise is the same one src/cli.js runs, so building a
// values bag here mirrors what parseArgs hands it.
const flags = (overrides = {}) => ({
  provider: 'hurriyet',
  'days-forward': '6',
  'days-back': '0',
  compare: false,
  merge: false,
  ...overrides,
});

describe('splitList', () => {
  it('trims and drops empty entries', () => {
    expect(splitList('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(splitList('  ')).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
    expect(splitList(null)).toEqual([]);
  });
});

describe('deriveFlags', () => {
  it('anchors the window on today when no date is given', () => {
    const derived = deriveFlags(flags());
    expect(derived.date).toBeNull();
    expect(Number.isNaN(derived.referenceDate.getTime())).toBe(false);
  });

  it('treats an empty --date as absent', () => {
    const derived = deriveFlags(flags({ date: '' }));
    expect(derived.date).toBeNull();
    expect(firstFlagViolation(flags({ date: '' }))).toBeNull();
  });

  it('parses the window and the provider list', () => {
    const derived = deriveFlags(flags({ 'days-forward': '2', 'days-back': '1', provider: 'a, b' }));
    expect(derived.daysForward).toBe(2);
    expect(derived.daysBack).toBe(1);
    expect(derived.providerIds).toEqual(['a', 'b']);
    expect(derived.fromFiles).toEqual([]);
  });
});

describe('firstFlagViolation', () => {
  it('passes a plain single-provider run', () => {
    expect(firstFlagViolation(flags())).toBeNull();
  });

  it('rejects a malformed date shape', () => {
    expect(firstFlagViolation(flags({ date: 'nope' }))).toBe(
      '--date expects YYYY-MM-DD, got "nope"'
    );
  });

  it('rejects dates the calendar does not have', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29']) {
      expect(firstFlagViolation(flags({ date })), date).toBe(`--date "${date}" is not a valid date`);
    }
  });

  it('accepts a leap day in a leap year', () => {
    expect(firstFlagViolation(flags({ date: '2028-02-29' }))).toBeNull();
  });

  it('bounds the window before it is materialized', () => {
    for (const bad of ['61', '-1', '1e21', 'abc']) {
      expect(firstFlagViolation(flags({ 'days-forward': bad })), bad).toBe(
        `--days-forward/--days-back expect integers between 0 and ${MAX_WINDOW_DAYS}`
      );
    }
    expect(firstFlagViolation(flags({ 'days-back': String(MAX_WINDOW_DAYS) }))).toBeNull();
  });

  it('rejects an empty provider list', () => {
    expect(firstFlagViolation(flags({ provider: ' , ' }))).toBe(
      '--provider expects at least one provider id'
    );
  });

  it('keeps --compare and --merge mutually exclusive', () => {
    expect(firstFlagViolation(flags({ compare: true, merge: true }))).toBe(
      '--compare and --merge cannot be combined'
    );
  });

  it('allows at most two providers with --compare', () => {
    expect(
      firstFlagViolation(flags({ compare: true, provider: 'a,b,c' }))
    ).toBe('--compare supports at most two providers');
    expect(firstFlagViolation(flags({ compare: true, provider: 'a,b' }))).toBeNull();
  });

  it('requires --merge or --compare for multiple providers', () => {
    const message =
      'multiple providers require --merge (combine into one guide) or --compare (diff the providers)';
    expect(firstFlagViolation(flags({ provider: 'a,b' }))).toBe(message);
    expect(firstFlagViolation(flags({ provider: 'a,b', merge: true }))).toBeNull();
    expect(firstFlagViolation(flags({ provider: 'a,b', compare: true }))).toBeNull();
  });

  it('requires --merge for --from, --exclusive-channels', () => {
    expect(firstFlagViolation(flags({ from: 'a.xml.gz' }))).toBe(
      '--from requires --merge (it merges already-scraped XMLTV files)'
    );
    expect(firstFlagViolation(flags({ 'exclusive-channels': true }))).toBe(
      '--exclusive-channels requires --merge (it only changes how providers are combined)'
    );
  });

  it('defers the --from complaints to --m3u, which reports them in one line', () => {
    const withPlaylist = { from: ' , ', m3u: 'm3u.config.json' };
    expect(firstFlagViolation(flags(withPlaylist))).toBeNull();
    expect(firstFlagViolation(flags({ ...withPlaylist, merge: true }))).toBeNull();
  });

  it('rejects --from with no usable file path', () => {
    expect(firstFlagViolation(flags({ merge: true, from: ' , ' }))).toBe(
      '--from expects at least one file path'
    );
  });

  it('reports the first failure when several flags are wrong', () => {
    // --date is checked before the window, so it wins.
    expect(
      firstFlagViolation(flags({ date: 'nope', 'days-forward': '999', compare: true, merge: true }))
    ).toBe('--date expects YYYY-MM-DD, got "nope"');
  });

  it('pins the order of adjacent checks, so a row cannot be reordered silently', () => {
    // Each case below violates exactly the two rules named in the comment, so
    // it fails if those two rows are ever swapped.
    const WINDOW = `--days-forward/--days-back expect integers between 0 and ${MAX_WINDOW_DAYS}`;
    const MULTI =
      'multiple providers require --merge (combine into one guide) or --compare (diff the providers)';
    const cases = [
      // the --date shape rule runs before the window rule.  (The shape rule and
      // the calendar rule are mutually exclusive -- a value cannot be both
      // wrongly shaped and a real calendar date -- so they are pinned against
      // later rows instead.)
      {
        first: '--date expects YYYY-MM-DD, got "nope"',
        second: WINDOW,
        overrides: { date: 'nope', 'days-forward': '999' },
      },
      // the --date calendar rule runs before the window rule
      {
        first: '--date "2026-02-30" is not a valid date',
        second: WINDOW,
        overrides: { date: '2026-02-30', 'days-forward': '999' },
      },
      // the window rule runs before the empty-provider rule
      {
        first: WINDOW,
        second: '--provider expects at least one provider id',
        overrides: { 'days-forward': '999', provider: ' , ' },
      },
      // compare+merge runs before the --compare arity rule
      {
        first: '--compare and --merge cannot be combined',
        second: '--compare supports at most two providers',
        overrides: { compare: true, merge: true, provider: 'a,b,c' },
      },
      // the --compare arity rule runs before the multiple-providers rule
      {
        first: '--compare supports at most two providers',
        second: MULTI,
        overrides: { compare: true, provider: 'a,b,c' },
      },
      // --from's --merge requirement runs before its empty-list complaint
      {
        first: '--from requires --merge (it merges already-scraped XMLTV files)',
        second: '--from expects at least one file path',
        overrides: { from: ' , ' },
      },
    ];
    for (const { first, second, overrides } of cases) {
      const actual = firstFlagViolation(flags(overrides));
      expect(actual, first).toBe(first);
      // Both messages must be ones this table really produces, so the test
      // cannot pass by comparing against a typo.
      const messages = FLAG_VALIDATORS.map((rule) => rule.message({ values: flags(overrides), derived: deriveFlags(flags(overrides)) }));
      expect(messages, second).toContain(second);
    }
  });

  it('every message is produced without throwing, for any values bag', () => {
    const bags = [
      flags(),
      flags({ date: 'nope' }),
      flags({ provider: '' }),
      flags({ from: 'a' }),
      flags({ m3u: 'c.json', from: 'a' }),
      flags({ 'days-forward': 'x' }),
    ];
    for (const values of bags) {
      expect(() => firstFlagViolation(values)).not.toThrow();
    }
  });

  it('declares the checks it advertises', () => {
    expect(FLAG_VALIDATORS.length).toBeGreaterThan(0);
    for (const { when, message } of FLAG_VALIDATORS) {
      expect(typeof when).toBe('function');
      expect(typeof message).toBe('function');
    }
  });
});

describe('parseIntFlag', () => {
  it('returns undefined when the flag was not passed', () => {
    expect(parseIntFlag(undefined, DELAY_FLAG)).toBeUndefined();
    expect(parseIntFlag(null, DELAY_FLAG)).toBeUndefined();
    expect(parseIntFlag(undefined, MAX_CHANNELS_FLAG)).toBeUndefined();
  });

  it('accepts values at or above the declared minimum', () => {
    expect(parseIntFlag('0', DELAY_FLAG)).toBe(0);
    expect(parseIntFlag('250', DELAY_FLAG)).toBe(250);
    expect(parseIntFlag('1', MAX_CHANNELS_FLAG)).toBe(1);
  });

  it('rejects values below the minimum and non-integers', () => {
    for (const bad of ['-1', 'abc', '1.5', 'NaN']) {
      expect(parseIntFlag(bad, DELAY_FLAG), bad).toBeNull();
    }
    expect(parseIntFlag('0', MAX_CHANNELS_FLAG)).toBeNull();
  });
});

describe('parseTransportOptions', () => {
  it('is empty when no transport flag was passed', () => {
    expect(parseTransportOptions(flags(), () => {})).toEqual({});
  });

  it('maps each flag onto its transport key', () => {
    const options = parseTransportOptions(
      flags({ retries: '3', 'timeout-ms': '5000', 'retry-delay-ms': '250' }),
      () => {}
    );
    expect(options).toEqual({ retries: 3, timeoutMs: 5000, retryDelayMs: 250 });
  });

  it('reports the offending flag and returns null', () => {
    const errors = [];
    expect(
      parseTransportOptions(flags({ retries: 'x', 'timeout-ms': '0' }), (m) => errors.push(m))
    ).toBeNull();
    // The first invalid flag in declaration order wins.
    expect(errors).toEqual(['--retries expects a non-negative integer (retry attempts per request)']);
  });

  it('requires a positive timeout', () => {
    const errors = [];
    expect(parseTransportOptions(flags({ 'timeout-ms': '0' }), (m) => errors.push(m))).toBeNull();
    expect(errors).toEqual(['--timeout-ms expects a positive integer (milliseconds)']);
  });

  it('declares every transport flag it maps', () => {
    expect(TRANSPORT_FLAGS.map((f) => f.flag)).toEqual([
      'retries',
      'timeout-ms',
      'retry-delay-ms',
    ]);
  });
});

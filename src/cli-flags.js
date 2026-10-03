// Flag parsing and validation for the CLI, kept pure so it can be reasoned
// about (and tested) without any I/O.  `runCli` in src/cli.js owns the ordering
// of the lifecycle around these helpers; this module only answers two
// questions: what did the user ask for, and is that request well-formed?

import { isRealCalendarDate } from './time.js';

// A hostile or typo'd window (1e9, 1e21) must be rejected before
// buildDateRange() materializes it as a date array (hang/OOM), not after.
export const MAX_WINDOW_DAYS = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Split a comma-separated flag value into trimmed, non-empty parts.  Used for
// --provider and --from, and for the --m3u list flags.
export function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// `YYYY-MM-DD` that also names a day the calendar actually has.  Feb 30, month
// 13 and day 32 all match the shape but would be rolled over into a different
// day by a lenient Date parser, so they are rejected here instead.
function isRealIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return isRealCalendarDate(year, month, day);
}

const isWindowDays = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_WINDOW_DAYS;

// The values every validator and the mode handlers need, computed once from
// the raw `parseArgs` bag so no step re-parses a flag.  `--date=` (an empty
// string) counts as absent, exactly as the truthiness checks it replaces did.
export function deriveFlags(values) {
  const date = values.date ? values.date : null;
  return {
    date,
    referenceDate: date == null ? new Date() : new Date(`${date}T12:00:00Z`),
    daysForward: Number(values['days-forward']),
    daysBack: Number(values['days-back']),
    providerIds: splitList(values.provider),
    // Offline merge inputs: `--merge --from a.xml.gz,b.xml.gz` reuses
    // already-scraped guides instead of hitting live servers.
    fromFiles: values.from == null ? [] : splitList(values.from),
  };
}

// Ordered flag checks, evaluated top to bottom: the first predicate that holds
// is the one the CLI reports, so a run with several mistakes complains about
// the same flag it always did.  Adding a check is one row here.
export const FLAG_VALIDATORS = [
  {
    when: ({ derived }) => derived.date != null && !ISO_DATE.test(derived.date),
    message: ({ derived }) => `--date expects YYYY-MM-DD, got "${derived.date}"`,
  },
  {
    // Impossible calendar dates that only a real-calendar check catches.
    when: ({ derived }) => derived.date != null && !isRealIsoDate(derived.date),
    message: ({ derived }) => `--date "${derived.date}" is not a valid date`,
  },
  {
    when: ({ derived }) => !isWindowDays(derived.daysForward) || !isWindowDays(derived.daysBack),
    message: () => `--days-forward/--days-back expect integers between 0 and ${MAX_WINDOW_DAYS}`,
  },
  {
    // Belt and braces on the anchor itself.  The two checks above already
    // reject anything unparseable, so this only fires if a future change lets
    // an unvalidated date reach the anchor.
    when: ({ derived }) => Number.isNaN(derived.referenceDate.getTime()),
    message: ({ derived }) => `--date "${derived.date}" is not a valid date`,
  },
  {
    when: ({ derived }) => derived.providerIds.length === 0,
    message: () => '--provider expects at least one provider id',
  },
  {
    when: ({ values }) => values.compare && values.merge,
    message: () => '--compare and --merge cannot be combined',
  },
  {
    when: ({ values, derived }) => values.compare && derived.providerIds.length > 2,
    message: () => '--compare supports at most two providers',
  },
  {
    when: ({ values, derived }) =>
      derived.providerIds.length > 1 && !values.merge && !values.compare,
    message: () =>
      'multiple providers require --merge (combine into one guide) or --compare (diff the providers)',
  },
  {
    // `--m3u` reports every mutually exclusive flag in one line further down, so
    // defer to it here rather than emitting a second, narrower complaint first.
    when: ({ values }) => values.from != null && !values.merge && values.m3u == null,
    message: () => '--from requires --merge (it merges already-scraped XMLTV files)',
  },
  {
    when: ({ values, derived }) =>
      values.from != null && values.m3u == null && derived.fromFiles.length === 0,
    message: () => '--from expects at least one file path',
  },
  {
    when: ({ values }) =>
      values['exclusive-channels'] && !values.merge && values.m3u == null,
    message: () =>
      '--exclusive-channels requires --merge (it only changes how providers are combined)',
  },
];

// The first flag error, or null when the request is well-formed.  Callers report
// the message and exit 1; this module never writes anywhere.
export function firstFlagViolation(values, derived = deriveFlags(values)) {
  const context = { values, derived };
  for (const { when, message } of FLAG_VALIDATORS) {
    if (when(context)) return message(context);
  }
  return null;
}

// ---- Numeric flags ----
//
// Each is described once here and consumed by the mode handlers, so the flag's
// range and its complaint can never drift apart.  `min` is inclusive; these
// flags deliberately have no upper bound, because the work they bound is
// already rate-limited or capped downstream.
export const DELAY_FLAG = {
  min: 0,
  message: '--delay-ms expects a non-negative integer (milliseconds)',
};

export const MAX_CHANNELS_FLAG = {
  min: 1,
  message: '--max-channels expects a positive integer',
};

export const TRANSPORT_FLAGS = [
  {
    flag: 'retries',
    key: 'retries',
    min: 0,
    message: '--retries expects a non-negative integer (retry attempts per request)',
  },
  {
    flag: 'timeout-ms',
    key: 'timeoutMs',
    min: 1,
    message: '--timeout-ms expects a positive integer (milliseconds)',
  },
  {
    flag: 'retry-delay-ms',
    key: 'retryDelayMs',
    min: 0,
    message: '--retry-delay-ms expects a non-negative integer (milliseconds)',
  },
];

// One integer flag: undefined when the flag was absent (the caller keeps its
// default), the parsed value when it is in range, or null when it is not.
export function parseIntFlag(value, { min, message }) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) return null;
  return parsed;
}

// `--retries` / `--timeout-ms` / `--retry-delay-ms` as the options object every
// provider forwards to the transport layer.  Reports the offending flag and
// returns null when one is invalid; the caller must then exit 1.
export function parseTransportOptions(values, fail) {
  const options = {};
  for (const { flag, key, min, message } of TRANSPORT_FLAGS) {
    const parsed = parseIntFlag(values[flag], { min, message });
    if (parsed === null) {
      fail(message);
      return null;
    }
    if (parsed !== undefined) options[key] = parsed;
  }
  return options;
}

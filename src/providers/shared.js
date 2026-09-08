// Shared helpers for provider adapters.  Every provider needs the same
// plumbing — channel-key normalization, wall-clock conversion, week math,
// date validation, dedupe/sort — so it lives here once instead of being
// copy-pasted per provider.  Nothing in this module does I/O; the transport
// (fetch) stays in src/http.js and the scraping loops stay in the provider
// files.

// ---- Wall-clock <-> ISO conversion (fixed +03:00, Turkey) ----

// Wall-clock date (Y/M/D in Istanbul) + minutes since day start -> ISO instant
// stamped with the fixed +03:00 offset.  Minutes >= 1440 (slots crossing
// midnight) roll into the next day via Date.UTC overflow; negative minutes
// roll back into the previous day.  Callers MUST pre-validate the calendar
// date (see isRealCalendarDate) — Date.UTC silently normalizes overflow.
export function wallToIso(year, month, day, minutes) {
  const ms = Date.UTC(year, month - 1, day, 0, minutes);
  return new Date(ms).toISOString().slice(0, 19) + '+03:00';
}

// True when (year, month, day) is a real calendar date.  Date.UTC silently
// normalizes overflow (month 13, Feb 30, day 32), so validate with a
// round-trip comparison before converting with wallToIso — otherwise a
// hostile "Feb 30" would silently land on March 2.
export function isRealCalendarDate(year, month, day) {
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() + 1 === month &&
    check.getUTCDate() === day
  );
}

// ---- Week math (Mon..Sun week-publishing providers) ----

// Monday..Sunday (wall dates, YYYY-MM-DD) of the week containing the
// reference date (default: now, Istanbul wall time).
export function weekDays(referenceDate = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const anchor = fmt.format(referenceDate); // YYYY-MM-DD
  const base = new Date(`${anchor}T12:00:00Z`);
  const monday = new Date(base.getTime() - ((base.getUTCDay() + 6) % 7) * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(monday.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

// Weekday tag index for a YYYY-MM-DD date: Monday=0..Sunday=6.  Providers
// index their own tag tables (DAY_SLUGS / DAY_TAGS) with this.
export function weekdayIndex(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

// ---- Channel-key normalization ----

// Display names vary in case/spacing between sites; keys are compared
// normalized (uppercase, whitespace collapsed).
export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

// ---- Date window helpers ----

// The date window a provider should cover when the CLI passes none:
// today in Istanbul (UTC+3 year-round), as YYYY-MM-DD.
export function defaultDates() {
  return [new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)];
}

// YYYY-MM-DD -> { year, month, day } numbers.
export function splitDate(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return { year, month, day };
}

// ---- Result finishing (dedupe + canonical order + summary log) ----

// Dedupe exact (channel, start, stop, title) repeats, keep first — the
// same slot scraped twice (overlapping windows, repeated pages) must not
// produce duplicate <programme> entries.
export function dedupeProgrammes(programmes) {
  const seen = new Set();
  const out = [];
  for (const p of programmes) {
    const key = [p.channel, p.start, p.stop, p.title].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Canonical result ordering: by channel (codepoint order) then start
// (ISO string order).  Mutates and returns the array, like Array#sort.
export function sortProgrammes(programmes) {
  return programmes.sort(
    (a, b) => a.channel.localeCompare(b.channel) || a.start.localeCompare(b.start)
  );
}

// Finish a scrape result: dedupe, sort into the canonical order, log the
// summary line and shape the object every provider returns.
export function finishResult({ channels, programmes, days, failures, log = () => {} }) {
  const deduped = sortProgrammes(dedupeProgrammes(programmes));
  log(
    `done:  ${channels.length} channels, ${deduped.length} programmes, ` +
      `${failures} failed request(s)`
  );
  return { channels, programmes: deduped, days, failures };
}

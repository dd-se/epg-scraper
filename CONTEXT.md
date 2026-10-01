# EPG Scraping

The project turns heterogeneous television-guide sources into reusable XMLTV guides while preserving source identity, timing, and programme precedence.

## Language

**Provider Adapter**:
A source-specific guide producer that owns one television guide site's channel lineup, schedule interpretation, and transport protocol.
_Avoid_: Scraper implementation, source connector

**Guide**:
A normalized collection of channels and programme slots suitable for comparison, merge, reuse, or XMLTV output.
_Avoid_: Result object, XML string

**Programme Slot**:
One time-bounded listing on a channel, carrying a title and optional subtitle, description, category, or image.
_Avoid_: Programme record, event

**Channel Identity**:
The stable XMLTV channel id used to recognize the same television feed across provider names and guide sources.
_Avoid_: Channel name, slug

**Guide Window**:
The ordered set of calendar dates a provider run is expected to cover.
_Avoid_: Date range, scrape period

**Source Wall Time**:
The date and clock time displayed by a provider before it is attached to the guide's correct UTC offset.
_Avoid_: Programme start, UTC instant

**Programme Instant**:
The absolute point in time identified by a programme slot's offset-bearing start or stop timestamp.
_Avoid_: Wall timestamp, XMLTV text

**Merge Precedence**:
The provider or input-file order that decides which value wins when merged guides disagree about a channel or programme slot.
_Avoid_: Source priority, winner order

**Guide Language**:
The language tag applied to a guide's human-readable channel and programme text.
_Avoid_: Locale setting, country code

**Provider Inventory**:
The authoritative lineup of provider registrations, reference coverage, scheduled jobs, and guide merge profiles.
_Avoid_: Provider list, CI matrix

## Playlist language (`--m3u`)

**Playlist Entry**:
One `#EXTINF` line plus its stream URL as published by an M3U source. An entry
is *not* a channel: the same channel is usually published by several sources and
under several decorated names.
_Avoid_: Channel, programme

**Channel Group**:
The set of playlist entries recognized as one channel, formed by union-find
over the union of their normalized attribute keys (`tvg-id`, `tvg-name`, the
resolution-stripped display name, the quality-stripped display name).
_Avoid_: Playlist entry, dedupe group

**Feed Identity**:
The normalized stream URL that decides whether two entries in one channel group
are the *same* feed (and must therefore collapse) or genuinely different
alternates (and must therefore be renamed).
_Avoid_: URL, channel id

**Naming Style**:
The rule that gives a channel's first copy its base name and its further copies
distinguishable suffixes — `numbered` (`ATV B2`), `backup` (`ATV Backup`,
default), `source`, `keep-first`, `fail`.
_Avoid_: Suffix scheme, rename policy

**Edition**:
A distinct channel that shares a base name with another (`ATV Alanya` vs `ATV`,
`TRT 4K` vs `TRT 1`). Editions are never folded into their base channel and
never pulled in by a base-channel request.
_Avoid_: Variant, regional copy

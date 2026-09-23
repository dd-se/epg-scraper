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

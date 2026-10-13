# Align guide channel ids with playlist channel ids

## Problem Statement

A consumer of the published output holds two things for a channel: the playlist
entry (`tvg-id` + `tvg-name`) and the XMLTV guide (`<channel id>` +
`<display-name>`). After the channel-id format change, most of them agree
automatically — 26 of the 41 curated playlist ids now equal a curated guide id
case-insensitively, because both sides run through the same folding rule
(`TRTCOCUK.tr` ↔ `trtcocuk.tr`, `24TV.tr` ↔ `24tv.tr`).

Eleven do not, and three of those are the guides' fault rather than the
playlist's:

- The FOX/NOW rebrand left `FOX.tr` as a guide id while the channel is NOW and
  every playlist row calls it `NOW` / `nowtv.tr`. The live sources no longer
  carry a `FOX` row at all.
- `S Sport 1` is `SSport.tr` in the guide and `ssport1.tr` in the playlist, and
  it is inconsistent with its own sibling `S Sport 2` (`SSport2.tr`) and with
  `S Sport Plus` (`SSPORTPLUS.tr`).
- `Eurosport 1` is `EUROSPORT1HD.tr` in three guides — the `HD` qualifier is the
  only difference from the playlist's `eurosport1.tr` — and `Eurosport 2` is
  `EUROSPORT2TRHD.tr` beside it.

A name-keyed consumer still finds these three (the names match: `NOW`, `S Sport
1`, `Eurosport 1`), but an id-keyed consumer sees two unrelated channels, and
the drift is invisible because nothing asserts the two namespaces agree.

Separately, the playlist ships a catalog entry for `FOX` that matches no channel
upstream any more, and eleven catalog channels that no guide serves at all —
their absence from the guides is a fact nobody has written down.

## Solution

Rename the three guide ids so each matches the channel's current canonical name
(drop the rebrand and the `HD` qualifiers, use one spelling for S Sport), drop
the dead `FOX` catalog entry, and then make the agreement machine-checked: one
test asserts every curated playlist id equals a curated guide id, with an
explicit, reasoned exception list for the channels no guide serves.

Separately and without changing anything, probe the guides for the eleven
playlist channels that currently have no guide id and write down what each
provider actually serves, so a later change can be made from evidence rather
than from the assumption that they are gaps.

## User Stories

1. As an IPTV client that joins playlist and guide by `tvg-id`, I want the two
   ids to be the same string for a channel, so that a channel selected in the
   playlist shows its programme guide.
2. As an IPTV client that joins playlist and guide by channel name, I want the
   names to stay unchanged by this work, so that the joins that already work
   keep working.
3. As a viewer of the NOW channel, I want its guide to be reachable under the id
   my playlist publishes (`nowtv.tr`), so that the rebrand does not leave the
   channel and its guide as two separate things.
4. As a viewer of S Sport 1, I want its guide id to match the playlist's
   `ssport1.tr`, so that it is not a channel only in one of the two outputs.
5. As a viewer of S Sport 2, I want its guide id to follow the same spelling as
   S Sport 1, so that the S Sport family is internally consistent.
6. As a viewer of Eurosport 1, I want its guide id to match the playlist's
   `eurosport1.tr`, so that the `HD` qualifier does not split the channel.
7. As a viewer of Eurosport 2, I want its guide id to follow the same spelling as
   Eurosport 1, so that the Eurosport pair is internally consistent.
8. As a maintainer, I want the S Sport ids to be all-caps, so that
   `SSPORT1.tr`/`SSPORT2.tr` match the existing `SSPORTPLUS.tr` and the only
   deliberate mixed-case exception left in the guides is the `beIN` brand token.
9. As a maintainer, I want the dead `FOX` playlist catalog entry removed, so that
   the catalog does not advertise a channel no source serves.
10. As a maintainer, I want a test that fails when a playlist id has no
    corresponding guide id, so that this class of drift cannot reappear silently.
11. As a maintainer, I want the channels that intentionally have no guide id to
    be listed in the test with a reason each, so that the exception list is a
    decision on record rather than a gap in a list.
12. As a maintainer, I want to add a new playlist catalog channel and be told
    immediately when no guide serves it, so that the decision to ship it is
    mine and is written down.
13. As a maintainer adding a new provider, I want the existing catalog-wide
    checks (every curated guide id is canonical; no two fold together) to keep
    running, so that renaming ids cannot silently collide two channels.
14. As a maintainer, I want the old-to-new id mapping recorded in the changelog,
    so that anyone pinned to a pre-rename id can re-map in one step.
15. As a maintainer, I want all of this to land in the same unreleased version as
    the channel-id format change, so that consumers see one breaking release
    rather than two.
16. As a maintainer, I want the Swedish guide ids untouched, so that renaming
    Turkish ids does not disturb the source-tagged `.se` ids.
17. As a maintainer, I want the playlist `tvg-id` values themselves unchanged in
    this work, so that viewers who stored an id keep it.
18. As a maintainer, I want a written finding for each playlist channel that has
    no guide id today, so that a later decision to drop or serve it is made from
    evidence.
19. As a maintainer, I want the research phase to change no ids, remove no
    catalog entries, and alter no published output, so that it is safe to run and
    easy to review.
20. As a maintainer, I want to see which providers serve each researched channel
    (and which do not), so that I know whether a new provider could serve it.
21. As a maintainer, I want the sports-channel coverage count assertion to stay at
    38, so that a rename cannot quietly change which feeds the sports merge
    publishes.
22. As a maintainer, I want the regenerated merged guide verified to contain only
    canonical ids, so that the live output matches the format the writer
    enforces.
23. As a maintainer, I want the regenerated playlist compared to the previous one
    so that only the intended channel disappears, so that an unintended change in
    the published playlist is caught.

## Implementation Decisions

- The guide is the side that changes. Three guide ids are renamed; no playlist
  id changes (one dead entry is removed).
  - The FOX/NOW guide id becomes `NOWTV.tr`, matching the playlist's `nowtv.tr`
    and the channel's current name. The FOX feed is a rebrand, not a separate
    channel; keeping `FOX.tr` would keep a name no source publishes.
  - `SSport.tr` becomes `SSPORT1.tr` and `SSport2.tr` becomes `SSPORT2.tr`
    (all-caps, matching `SSPORTPLUS.tr`), matching playlist ids `ssport1.tr`.
  - `EUROSPORT1HD.tr` becomes `EUROSPORT1.tr` and `EUROSPORT2TRHD.tr` becomes
    `EUROSPORT2.tr` across every provider that serves them, matching playlist id
    `eurosport1.tr`.
  - Each rename is applied to every provider that carries the id, so the guides
    stay in agreement with each other (three providers currently share the
    Eurosport ids).
- Renaming does not change the folding rule or the canonical-form check: all
  three new ids are already canonical, and the writer's refusal of a
  non-canonical id is unchanged.
- Swedish `.se` ids are untouched; they are exempt from the rule these renames
  serve, and the `.se` guide never merges with a `.tr` guide.
- The playlist `tvg-id` namespace stays lowercase and independent of the guide
  ids; agreement is case-insensitive, which is how a consumer folds both sides.
- The `FOX` catalog entry is deleted: the live sources carry no `FOX` row, so
  the pattern matches nothing and only produces an "unmatched pattern" warning.
- The playlist↔guide agreement assertion lives in the existing channel-id
  contract suite (the guide-side suite that already owns the catalog-wide
  curated-id checks). It imports the playlist catalog one-way; the playlist
  module's rule of importing nothing from the guide pipeline is unaffected.
- Agreement is asserted over the curated guide ids of every Turkish provider,
  matched case-insensitively, and fails on the first playlist id with no guide
  counterpart unless that id is in an explicit exception map that carries a
  reason. The exception map is data beside the playlist catalog, not a comment.
- The exception list is expected to hold the channels no provider serves. Each
  entry states why, so a later removal of a provider forces a decision rather
  than a silent test failure.
- The S Sport and Eurosport renames also cover the sibling ids in the same
  provider tables (`S Sport 2`, `Eurosport 2`), because leaving them would keep
  the very inconsistency this work removes.
- The changelog records the format break and these renames in one unreleased
  entry, with the old-to-new mapping listed so a consumer can re-map in one
  step.
- Documentation that names ids by example is updated in the same change: the
  playlist catalog and rename-contract notes, the provider contract notes, and
  the coverage notes.
- The research phase produces a written finding per channel and changes nothing:
  no id rename, no catalog removal, no change to published output.

## Testing Decisions

- One good test asserts only externally visible behavior: the ids that appear in
  a guide and in a playlist, and the set relationship between them. No test
  inspects how the fold is implemented or how a map is keyed.
- The renames are proven by the existing provider suites, which already assert
  the curated ids each provider emits for a display name (hurriyet, mynet,
  tvplus). Those assertions change to the new ids; no new provider test is
  written.
- The agreement test is the new behavior worth testing. It is a catalog-wide
  assertion in the same style as the existing "every curated id is canonical"
  and "no two curated ids fold together" checks, and it is expected to fail
  loudly when a catalog entry is added whose guide counterpart does not exist.
- Prior art: the catalog-wide curated-id assertions in the channel-id contract
  suite, and the merge/compare suites' assertions that a shipped alias map
  collapses two spellings onto one channel.
- The research phase has no test by design; its output is a document, and it must
  not change any behavior the suite can see.
- The full suite must be green before the change is considered done; the live
  scrapes are a manual verification step, not a test.

## Out of Scope

- Changing the folding rule, the canonical-form check, or the writer's refusal of
  a non-canonical id.
- Changing the channel-id format itself (that landed in the same unreleased
  version and is already specified).
- Changing any playlist `tvg-id` that already matches a guide id.
- Altering Swedish `.se` ids or the Swedish guide.
- Renaming or removing any of the eleven playlist channels that no guide serves;
  the research phase only writes down what is true about them.
- Adding guide coverage for a channel that currently has none (no new provider,
  no new adapter work).
- Changing the alias-map feature or the shipped alias map.
- Publishing a release, tagging, or pushing.

## Further Notes

- Nothing has been published from the current version, so all three guide
  renames ship inside the one unreleased breaking release together with the
  channel-id format change. Consumers re-map once.
- The live run that prompted this work showed seventeen playlist catalog patterns
  matching no channel, including `FOX`; the eleven "no guide id" channels named
  above are a separate question (the catalog entry exists and the sources carry
  the channel) and are what the research phase is about.
- The rename touches the two providers that serve S Sport and the three that
  serve Eurosport, so a merge of any of them must be re-verified rather than
  assumed.

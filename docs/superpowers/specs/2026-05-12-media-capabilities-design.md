# Media capabilities probing — design

## Problem

cmaf-lite currently builds the playable `Stream[]` view of a manifest
without verifying the device can decode each representation. An
unplayable codec only surfaces when the buffer controller calls
`addSourceBuffer()` with the resulting content type — late, opaque,
and fatal even when other representations in the manifest are
perfectly playable.

There is also no machinery in place to support future capability-
aware decisions (ABR smoothness bias, power-efficient bias,
HDR/DRM fallback). Those need per-representation capability data
attached to the stream model.

## Goal

Probe every video and audio `Stream` against
`navigator.mediaCapabilities.decodingInfo()` at the moment it's
projected from the manifest, drop representations the device can't
decode from the playable view, and attach the full
`MediaCapabilitiesDecodingInfo` result to the surviving streams so
future features (ABR, DRM, HDR) can read it without re-probing.

## Non-goals

- ABR smoothness/power bias (uses the data this design exposes,
  but lives in the ABR controller).
- Initial switching-set selection across codec families.
- HDR variant probing (`hdrMetadataType`, `transferFunction`).
- DRM key-system probing (`keySystemConfiguration`,
  `keySystemAccess`) — the storage shape supports it, but no
  caller asks for it yet.
- Subtitle capability checks — `decodingInfo` doesn't cover
  `wvtt`/`stpp`, and the parser already filters unknown codecs.
- Mutating the manifest. The manifest stays a faithful description
  of what was authored; capability filtering only affects the
  derived `Stream[]` view.

## Design

### Where it runs

Inside `buildStreams` in `lib/utils/stream_utils.ts`. `buildStreams`
is the only place a `Stream` is born from the manifest, so probing
there means every video/audio `Stream` carries decoding info by
construction. `buildStreams` becomes `async`.

`StreamController.onManifestUpdated_` (the sole caller) awaits the
result. This adds one `await` between `MANIFEST_UPDATED` and the
controller acting on the new manifest — negligible for VOD; for
live, well inside the manifest refresh interval.

`ManifestController` is unchanged.

### The symbol

In `lib/constants.ts`:

```ts
export const PROP_DECODING_INFO = Symbol("decodingInfo");
```

In `lib/types/media.ts`, attach to video and audio streams only
(subtitles are excluded — see Non-goals):

```ts
export interface VideoStream extends BaseStream {
  type: MediaType.VIDEO;
  width: number;
  height: number;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.VIDEO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
}

export interface AudioStream extends BaseStream {
  type: MediaType.AUDIO;
  language: string;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.AUDIO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
}
```

`MediaCapabilitiesDecodingInfo` is the native lib.dom type:
`{ supported, smooth, powerEfficient, keySystemAccess? }`. We store
the whole object — `keySystemAccess` will be `undefined` until DRM
probing is added, but the storage shape doesn't need to change.

The symbol is **not** exported from the package entry. It's an
internal back-channel for controllers (ABR in particular).

### Stream projection

`projectStream` gains an optional third parameter:

```ts
function projectStream(
  ss: SwitchingSet,
  track: Track,
  info?: MediaCapabilitiesDecodingInfo,
): Stream
```

The video and audio branches attach `info` to the literal directly
(no placeholder, no cast). The subtitle branch ignores it.
`projectStream` asserts `info` is present in the video/audio
branches so the type stays honest at the symbol assignment site.

`buildStreams` calls `projectStream(ss, track, info)` after the
probe resolves, so the assertion always holds by construction.

### `buildStreams` flow

```
async function buildStreams(manifest):
  candidates = []           # { ss, track, type } tuples
  subtitleStreams = []      # passed through untouched

  for ss in manifest.switchingSets:
    for track in ss.tracks:
      if track.type == SUBTITLE:
        subtitleStreams.push(projectSubtitle(ss, track))
      else:
        candidates.push({ ss, track })

  decodingInfos = await Promise.all(
    candidates.map(c => probe(c.ss, c.track))
  )

  result = { VIDEO: [], AUDIO: [], SUBTITLE: subtitleStreams }
  for (candidate, info) in zip(candidates, decodingInfos):
    if !info.supported: continue
    stream = projectStream(candidate.ss, candidate.track)
    stream[PROP_DECODING_INFO] = info
    result[stream.type].push(stream)

  sort each list by bandwidth ascending
  return result
```

If, after filtering, a media type ends up with zero streams, the
list is simply empty. No error is raised here — surfacing
"manifest entirely unplayable" is deferred to a later iteration.

### Probe cache

A module-level `WeakMap<Track, Promise<MediaCapabilitiesDecodingInfo>>`
in `stream_utils.ts`. `Track` is the natural key: it's stable
across live manifest updates (the parser updates tracks in place,
per the manifest-apply work) and a single `Track` corresponds to a
single probe input (its `bandwidth`, `width`, `height`, plus the
parent `SwitchingSet.codec`).

Caching the `Promise` (not the resolved value) deduplicates
concurrent probes. Entries are reclaimed automatically when a
`Track` is dropped from the manifest and becomes unreachable, so
no explicit invalidation, no module-lifetime concerns, no
test-only reset helper.

Two distinct Tracks with identical probe inputs each get their own
probe — wasted call, not a correctness issue, and manifests don't
duplicate representations like that in practice.

No invalidation. Device capabilities don't change within a session.

### Building the configuration

Per stream:

```ts
// Video
{
  type: "media-source",
  video: {
    contentType: `video/mp4; codecs="${codec}"`,
    width: track.width,
    height: track.height,
    bitrate: track.bandwidth,
    framerate: 30, // see below
  },
}

// Audio
{
  type: "media-source",
  audio: {
    contentType: `audio/mp4; codecs="${codec}"`,
    bitrate: track.bandwidth,
    channels: "2",      // see below
    samplerate: 48000,  // see below
  },
}
```

`codec` is the normalized codec from
`CodecUtils.getNormalizedCodec(ss.codec)` — same as `projectStream`
uses. `getContentType()` already produces the
`video/mp4; codecs="..."` form.

Framerate, channels, and samplerate are required by the spec but
the parser doesn't extract them today. Use sane defaults
(30 / "2" / 48000) — they're good enough for `supported`
determination, which is all this iteration consumes. Surfacing
real values is tracked as follow-up when ABR starts reading
`smooth`.

### Browser support

`navigator.mediaCapabilities.decodingInfo` is assumed available.
All evergreen browsers that support MSE also expose MCAP; no
fallback path is implemented.

## Testing

Extend `test/utils/stream_utils.test.ts`:

- Stub `navigator.mediaCapabilities.decodingInfo` per case.
- Build manifests via `test/__framework__/factories.ts`.
- Cases:
  - All streams supported → all streams kept, each carries
    `PROP_DECODING_INFO`.
  - Mixed support within a switching set → unsupported streams
    excluded from the flat list, supported ones kept.
  - Entire switching set unsupported → its streams absent; flat
    list still non-empty from other sets.
  - All video tracks unsupported → video list is empty, no throw.
  - All audio tracks unsupported → audio list is empty, no throw.
  - Subtitle streams pass through untouched (no symbol, no probe
    call recorded).
  - Probe cache: same `Track` across two `buildStreams` calls →
    `decodingInfo` invoked once.

## Files touched

- `lib/constants.ts` — add `PROP_DECODING_INFO`.
- `lib/types/media.ts` — add the symbol to `VideoStream` and
  `AudioStream` interfaces.
- `lib/utils/stream_utils.ts` — `buildStreams` becomes async; add
  internal `probe` helper and module-level cache.
- `lib/media/stream_controller.ts` — `await` `buildStreams` in
  `onManifestUpdated_`.
- `test/utils/stream_utils.test.ts` — extend with capability cases.
- `test/__framework__/factories.ts` — extend stream factories to
  attach a synthesised `PROP_DECODING_INFO` by default, so
  unrelated tests building `VideoStream`/`AudioStream` literals
  via factories don't break.

## Risks

- **Existing tests:** every place that builds a `VideoStream` /
  `AudioStream` literal in tests now needs the symbol. Mitigated by
  funnelling construction through factories.
- **Async seam:** `buildStreams` returning a `Promise` ripples into
  `StreamController`. One call site, one `await` — small, but worth
  noting in the plan.
- **Spec defaults (framerate/channels/samplerate):** wrong values
  could cause `supported: false` on permissive browsers. Use the
  common-case defaults above; revisit when ABR consumes `smooth`.
- **Cache scoping:** the `WeakMap<Track, …>` is module-scoped, so
  it spans all players in the same JS realm. That's desirable —
  capabilities don't change in a session — and the WeakMap reclaims
  entries automatically as tracks become unreachable. Tests that
  need cache isolation construct fresh `Track` objects via
  factories rather than reaching into the cache.

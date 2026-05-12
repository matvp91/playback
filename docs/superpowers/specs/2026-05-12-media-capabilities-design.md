# Media capabilities probing — design

## Problem

cmaf-lite currently emits streams from the DASH parser straight into
the buffer and stream controllers without verifying the device can
decode them. An unplayable codec only surfaces when the buffer
controller calls `addSourceBuffer()` with the resulting content
type — late, opaque, and fatal even when other representations in
the manifest are perfectly playable.

There is also no machinery in place to support future capability-
aware decisions (ABR smoothness bias, power-efficient bias,
HDR/DRM fallback). Those need per-representation capability data
attached to the stream model.

## Goal

Probe every video and audio `Stream` against
`navigator.mediaCapabilities.decodingInfo()` once after parse, drop
representations the device can't decode, and attach the full
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

## Design

### Where it runs

A new step in the manifest pipeline, invoked by
`ManifestController.fetch_()` immediately after
`DashParser.create()` / `DashParser.update()` and before the
`MANIFEST_UPDATED` event is emitted. Implemented as
`lib/manifest/capability_probe.ts` exporting a single async function:

```ts
async function probe(manifest: Manifest): Promise<void>
```

The function mutates the manifest in place:

1. Collects every `VideoStream` and `AudioStream` reachable from
   the manifest.
2. Builds a `MediaDecodingConfiguration` per stream (see below).
3. Runs `Promise.all` over `decodingInfo()` calls.
4. Attaches the result via the new symbol on supported streams.
5. Cascade-removes unsupported streams, then empty switching sets,
   then empty tracks (see "Filtering").
6. Throws if a video or audio track is left empty after cascade —
   the manifest is unplayable.

Probe runs on both initial parse and live updates. Results are not
cached across updates: live updates can add representations, and
the cost of a few extra `decodingInfo` calls is negligible.

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
internal back-channel for controllers (ABR in particular). Apps
that need capability info later get a dedicated getter on `Player`.

### Building the configuration

Per stream:

```ts
// Video
{
  type: "media-source",
  video: {
    contentType: `video/mp4; codecs="${stream.codec}"`,
    width: stream.width,
    height: stream.height,
    bitrate: stream.bandwidth,
    framerate: 30, // see below
  },
}

// Audio
{
  type: "media-source",
  audio: {
    contentType: `audio/mp4; codecs="${stream.codec}"`,
    bitrate: stream.bandwidth,
    channels: "2",      // see below
    samplerate: 48000,  // see below
  },
}
```

Framerate, channels, and samplerate are required by the spec but
the parser doesn't extract them today. Use sane defaults
(30 / "2" / 48000) — they're good enough for `supported`
determination, which is all this iteration consumes. Surfacing
real values is tracked as follow-up when ABR starts reading
`smooth`.

`getContentType()` in `codec_utils.ts` already produces the
`video/mp4; codecs="..."` form — reuse it.

### Filtering cascade

After all probes resolve, walk the manifest:

```
for each period:
  for each track:
    for each switchingSet:
      switchingSet.streams = streams where supported === true
    track.switchingSets = sets with non-empty streams
  drop track if it has zero switching sets
fatal if any video or audio MediaType has zero tracks
```

The cascade is order-independent because each level filters its
direct children only. Subtitle tracks pass through unmodified.

The "fatal if empty" check throws a typed error
(`ManifestUnsupportedError` or similar — name TBD during impl, but
distinct from network errors). `ManifestController` surfaces it as
an error event the same way it would a fetch failure.

### Logging

One `log.info` at the end of probing summarising what was kept and
what was dropped, plus one `log.warn` per dropped stream with its
codec/resolution. Matches existing manifest-pipeline logging.

### Browsers without `mediaCapabilities`

Old browsers that lack `navigator.mediaCapabilities` — the probe
falls back to `MediaSource.isTypeSupported(getContentType(...))`
per stream and synthesises a minimal
`MediaCapabilitiesDecodingInfo` (`{ supported, smooth: false,
powerEfficient: false }`). Encoded once in
`capability_probe.ts`; consumers don't need to know.

## Testing

New test file `test/manifest/capability_probe.test.ts`:

- Probe stubs `navigator.mediaCapabilities.decodingInfo` per case.
- Builds manifests via `test/__framework__/factories.ts`.
- Cases:
  - All streams supported → manifest unchanged except for symbol.
  - Mixed support within a switching set → unsupported streams
    dropped, set kept.
  - Entire switching set unsupported → set dropped, track kept.
  - All sets in a track unsupported → track dropped.
  - All video tracks unsupported → throws.
  - Subtitle streams pass through untouched (no symbol, no probe).
  - Live update re-probes new representations.
  - Fallback path (no `mediaCapabilities`) produces synthesised
    result with `smooth: false`, `powerEfficient: false`.

## Files touched

- `lib/constants.ts` — add `PROP_DECODING_INFO`.
- `lib/types/media.ts` — add the symbol to `VideoStream` and
  `AudioStream` interfaces.
- `lib/manifest/capability_probe.ts` — new.
- `lib/manifest/manifest_controller.ts` — invoke probe between
  parse and `MANIFEST_UPDATED` emission.
- `test/manifest/capability_probe.test.ts` — new.
- `test/__framework__/factories.ts` — extend factories so test
  streams can be created already carrying a synthesised
  `PROP_DECODING_INFO` (so unrelated tests don't break).

## Risks

- **Existing tests:** every place that builds a `VideoStream` /
  `AudioStream` literal in tests now needs the symbol present.
  Mitigated by funnelling construction through factories.
- **Spec defaults (framerate/channels/samplerate):** wrong values
  could cause `supported: false` on permissive browsers. Use the
  common-case defaults above; revisit when ABR consumes `smooth`.
- **Async manifest pipeline:** adds one `await` between parse and
  `MANIFEST_UPDATED`. Negligible for VOD; for live, the manifest
  refresh interval already absorbs a few extra ms.

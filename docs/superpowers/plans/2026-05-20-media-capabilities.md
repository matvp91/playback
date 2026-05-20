# Media capabilities probing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Probe every video and audio `Stream` against `navigator.mediaCapabilities.decodingInfo()` when projecting from the manifest, drop unplayable streams from the playable view, and attach the full `MediaCapabilitiesDecodingInfo` to surviving streams via a non-exported symbol for future ABR/DRM/HDR consumers.

**Architecture:** A new `PROP_DECODING_INFO` symbol joins `PROP_HIERARCHY` on `VideoStream`/`AudioStream`. `buildStreams` becomes `async`. Per-track projection moves into an async `projectStream` that returns `Stream | null`; a `probeTrack` helper builds the right `MediaDecodingConfiguration` per track type and calls MCAP. `StreamController.onManifestUpdated_` awaits the result on initial manifests only — live refreshes reuse existing streams.

**Tech Stack:** TypeScript, Vitest with happy-dom, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-05-12-media-capabilities-design.md](../specs/2026-05-12-media-capabilities-design.md)

---

## File Structure

- `packages/cmaf-lite/lib/constants.ts` — add `PROP_DECODING_INFO` symbol.
- `packages/cmaf-lite/lib/types/media.ts` — add the symbol to `VideoStream` / `AudioStream` interfaces.
- `packages/cmaf-lite/lib/utils/stream_utils.ts` — `buildStreams` becomes async; `projectStream` becomes async and returns `Stream | null`; add internal `probeTrack` helper.
- `packages/cmaf-lite/lib/media/stream_controller.ts` — `onManifestUpdated_` awaits `buildStreams`.
- `packages/cmaf-lite/test/__framework__/factories.ts` — add `createDecodingInfo` helper and a `mockMediaCapabilities` test helper that stubs `navigator.mediaCapabilities.decodingInfo`.
- `packages/cmaf-lite/test/utils/stream_utils.test.ts` — update existing helpers to await `buildStreams`; add new capability cases.

---

### Task 1: Add `PROP_DECODING_INFO` symbol

**Files:**
- Modify: `packages/cmaf-lite/lib/constants.ts`

- [ ] **Step 1: Add the symbol export**

Append to [packages/cmaf-lite/lib/constants.ts](packages/cmaf-lite/lib/constants.ts):

```ts
export const PROP_DECODING_INFO = Symbol("decodingInfo");
```

- [ ] **Step 2: Verify the build compiles**

Run: `pnpm tsc`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/constants.ts
git commit -m "feat: Add PROP_DECODING_INFO symbol"
```

---

### Task 2: Attach `PROP_DECODING_INFO` to stream types

**Files:**
- Modify: `packages/cmaf-lite/lib/types/media.ts`

- [ ] **Step 1: Import the symbol and add it to `VideoStream` and `AudioStream`**

In [packages/cmaf-lite/lib/types/media.ts](packages/cmaf-lite/lib/types/media.ts):

Change the import:

```ts
import type { PROP_DECODING_INFO, PROP_HIERARCHY } from "../constants";
```

In `VideoStream`, add the new property:

```ts
export interface VideoStream extends BaseStream {
  type: MediaType.VIDEO;
  width: number;
  height: number;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.VIDEO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
}
```

In `AudioStream`, add the new property:

```ts
export interface AudioStream extends BaseStream {
  type: MediaType.AUDIO;
  language: string;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.AUDIO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
}
```

`SubtitleStream` is **not** modified.

- [ ] **Step 2: Verify the build fails meaningfully**

Run: `pnpm tsc`
Expected: FAIL — `projectStream` in `stream_utils.ts` returns objects missing `PROP_DECODING_INFO`. This confirms the next task is required.

- [ ] **Step 3: Do NOT commit yet**

The repo doesn't compile. Task 3 fixes it. We'll commit at the end of Task 3.

---

### Task 3: Make `buildStreams` async with MCAP probing

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts`

- [ ] **Step 1: Update imports**

In [packages/cmaf-lite/lib/utils/stream_utils.ts](packages/cmaf-lite/lib/utils/stream_utils.ts), change the imports to:

```ts
import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../constants";
import type { Manifest, SwitchingSet, Track } from "../types/manifest";
import type { Preference, Stream } from "../types/media";
import { MediaType } from "../types/media";
import * as asserts from "./asserts";
import * as CodecUtils from "./codec_utils";
```

- [ ] **Step 2: Replace `buildStreams` and `projectStream` with async versions, add `probeTrack`**

Replace the existing `buildStreams` and `projectStream` functions with:

```ts
export async function buildStreams(
  manifest: Manifest,
): Promise<Map<MediaType, Stream[]>> {
  const projections: Promise<Stream | null>[] = [];
  for (const ss of manifest.switchingSets) {
    for (const track of ss.tracks) {
      projections.push(projectStream(ss, track));
    }
  }
  const streams = (await Promise.all(projections)).filter(
    (s): s is Stream => s !== null,
  );

  const result = new Map<MediaType, Stream[]>([
    [MediaType.VIDEO, []],
    [MediaType.AUDIO, []],
    [MediaType.SUBTITLE, []],
  ]);
  for (const stream of streams) {
    const list = result.get(stream.type);
    asserts.assertExists(list, `No list for ${stream.type}`);
    list.push(stream);
  }
  // Sorted by bandwidth ascending — index 0 is lowest quality.
  // Required for ABR rules to reason about the quality ladder.
  for (const streams of result.values()) {
    streams.sort((a, b) => a.bandwidth - b.bandwidth);
  }
  return result;
}

async function projectStream(
  ss: SwitchingSet,
  track: Track,
): Promise<Stream | null> {
  const codec = CodecUtils.getNormalizedCodec(ss.codec);
  if (track.type === MediaType.VIDEO && ss.type === MediaType.VIDEO) {
    const info = await probeTrack(codec, track);
    if (!info.supported) {
      return null;
    }
    return {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet: ss, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  if (track.type === MediaType.AUDIO && ss.type === MediaType.AUDIO) {
    const info = await probeTrack(codec, track);
    if (!info.supported) {
      return null;
    }
    return {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: ss.language,
      [PROP_HIERARCHY]: { switchingSet: ss, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  if (track.type === MediaType.SUBTITLE && ss.type === MediaType.SUBTITLE) {
    return {
      type: MediaType.SUBTITLE,
      codec,
      bandwidth: track.bandwidth,
      [PROP_HIERARCHY]: { switchingSet: ss, track },
    };
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}

async function probeTrack(
  codec: string,
  track: Track,
): Promise<MediaCapabilitiesDecodingInfo> {
  let config: MediaDecodingConfiguration;
  if (track.type === MediaType.VIDEO) {
    config = {
      type: "media-source",
      video: {
        contentType: `video/mp4; codecs="${codec}"`,
        width: track.width,
        height: track.height,
        bitrate: track.bandwidth,
        framerate: 30,
      },
    };
  } else if (track.type === MediaType.AUDIO) {
    config = {
      type: "media-source",
      audio: {
        contentType: `audio/mp4; codecs="${codec}"`,
        bitrate: track.bandwidth,
        channels: "2",
        samplerate: 48000,
      },
    };
  } else {
    throw new Error(`Cannot probe track of type ${track.type}`);
  }
  return navigator.mediaCapabilities.decodingInfo(config);
}
```

`findStreamsMatchingPreferences`, `matchesPreference`, and `pickClosestByBandwidth` are unchanged.

- [ ] **Step 3: Verify build still fails — the call site in `StreamController` now mismatches**

Run: `pnpm tsc`
Expected: FAIL in `stream_controller.ts` because it assigns a `Promise<Map<…>>` to a `Map<…>` field. The next task fixes it.

- [ ] **Step 4: Do NOT commit yet**

Task 4 fixes the controller; we'll commit Tasks 2+3+4 together once the build is green.

---

### Task 4: Await `buildStreams` in `StreamController`

**Files:**
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts:83-96`

- [ ] **Step 1: Make `onManifestUpdated_` async and await `buildStreams`**

In [packages/cmaf-lite/lib/media/stream_controller.ts](packages/cmaf-lite/lib/media/stream_controller.ts), replace the existing `onManifestUpdated_` handler with:

```ts
private onManifestUpdated_ = async (event: ManifestUpdatedEvent) => {
  // Update manifest info.
  this.isLive_ = event.manifest.isLive;
  this.rangeStart_ = event.manifest.start;
  this.rangeEnd_ = event.manifest.end;

  if (!event.isUpdate) {
    // The initial manifest can be processed.
    this.streamsMap_ = await StreamUtils.buildStreams(event.manifest);
    log.info("Streams", this.streamsMap_);
    this.player_.emit(Events.STREAMS_CREATED);
    this.tryStart_();
  }
};
```

The event emitter doesn't await listeners — `async` here just lets us `await` `buildStreams` internally. Any tick logic that runs after `STREAMS_CREATED` was already gated on that event firing, so ordering is preserved.

- [ ] **Step 2: Verify the build compiles**

Run: `pnpm tsc`
Expected: PASS.

- [ ] **Step 3: Commit Tasks 2–4 together**

```bash
git add packages/cmaf-lite/lib/types/media.ts \
        packages/cmaf-lite/lib/utils/stream_utils.ts \
        packages/cmaf-lite/lib/media/stream_controller.ts
git commit -m "feat: Probe streams via Media Capabilities API in buildStreams"
```

---

### Task 5: Extend test factories with decoding info + MCAP stub

**Files:**
- Modify: `packages/cmaf-lite/test/__framework__/factories.ts`

- [ ] **Step 1: Add a `createDecodingInfo` factory**

Append to [packages/cmaf-lite/test/__framework__/factories.ts](packages/cmaf-lite/test/__framework__/factories.ts):

```ts
export function createDecodingInfo(
  overrides?: Partial<MediaCapabilitiesDecodingInfo>,
): MediaCapabilitiesDecodingInfo {
  return {
    supported: true,
    smooth: true,
    powerEfficient: true,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add a `mockMediaCapabilities` test helper**

Append to the same file:

```ts
/**
 * Installs a stub for `navigator.mediaCapabilities.decodingInfo`
 * that returns `info` for every probe. Returns the spy so callers
 * can inspect call count / arguments. Caller is responsible for
 * restoring with `vi.restoreAllMocks()` (or per-test cleanup).
 */
export function mockMediaCapabilities(
  info: MediaCapabilitiesDecodingInfo = createDecodingInfo(),
) {
  // happy-dom doesn't ship `navigator.mediaCapabilities` by default.
  // Define it lazily so we can vi.spyOn it.
  const nav = navigator as Navigator & { mediaCapabilities?: MediaCapabilities };
  if (!nav.mediaCapabilities) {
    Object.defineProperty(nav, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo: async () => info },
    });
  }
  return vi.spyOn(nav.mediaCapabilities!, "decodingInfo").mockResolvedValue(info);
}
```

Add the missing import at the top of the file:

```ts
import { vi } from "vitest";
```

- [ ] **Step 3: Verify the build compiles**

Run: `pnpm tsc`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/test/__framework__/factories.ts
git commit -m "test: Add decoding info factory and mediaCapabilities stub"
```

---

### Task 6: Update existing `stream_utils` tests for async `buildStreams`

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Install the MCAP stub in a `beforeEach` at file scope**

At the top of [packages/cmaf-lite/test/utils/stream_utils.test.ts](packages/cmaf-lite/test/utils/stream_utils.test.ts), add the import:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockMediaCapabilities } from "../__framework__/factories";
```

(adjust the existing import to also include `beforeEach`/`afterEach`/`vi` if missing).

At the very top inside the outermost test scope (above the first `describe`), add:

```ts
beforeEach(() => {
  mockMediaCapabilities();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Convert `videoStreams` and `videoStreamsFor` helpers to async**

In the same file, change the `videoStreams` helper signature from sync to async:

```ts
const videoStreams = async (): Promise<VideoStream[]> => {
  const manifest = createManifest({ /* unchanged body */ });
  const list = (await buildStreams(manifest)).get(MediaType.VIDEO) ?? [];
  return list.filter((s): s is VideoStream => s.type === MediaType.VIDEO);
};
```

Apply the same change to `videoStreamsFor`:

```ts
const videoStreamsFor = async (bandwidths: number[]): Promise<VideoStream[]> => {
  const manifest = createManifest({ /* unchanged body */ });
  const list = (await buildStreams(manifest)).get(MediaType.VIDEO) ?? [];
  return list.filter((s): s is VideoStream => s.type === MediaType.VIDEO);
};
```

- [ ] **Step 3: Update every call site to await the helper**

Anywhere the file says `const streams = videoStreams();` change to `const streams = await videoStreams();`. Same for `videoStreamsFor(...)`. Add `async` to the enclosing `it(...)` arrows.

Also update direct `buildStreams(manifest)` call sites inside `describe("buildStreams", ...)` to `await buildStreams(manifest)` and mark the enclosing `it(...)` arrows `async`.

- [ ] **Step 4: Run the existing test suite**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS — all preexisting cases still pass; nothing new yet.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Await async buildStreams in stream_utils tests"
```

---

### Task 7: Test — all-supported manifest carries `PROP_DECODING_INFO`

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing test**

Inside `describe("buildStreams", ...)`, add:

```ts
it("attaches PROP_DECODING_INFO to every video and audio stream", async () => {
  const info = createDecodingInfo();
  mockMediaCapabilities(info);
  const manifest = createManifest();
  const streams = await buildStreams(manifest);
  const video = streams.get(MediaType.VIDEO) ?? [];
  const audio = streams.get(MediaType.AUDIO) ?? [];
  expect(video).toHaveLength(1);
  expect(audio).toHaveLength(1);
  expect(video[0]![PROP_DECODING_INFO]).toBe(info);
  expect(audio[0]![PROP_DECODING_INFO]).toBe(info);
});
```

Add the missing imports at the top:

```ts
import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../../lib/constants";
import { createDecodingInfo } from "../__framework__/factories";
```

(merge with existing imports — don't duplicate `PROP_HIERARCHY`).

- [ ] **Step 2: Run the test to confirm it passes**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS — the implementation is already in place; this test just locks the behavior in.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Cover PROP_DECODING_INFO attachment on supported streams"
```

---

### Task 8: Test — mixed support drops unsupported, keeps supported

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing test**

Inside `describe("buildStreams", ...)`, add:

```ts
it("drops unsupported tracks but keeps supported siblings in the same switching set", async () => {
  const manifest = createManifest({
    switchingSets: [
      createVideoSwitchingSet({
        tracks: [
          createVideoTrack({ bandwidth: 500_000, width: 640, height: 360 }),
          createVideoTrack({ bandwidth: 5_000_000, width: 3840, height: 2160 }),
        ],
      }),
    ],
  });
  // First track supported, second unsupported (by bitrate).
  const spy = mockMediaCapabilities();
  spy.mockImplementation(async (config: MediaDecodingConfiguration) => {
    const bitrate = config.video?.bitrate ?? 0;
    return createDecodingInfo({ supported: bitrate < 1_000_000 });
  });
  const streams = await buildStreams(manifest);
  const video = streams.get(MediaType.VIDEO) ?? [];
  expect(video).toHaveLength(1);
  expect(video[0]!.bandwidth).toBe(500_000);
});
```

- [ ] **Step 2: Run the test to confirm it passes**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Cover mixed-support filtering within a switching set"
```

---

### Task 9: Test — entire switching set unsupported, others survive

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing test**

Inside `describe("buildStreams", ...)`, add:

```ts
it("excludes an entirely-unsupported switching set without affecting others", async () => {
  const manifest = createManifest({
    switchingSets: [
      createVideoSwitchingSet({
        id: "video:supported",
        codec: "avc1.64001f",
        tracks: [createVideoTrack({ bandwidth: 1_000_000 })],
      }),
      createVideoSwitchingSet({
        id: "video:unsupported",
        codec: "av01.0.05M.08",
        tracks: [createVideoTrack({ bandwidth: 2_000_000 })],
      }),
    ],
  });
  const spy = mockMediaCapabilities();
  spy.mockImplementation(async (config: MediaDecodingConfiguration) => {
    const codecs = config.video?.contentType ?? "";
    return createDecodingInfo({ supported: codecs.includes("avc1") });
  });
  const streams = await buildStreams(manifest);
  const video = streams.get(MediaType.VIDEO) ?? [];
  expect(video).toHaveLength(1);
  expect(video[0]!.codec).toContain("avc1");
});
```

- [ ] **Step 2: Run the test to confirm it passes**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Cover full-switching-set rejection"
```

---

### Task 10: Test — all video unsupported yields empty list, no throw

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing test**

Inside `describe("buildStreams", ...)`, add:

```ts
it("returns an empty video list when every video track is unsupported", async () => {
  mockMediaCapabilities(createDecodingInfo({ supported: false }));
  const manifest = createManifest({
    switchingSets: [createVideoSwitchingSet()],
  });
  const streams = await buildStreams(manifest);
  expect(streams.get(MediaType.VIDEO) ?? []).toEqual([]);
});

it("returns an empty audio list when every audio track is unsupported", async () => {
  const spy = mockMediaCapabilities();
  spy.mockImplementation(async (config: MediaDecodingConfiguration) =>
    createDecodingInfo({ supported: config.audio === undefined }),
  );
  const manifest = createManifest();
  const streams = await buildStreams(manifest);
  expect(streams.get(MediaType.AUDIO) ?? []).toEqual([]);
  // Video must still be present.
  expect((streams.get(MediaType.VIDEO) ?? []).length).toBe(1);
});
```

- [ ] **Step 2: Run the tests to confirm they pass**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS — `buildStreams` never throws on unsupported manifests.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Cover empty buckets when a media type is unsupported"
```

---

### Task 11: Test — subtitle streams pass through without probing

**Files:**
- Modify: `packages/cmaf-lite/test/__framework__/factories.ts` (add a subtitle factory if missing — verify first).
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Inspect the factories file**

Run: `grep -n "Subtitle" packages/cmaf-lite/test/__framework__/factories.ts`
Expected: no match — there's no subtitle factory yet.

- [ ] **Step 2: Add subtitle factories**

Append to [packages/cmaf-lite/test/__framework__/factories.ts](packages/cmaf-lite/test/__framework__/factories.ts):

```ts
export function createSubtitleTrack(
  overrides?: Partial<Track<MediaType.SUBTITLE>>,
): Track<MediaType.SUBTITLE> {
  return {
    id: "subtitle-track-1",
    type: MediaType.SUBTITLE,
    bandwidth: 1_000,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createSubtitleSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.SUBTITLE>>,
): SwitchingSet<MediaType.SUBTITLE> {
  return {
    id: "subtitle:wvtt:unk",
    type: MediaType.SUBTITLE,
    codec: "wvtt",
    language: LANGUAGE_UNKNOWN,
    tracks: [createSubtitleTrack()],
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing test**

In [packages/cmaf-lite/test/utils/stream_utils.test.ts](packages/cmaf-lite/test/utils/stream_utils.test.ts), inside `describe("buildStreams", ...)`, add:

```ts
it("passes subtitle streams through without probing", async () => {
  const spy = mockMediaCapabilities();
  const manifest = createManifest({
    switchingSets: [
      createVideoSwitchingSet(),
      createAudioSwitchingSet(),
      createSubtitleSwitchingSet(),
    ],
  });
  const streams = await buildStreams(manifest);
  const subtitles = streams.get(MediaType.SUBTITLE) ?? [];
  expect(subtitles).toHaveLength(1);
  // Subtitle stream must not carry PROP_DECODING_INFO.
  expect(PROP_DECODING_INFO in subtitles[0]!).toBe(false);
  // Probe called exactly twice — once for video, once for audio.
  expect(spy).toHaveBeenCalledTimes(2);
});
```

Update the factory imports at the top of the test file to include `createAudioSwitchingSet` and `createSubtitleSwitchingSet` (if not already present).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/test/__framework__/factories.ts \
        packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Cover subtitle pass-through skipping MCAP probe"
```

---

### Task 12: Test — `probeTrack` builds correct config per type

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing test**

Inside `describe("buildStreams", ...)`, add:

```ts
it("builds a video MediaDecodingConfiguration with width/height/bitrate", async () => {
  const spy = mockMediaCapabilities();
  const manifest = createManifest({
    switchingSets: [
      createVideoSwitchingSet({
        codec: "avc1.64001f",
        tracks: [
          createVideoTrack({
            bandwidth: 2_500_000,
            width: 1280,
            height: 720,
          }),
        ],
      }),
    ],
  });
  await buildStreams(manifest);
  expect(spy).toHaveBeenCalledWith({
    type: "media-source",
    video: {
      contentType: 'video/mp4; codecs="avc1.64001f"',
      width: 1280,
      height: 720,
      bitrate: 2_500_000,
      framerate: 30,
    },
  });
});

it("builds an audio MediaDecodingConfiguration with bitrate/channels/samplerate", async () => {
  const spy = mockMediaCapabilities();
  const manifest = createManifest({
    switchingSets: [
      createAudioSwitchingSet({
        codec: "mp4a.40.2",
        tracks: [createAudioTrack({ bandwidth: 128_000 })],
      }),
    ],
  });
  await buildStreams(manifest);
  expect(spy).toHaveBeenCalledWith({
    type: "media-source",
    audio: {
      contentType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 128_000,
      channels: "2",
      samplerate: 48000,
    },
  });
});
```

Add `createAudioTrack` to the factory imports if it's not already imported in this file.

- [ ] **Step 2: Run the tests to confirm they pass**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "test: Verify MediaDecodingConfiguration shape per track type"
```

---

### Task 13: Final verification

**Files:** (none modified)

- [ ] **Step 1: Type-check the full repo**

Run: `pnpm tsc`
Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Format / lint**

Run: `pnpm format`
Expected: clean exit; if files were rewritten, stage and amend the previous commit:

```bash
git add -A
git commit --amend --no-edit
```

(Only amend the immediately previous commit. If multiple commits need formatting changes, instead make a fresh `chore: Format` commit.)

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/media-capabilities
```

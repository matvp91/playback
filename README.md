# cmaf-lite

What would a media player look like if we started from scratch in 2026?

I help maintain [Shaka Player](https://github.com/shaka-project/shaka-player) with a couple of cool people. Shaka is built to be the player that works for everyone, and that's its strength. But I've spent years wondering what happens when you scope things down aggressively. Same learnings, way smaller scope. CMAF only. MSE/EME only. No legacy formats, no legacy key systems. That's it.

## Documentation

Head over to [matvp91.github.io/cmaf-lite](https://matvp91.github.io/cmaf-lite/) for guides and the full API reference.

## Why?

[Shaka Player](https://github.com/shaka-project/shaka-player) and [hls.js](https://github.com/video-dev/hls.js) have over a decade of learnings baked in. Some great, some painful. The thing is, they have to support everything. Every container format, every key system, every browser quirk. That's the deal when you're the player everyone depends on.

But what if you don't have to?

CMAF changes things. One container format across DASH and HLS. The manifest is the only thing that's different. Same segments, same boxes, same codec strings. So much complexity just vanishes.

So that's what this is. One manifest model any protocol maps onto. One pipeline from manifest to media element. Controllers that only talk through events. Give it a URL and a `<video>` element. Done.

It's early. DASH VOD works. Buffering, seeking, gap recovery. ABR, live, HLS, DRM? Not yet. But the code stays small, the architecture stays clean, and adding stuff hasn't meant fighting what's already there. That's the whole point.

## Key Principles

- **Stable references, not copies.** One source of truth. Everything else points into it. No duplication, no drift.
- **Single pass.** If you're scanning the same data twice, the structure is wrong.
- **Hotpaths don't allocate.** Allocate at setup, reference at runtime. The playback loop produces no garbage.
- **CMAF all the way down.** One container format means no abstraction layers. When every segment is fMP4 with a shared init, you can reason about the whole pipeline.

## Usage

```ts
import { Events, Player, Registry, RegistryType } from "cmaf-lite";
import { DashParser } from "cmaf-lite/dash";

Registry.add(RegistryType.MANIFEST_PARSER, DashParser);

const player = new Player();
const video = document.getElementById("video");

player.on(Events.MANIFEST_CREATED, (event) => {
  console.log("Manifest created:", event.manifest);
});

player.attachMedia(video);
player.load("https://example.com/manifest.mpd");
```

Built on the shoulders of [Shaka Player](https://github.com/shaka-project/shaka-player), [hls.js](https://github.com/video-dev/hls.js), and [Common Media Library](https://github.com/streaming-video-technology-alliance/common-media-library).

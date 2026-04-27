# cmaf-lite — Architecture & Technical Design

## Overview

CMAF-compliant media player library in TypeScript. Augments
the HTML `<video>` element with adaptive streaming by parsing
manifests into an internal model, fetching segments, and
buffering them through MSE.

### Goals

- Full player experience — manifest-to-playback, no assembly
- VOD focus today, architecture supports live from day one
- Format-agnostic internal model — DASH first, model is neutral
- Event-driven controllers — loosely coupled, single-responsibility

### Non-goals (for now)

- DRM, UI/chrome

## Principles

- **Event-driven** — controllers communicate only through
  the Player's event bus, never directly.
- **Single responsibility** — one concern per controller.
- **Format-agnostic model** — parsers translate source
  formats into a neutral Manifest model. Everything
  downstream is format-unaware.
- **Stable references** — manifest objects are mutable with
  stable identity, usable as map keys.
- **MSE contained** — MSE constraints live inside
  BufferController. No other code reasons about MSE.
- **Network interception** — all requests flow through
  NetworkService, observable and mutable via events.

## Pipeline

```
URL → ManifestController → Manifest → StreamController → Segment Data → BufferController → MSE → <video>
```

## Player

Central class with three roles:

1. **Event bus** — all controller communication flows through
   `EventEmitter`. Controllers never call each other directly.
2. **Owner** — instantiates and holds controllers and
   NetworkService.
3. **Public API** — `load()`, `attachMedia()`, `detachMedia()`,
   `destroy()`, `getConfig()`, `setConfig()`,
   `setStreamPreference()`, `getStreamPreference()`,
   `getStreams()`, `getActiveStream()`, `getBuffered()`,
   `getMedia()`, `getNetworkService()`.

## Controllers

Each controller receives the Player on construction, binds
event listeners, has a single responsibility, and provides
`destroy()` for cleanup.

### ManifestController

Fetches manifests via NetworkService and parses them with
the DASH parser. Emits the parsed Manifest for downstream
controllers.

### BufferController

Owns the MediaSource lifecycle, SourceBuffers, and segment
appending. Creates one SourceBuffer per media type. Appends
are serialized through an OperationQueue (MSE requires one
operation at a time per SourceBuffer). Computes
`timestampOffset` from MP4 container metadata.

### StreamController

Orchestrates segment loading. Waits for both manifest and
media to be ready, builds
[streams](stream.md) from the manifest, selects initial
streams via preferences, then runs a tick loop per media
type that checks the buffer goal and fetches the next
segment. Handles presentation transitions and seeking.

### GapController

Detects playback stalls and jumps small gaps (up to 2s) to
keep playback moving.

### AbrController

Selects one of two drivers per evaluation tick — Throughput (dual
EWMA) or BOLA (buffer utility) — via a buffer-fullness hysteresis.
Owns the eval loop, the throughput-pick algorithm, and the
`BolaScorer` lifecycle. See [abr.md](abr.md) for details.

## Network Layer

`NetworkService` centralizes all HTTP requests. Emits events
before and after each fetch (allowing mutation of URL, headers,
method). Supports cancellation via `AbortController`.

## Event Flow

Events are the connective tissue. No controller knows about
any other — they only know about events.

### Media Attachment

```
player.attachMedia(videoEl)
  → MEDIA_ATTACHING
  → BufferController creates MediaSource, binds to video
  → sourceopen
  → MEDIA_ATTACHED
```

### Load & Playback (VOD)

```
player.load(url)
  → MANIFEST_LOADING
  → ManifestController fetches + parses
  → MANIFEST_CREATED

Both MEDIA_ATTACHED and MANIFEST_CREATED received:
  → StreamController selects streams
  → BUFFER_CODECS (per type)
  → BufferController creates SourceBuffers
  → StreamController tick loop starts
  → BUFFER_APPENDING (init, then media segments)
  → BUFFER_APPENDED
  → ... repeats until done ...
  → BUFFER_EOS → endOfStream()
```

For live presentations (`Manifest.isLive === true`),
ManifestController additionally runs a `Timer`-driven refresh loop
on the `liveUpdateTime` config cadence. Each refresh parses a new
MPD snapshot against the existing Manifest in place, reconciling
segments (tail append + head prune, keyed on `segment.start`) and
emits `MANIFEST_UPDATED`. StreamController initial-positions
playback to `liveEdge - liveDelay` and suppresses EOS while the
manifest remains live.

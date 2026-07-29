# Video as an input: what each provider actually supports

Researched 2026-07-29 in response to "can we add video-to-video and
video-to-image?". Two of the three answers are constrained by things outside
the model — our own auth and Vercel's payload limit — so they are recorded
here rather than in a provider header.

## Verdict per path

| Path | Model support | Blocker | Status |
|---|---|---|---|
| **video → image** | n/a — solved client-side | none | **shipped** |
| **video → video, BytePlus Seedance 2.0** | yes (up to 3 clips, 2–15s, ≤50MB each; billing moves to a cheaper V2V token tier) | needs a provider-fetchable URL; ours are session-gated and we have no presigning | probe written, not wired |
| **video → video, Higgsfield Seedance** | unknown | cannot be probed — see below | unverified |
| **video → video, Gemini Omni** | unknown | `omni-input.ts` builds image parts only | unverified |

## video → image — shipped, no provider dependency

`src/lib/video-frame.ts` decodes a frame with `<video>` + `<canvas>` in the
browser. This is not a stopgap for a missing API; it is the correct place for
the work:

- Vercel caps request bodies at 4.5MB, so a video cannot reach us through the
  reference-upload path at all. A decoded frame is a small JPEG that fits the
  ladder every other reference already uses.
- Decoding server-side needs ffmpeg, which is not a dependency and is not on
  the Vercel runtime.
- A frame is an ordinary image reference, so it works with **every** model —
  Nano Banana Pro, Soul, both Seedance paths and Omni — with no provider change.

Entry points: dropping/selecting a video file in the composer, and "Use this
frame as reference" in the detail modal (which takes the frame the user is
currently paused on).

Canvas tainting is a non-issue because provider results are always
re-downloaded and re-served from `/api/media/…`, i.e. same-origin. A genuinely
cross-origin video throws a clear message rather than silently producing a
blank frame.

## video → video on BytePlus — the real blocker is ours, not theirs

The model supports it. ModelArk's `content` array is documented as accepting
`text`, `image_url`, `video_url` and `audio_url` items, with per-request limits
of 9 images / 3 videos / 3 audio.

What stops us is that **`video_url` needs a URL BytePlus can fetch**, and:

1. `GET /api/media/[...path]` requires a session (deliberately — it was a
   CRITICAL fix in 2026-07-15), so provider-side fetches get a 401.
2. `src/lib/storage.ts` has no presigned-URL support for either S3 or GCS.

So enabling this is mostly storage work, not provider work:

- add short-TTL presigned reads (`@aws-sdk/s3-request-presigner` for S3;
  `file.getSignedUrl()` is already built into `@google-cloud/storage`), used
  only for provider hand-off and never surfaced to the browser; **or**
- inline the clip as a base64 data URL from `/api/queue/execute`, the way
  `toProviderDataUrls` already does for images. Outbound, so Vercel's inbound
  limit does not apply — but a 50MB clip is ~67MB of base64 held in a
  serverless function, which is the reason to prefer presigning.

Uploading a *new* video from the user's machine needs the same presigning work
(direct-to-storage PUT), because 4.5MB rules out proxying it. Scoping v1 to
clips already in the library avoids that entirely and covers the common case:
extending or restyling something just generated.

The exact wire shape is **not** settled — first-party docs are incomplete and
third-party write-ups disagree (`content[].video_url` vs a `references[]` array
with `role: "motion"`, the latter probably an aggregator's own wrapper).
`scripts/probe-seedance-video-input.ts` sends the candidate shapes and reports
which the API accepts. `providers/seedance.ts` already records that several
fields here were deduced by testing because the docs were wrong, so guessing
would repeat a known mistake.

## Higgsfield — deliberately not probed

Its MCP flow (`media_upload` → `media_confirm` → `generate_video`) takes a
`content_type`, so a video upload is plausibly accepted. Whether
`generate_video` accepts a video media id can only be answered by reading its
tool schema.

**That check was not run.** Higgsfield refresh tokens are single-use and reuse
revokes the entire token family with no automated recovery, and CLAUDE.md
forbids refreshing from local dev for exactly that reason. Confirming this is
worth doing from the deployed environment, or with a token minted for the
purpose — not from a laptop.

---

# UPDATE 2026-07-29 — probed, and both paths now work

Everything below the line supersedes the "not wired" status above.

## video → video: CONFIRMED and shipped

`scripts/probe-seedance-video-input.ts` was run against the live API. Result:

| shape | outcome |
|---|---|
| `content[].video_url` with no role | **400** — *"reference media mode requires video role to be reference_video"* |
| `content[].video_url` + `role: "reference_video"` | **accepted, generated a real video** |
| top-level `video_urls: []` | accepted (then failed the sample clip on copyright moderation) |

So the working contract is:

```json
{ "type": "video_url", "video_url": { "url": "…" }, "role": "reference_video" }
```

The role is **mandatory**, which the image item's optional-role shape would have
led us to get wrong — the probe paid for itself on the first request.

One thing the probe surfaced that had nothing to do with video: this account has
**not activated `dreamina-seedance-2-0-fast-260128`**. The first run failed on
every shape with `404 ModelNotOpen` before the payload was even parsed. The
standard model is active. `Seedance 2.0 Mini` is not in the model picker so
nothing reaches it today, but `pickModel` routes any name matching
mini/fast/lite to that SKU — activate it in the Ark console before exposing it.
`scripts/probe-seedance-audio.ts` defaulted to that SKU and has been changed to
default to standard for the same reason.

End-to-end proof, through our own `createVideoTask` and a presigned URL for a
clip in the library: task `cgt-20260729204201-rg294` → **succeeded**.

## The URL problem, solved

`storage.getSignedReadUrl` / `signStoredRef` issue a 15-minute presigned read,
S3 and GCS both. Verified against a real stored clip: `HTTP 206`, `video/mp4`,
fetchable with **no session**, where the ordinary `/api/media/…` URL returns
**401** — which is exactly why this was needed.

They are server-side only, read-only, single-object, and refuse the `settings/`
and `migrations/` prefixes the media route denies (verified). Signing happens in
`/api/queue/execute` at the moment of hand-off; a signed URL is never persisted
and never sent to the browser.

## Local-environment note, not a bug

While testing, the three most recent videos in the production DB were absent
from the bucket named by this machine's `.env.local`
(`ais-film-platform-media`) — `readStoredBuffer` fails for them locally too,
so it is not a signing fault. Production serves them fine, so production's
`AWS_S3_BUCKET_NAME` differs from the local one. Worth reconciling before
anyone trusts a local run of a media-touching script.

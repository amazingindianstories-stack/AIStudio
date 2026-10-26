# BytePlus OmniHuman 2.0

OmniHuman appears in the existing video composer when `VEEVEE_OMNIHUMAN=1`.
Its required inputs are one image and one WAV or MP3 audio file. Output length
comes from the audio, up to 300 seconds; framing comes from the image. The API
publishes no independent output resolution, bitrate or output-format option.
The existing settings show Auto framing/resolution and audio-driven duration.
No portrait registration or Seedance prompt rewriting is applied.

The Django adapter is `backend/apps/generation/providers/omnihuman.py`.
It uses POST JSON on `https://cv.byteplusapi.com/`, version `2024-06-06`,
`CVSync2AsyncSubmitTask`, `CVSync2AsyncGetResult` and `CVCancelTask`, with
`req_key=realman_avatar_picture_omni20_cv`. Submissions send
`enable_watermark=false`, so outputs carry no provider watermark.
Authentication uses the existing BytePlus HMAC signer with fixed service `cv`
and region `ap-singapore-1`, and Veevee's existing BytePlus access key pair
(`BYTEPLUS_ACCESS_KEY_ID` / `BYTEPLUS_SECRET_ACCESS_KEY`, read like the BytePlus
integration, including its `VOLCENGINE_*` fallback). It does not use the
Seedance ModelArk API key.

Original input bytes are checked before queueing and again before submission:

- Image: JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC or HEIF; strictly under 30 MB;
  each dimension 300-6000 pixels; width/height 0.4-2.5.
- Audio: WAV or MP3; strictly under 15 MB; 4-300 seconds inclusive. Unknown
  duration, corrupt input and unrecognized containers fail before payment.
- The optional prompt supports Chinese, English, Japanese, Korean, Mexican
  Spanish and Indonesian. Language interpretation remains with the provider.

Submission records a durable receipt before returning. Queueing and processing
are polled asynchronously so a pending job releases its worker slot between
checks. The documented task lifetime is 12 hours. Input grants last 12 hours.
No failure automatically resubmits a paid task. A status query ends a job only
on an input or content-policy refusal; credential, signature, clock, access and
service errors back off and keep polling the accepted task. Provider error
records retain redacted codes and request/task IDs for the user failure copy
and admin view.
All documented states, business errors and common service/gateway errors have
explicit mappings and synthetic tests.

Completed output links last one hour. Downloads stream to a spool file with a
4 GB bound and a ten-minute per-download budget. Retries stop within 45 minutes
of observed completion. MP4/MOV container headers determine the stored extension;
original bytes are preserved without transcoding. The worker keeps its lease
while downloading and commits the saved master even when a work deadline expires
just after storage completes.

## Activation and live acceptance

Default availability is off. Default pricing is explicitly unknown, not free;
set a positive `OmniHuman 2.0` per-second admin rate before admitting requests.
The API reference does not publish a price, and task responses report no cost
or usage.

An approved deployment needs:

- `VEEVEE_OMNIHUMAN=1` on API and generation worker.
- `GOAL4_PREVIEW_PORTRAIT_CONFIGURATION` on the generation worker. With the
  switch on, the worker receives the BytePlus key pair from its `read_environment`
  and refuses to start without it. No new secret is needed.
- A confirmed account price.

With the switch on, the generation worker also allows the result host
`v16m-default.tiktokcdn.com`, observed in the approved live canary. Do not add
guessed hosts or wildcards.

The approved live canary (task `2072219181`, 2026-10-26) went from `generating`
to `done` in 162 seconds for about 11 seconds of output. It returned a signed,
expiring `https://v16m-default.tiktokcdn.com/...` link to an MP4 (not MOV) with
H.264 video and AAC audio, 720x1280, with no visible watermark. Task IDs are
numeric strings. Querying an unknown task ID returns `50500` `Internal Error`
rather than a `not_found` state, so it backs off like any service error.

## Cancellation

The adapter is registered in `generation/services/cancellation.py`. BytePlus
only cancels a task while it is `in_queue`, so Cancel is offered only before the
task starts generating. `CVCancelTask` code `10000` accepts the request, and
polling then settles the job: the `canceled` state becomes Veevee's `cancelled`,
with the estimated cost kept as `cancelled_billing_unconfirmed`. Code `50217`
means the task already started; that is a refusal, and the job continues
normally. Cancel requests run in the API process, which holds the same BytePlus
pair through its portrait configuration. With `VEEVEE_PAID_GUARD` set, the guard allows only the exact
`CVCancelTask` POST with a `{req_key, task_id}` body for an active OmniHuman
generation whose cancellation is `requested`, never a submission.

Sources read in full on 2026-10-25:
[OmniHuman 2.0 API](https://docs.byteplus.com/en/docs/byteplus-vision/omnihuman-2-0-video-generation),
[service errors](https://docs.byteplus.com/en/docs/byteplus-vision/docs-common-responses-and-error-codes),
[common parameters](https://docs.byteplus.com/en/docs/byteplus-platform/reference-common-parameters),
[signing](https://docs.byteplus.com/en/docs/byteplus-platform/reference-how-to-calculate-a-signature),
[gateway errors](https://docs.byteplus.com/en/docs/byteplus-platform/reference-common-error-codes).

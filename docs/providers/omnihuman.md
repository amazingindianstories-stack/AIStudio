# BytePlus OmniHuman 2.0

OmniHuman appears in the existing video composer when `VEEVEE_OMNIHUMAN=1`.
Its required inputs are one image and one WAV or MP3 audio file. Output length
comes from the audio, up to 300 seconds; framing comes from the image. The API
publishes no independent output resolution, bitrate or output-format option.
The existing settings show Auto framing/resolution and audio-driven duration.
No portrait registration or Seedance prompt rewriting is applied.

The Django adapter is `backend/apps/generation/providers/omnihuman.py`.
It uses POST JSON on `https://cv.byteplusapi.com/`, version `2024-06-06`,
`CVSync2AsyncSubmitTask` and `CVSync2AsyncGetResult`, with
`req_key=realman_avatar_picture_omni20_cv`.
Authentication uses the existing BytePlus HMAC signer with fixed service `cv`
and region `ap-singapore-1`. It does not use the Seedance ModelArk API key.

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
service errors back off and keep polling the accepted task. Provider error records retain
redacted codes and request/task IDs for the user failure copy and admin view.
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
The API reference does not publish a price or an actual output hostname.

An approved deployment needs:

- `VEEVEE_OMNIHUMAN=1` on API and generation worker after acceptance.
- `OMNIHUMAN_ACCESS_KEY_ID` and `OMNIHUMAN_SECRET_ACCESS_KEY` on the generation
  worker only.
- The exact output hostname observed in an approved live canary in the worker's
  existing `provider_media_hosts` configuration. Do not add guessed hosts or wildcards.
- A confirmed account price and approval for a short live canary. A four-second
  canary costs four times that per-second rate, subject to account billing rules.

Local protocol checks are synthetic and do not establish live acceptance.
No production deployment or service configuration change is part of this work.

Cancellation is a separate follow-up. This adapter recognizes a provider-originated
`canceled` status but exposes no cancellation call. BytePlus only allows cancellation
while a task is `in_queue`; after execution starts it returns `50217`.

Sources read in full on 2026-10-25:
[OmniHuman 2.0 API](https://docs.byteplus.com/en/docs/byteplus-vision/omnihuman-2-0-video-generation),
[service errors](https://docs.byteplus.com/en/docs/byteplus-vision/docs-common-responses-and-error-codes),
[common parameters](https://docs.byteplus.com/en/docs/byteplus-platform/reference-common-parameters),
[signing](https://docs.byteplus.com/en/docs/byteplus-platform/reference-how-to-calculate-a-signature),
[gateway errors](https://docs.byteplus.com/en/docs/byteplus-platform/reference-common-error-codes).

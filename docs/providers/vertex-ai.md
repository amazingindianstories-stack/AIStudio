# Vertex AI for Gemini calls

Veevee's Gemini calls use Vertex AI (`aiplatform.googleapis.com`), billed to the Google Cloud project. The
`GOOGLE_GENAI_BACKEND=vertex` switch selects Vertex for `generateContent` calls; Gemini Omni video always uses Vertex
Interactions. The retired AI Studio key must not be restored. The shared credential code is
`backend/apps/integrations/google_genai.py`.

## What moves to Vertex AI

| Feature | Code | Model on the Gemini API | Model on Vertex AI |
|---|---|---|---|
| Nano Banana Pro images | `generation/providers/gemini.py` | `gemini-3-pro-image` | same (GA, global only) |
| Nano Banana 2.1 images | same | `gemini-nano-banana-2.1` | same (GA, global only); the job's seed is not sent |
| Reference prep (identity crops, judging) | `generation/prompting/image_prep.py` | `gemini-2.5-flash` | `gemini-3.8-flash`, thinking level LOW |
| Board "Create with AI" text | `generation/services/text_execution.py` | `gemini-flash-latest`, `gemini-pro-latest` | `gemini-3.8-flash`, `gemini-3.1-pro-preview` |
| Audio transcription (composer, talktrack) | `media/audio.py` | `gemini-2.5-flash` | `gemini-3.8-flash` |
| Agents tab loop, design, view_media, read_document, voice notes | `agents/*`, `mcp/tools/media.py` | `gemini-3.8-flash`, `gemini-3.1-pro-preview` | same |
| Admin status row "Gemini / Nano Banana" | `admin_dashboard/status.py` | `models.get` read | mints an access token, no model call |
| Gemini Omni Flash 1.2 video | `generation/providers/omni.py` | none | global Interactions API, inline MP4 |

Vertex AI has no `-latest` aliases and retired `gemini-2.5-flash` on 2026-10-20, so the switch replaces only those
defaults. An explicit `AGENT_LLM_MODEL`, `AGENT_LLM_MODEL_ADVANCED`, `AUDIO_TRANSCRIPTION_MODEL` or
`GEMINI_DETECT_MODEL` still wins. The model facts come from Google's Vertex AI model pages, read on 2026-11-26.

Each transport stays pinned to its host: `aiplatform.googleapis.com`, or `<region>-aiplatform.googleapis.com` when a
region is set. The paid guard's endpoint pins follow the switch automatically, because they are computed from the
same URLs.

## Credentials

Vertex AI takes an OAuth access token, not an API key. Veevee gets it from Application Default Credentials
(`google.auth.default`, `cloud-platform` scope). On Railway those are the Google Cloud service account every service
already holds for Cloud Storage: `GCP_ADC_JSON`, which `deploy/entrypoint.py` writes to the file
`GOOGLE_APPLICATION_CREDENTIALS` names. No new key is needed. Tokens are cached per process and refreshed shortly
before they expire. A credential or token never appears in a log, an error or a URL; a failure logs only its error type.

To call as a separate, Vertex-only service account, set `GOOGLE_VERTEX_IMPERSONATE_SA`. Veevee then uses the ADC
identity to mint short-lived tokens for that account (`google.auth.impersonated_credentials`). This is the production
setup, because it keeps Vertex permissions off the storage identity. It needs two IAM grants:

1. The ADC service account holds **Service Account Token Creator** on the impersonated account.
2. The impersonated account holds **Vertex AI User** (shown in the console as Agent Platform User) on the project.

Without impersonation, the ADC service account itself needs Vertex AI User. In both cases the Vertex AI API
(`aiplatform.googleapis.com`) must be enabled on the project.

## Variables

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_GENAI_BACKEND` | to switch | `vertex` or `gemini`. Unset means `gemini`. Any other value stops startup. |
| `GOOGLE_VERTEX_IMPERSONATE_SA` | optional (set in production) | The email of the service account to impersonate. Unset, calls run as the ADC identity. |
| `GOOGLE_VERTEX_LOCATION` | optional | A region such as `us-central1`. It defaults to `global`. Nano Banana Pro and 2.1 are served only from `global`, so their calls ignore it. Set a region only if `gemini-3.8-flash` and `gemini-3.1-pro-preview` are served there. |
| `GCP_PROJECT_ID`, else `GOOGLE_CLOUD_PROJECT` | yes, on Vertex | The project calls are scoped and billed to. On Railway `deploy/legacy_config.py` already sets `GCP_PROJECT_ID`. |
| `GCP_ADC_JSON` (Railway) or `GOOGLE_APPLICATION_CREDENTIALS` (elsewhere) | yes, on Vertex | The Application Default Credentials above. Already set on every Railway service. |

With the switch on, the api, generation and agent services refuse to start without `GCP_ADC_JSON`, or with a bad
project, region or impersonation target (`backend/deploy/legacy_config.py`, `_vertex`). Credentials themselves load at
the first call; a failure there fails that call and shows on the admin status row.

## Where the values go (Railway)

The backend reads these values from **Railway service variables**. Vercel holds no provider secrets, and there is no
`.env.local` for them.

| Railway service | `GOOGLE_GENAI_BACKEND` | `GOOGLE_VERTEX_IMPERSONATE_SA`, `GOOGLE_VERTEX_LOCATION` |
|---|---|---|
| green-django-api | yes | yes: voice notes, talktrack transcription, admin status |
| green-django-generation | yes | yes: images, reference prep, board text, audio transcription |
| green-django-agent | yes | yes: the Agents tab loop and its media reads |
| green-django-scheduler | yes | no |
| green-django-export | yes | no |
| green-django-mcp | yes | never: the MCP service holds no provider credentials, and `legacy_config` strips them |

The switch must be the same on every service. Jobs record their default model when they are queued, for example the
transcription model or the board text model. If a service still on the Gemini API queues a job and a Vertex worker
runs it, the job's model and its paid-guard quote disagree.

Locally, the same variables go in the backend's environment. `backend/.env.example` lists them empty. The `local/`
stack keeps its fake Gemini provider and does not pass them through.

## Limits on Vertex AI

- **Gemini Omni Flash 1.2 uses Vertex Interactions.** The global `/v1beta1/projects/{project}/locations/global/interactions`
  endpoint receives `background: true` and an array `response_format` with `delivery: inline`. The adapter stores the
  returned MP4 bytes and MIME unchanged. The currently offered choices remain 360p/720p and 4/6/8/10 seconds, with
  at most 10 total reference images including selected tiles. Historical 1.1 rows keep their labels; active old
  Gemini API interaction IDs are never sent to Vertex. Project access and billing need a paid canary before release.
- **Large media use Cloud Storage.** The Vertex handoff below replaces inline-size refusals; Vertex has no Files API.
- **Nano Banana 2.1 sends no seed.** Vertex rejects `seed` (and `temperature`, `topP`, `topK`) for this model. The seed
  a job records is shown but not sent.
- **The admin status row cannot read a model for free.** It mints an access token and reports "access token minted"
  without making a model call, so it proves the credentials, not model access.
- **Limited-scope operator quotes follow the selected image backend.** `paid_guard.operator_quotes` computes image
  endpoints through `google_genai.model_url`.
- **Board text jobs queued before the switch** carry `gemini-flash-latest` or `gemini-pro-latest`, which Vertex does
  not serve. Such a job fails if a Vertex worker runs it; retry it after the switch.
- **Audio transcription jobs queued before the switch** record `gemini-2.5-flash`, which Vertex retired. A Vertex
  worker refuses such a job: the paid guard rejects its quote, or, with the guard off, Vertex rejects the model. Neither
  makes a billed submission; retry the job after the switch.
- **Pricing remains an estimate.** Omni 1.2 uses the published 720p guide price of $0.07/s; invoice reconciliation
  and a paid canary are needed before treating it as measured spend.

## Media handoff and reader permissions

`backend/apps/integrations/google_media.py` prepares Vertex `generateContent` inputs after the original request
passes its authorization and paid guard. Inputs stay inline up to Veevee's conservative 4 MiB per file and 9 MiB
combined budgets. Larger inputs use `fileData` with a private `gs://` URI in the existing `GCP_MEDIA_BUCKET` storage
adapter. This covers agent attachments and media tools, reference generation and judging, image prep and audio
transcription. Board text requests remain text; media reads reached from a board use the same handoff.

Every input that leaves the inline budget, including authorized agent assets, is copied to a random
`ai-inputs/<uuid>` object at the media bucket root, outside the configured storage prefix that originals keep,
written with `private, no-store` and deleted in `finally`, including failed submissions and cancellation. Vertex never receives a URI for an original, a generated
master, or the protected `settings/`, `migrations/` and `exports/` namespaces; the agent request allowlist accepts
only `ai-inputs/<uuid>` URIs in the media bucket. Originals and generated masters are never modified. No public URLs,
signed URLs, or new credentials are needed. The ordinary storage ADC identity writes and deletes these objects. A
process crash can leave an inference copy behind; the bucket lifecycle rule in `infra/gcp/storage-lifecycle.json`
deletes leftover `ai-inputs/` copies automatically after two days and does not touch originals.

If GCS is unavailable as a configured storage backend, or a media input exceeds the URI limit, the server prepares
an inference derivative: JPEG resizing/recompression, AAC audio, or H.264/AAC video. Audio/video encoding preserves
the full timeline; no silent trimming. Subprocesses are bounded and accept local files only. Corrupt media, a document
that cannot fit its available transport, or a timeline that cannot fit without discarding content gets a preparation
error. A Cloud Storage write or permission failure is a `media_staging` error marked as never submitted, so it
is not treated as a possibly billed submission.
Existing product upload, duration, context and media-count limits still apply. The Gemini API branch keeps its
existing inline/Files API behavior; Omni and other providers do not enter this handoff.

Google's current limits, checked 2026-11-26 for Veevee's Gemini 3 models:

| Input | Inline part | One Cloud Storage object | Other content limits |
|---|---|---|---|
| Images, including Nano Banana Pro and 2.1 | 256 MB | 2 GiB minus 500 KiB | Image generation: 14 references |
| Audio | 256 MB | 2 GiB minus 500 KiB | Approximately 8.4 hours, subject to model context |
| Video | 256 MB | 2 GiB minus 500 KiB | Approximately 45 minutes with audio, 1 hour without |
| PDF | 256 MB | 2 GiB minus 500 KiB | Subject to model context |

These are API limits, not the smaller console local-upload or public HTTPS URL limits. Non-migrated Gemini 2.5
endpoints retain legacy image/PDF restrictions; this transport targets the pinned Gemini 3 defaults. Sources:
[image limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-understanding),
[audio limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/audio-understanding),
[video limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding),
[document limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding).

The authenticated Vertex caller is the account named by `GOOGLE_VERTEX_IMPERSONATE_SA` (the production
`veevee-vertex-ai` account), or ADC without impersonation. Google's current documentation distinguishes that caller
from the **object-fetch identity**: `generateContent` reads through the calling project's Vertex AI service agent,
`service-PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com`. The bucket must be in the calling project for
the documented private-object path. Firstmate must verify/grant **Storage Object Viewer**
(`roles/storage.objectViewer`, including `storage.objects.get`) to that service agent, and to the impersonated
caller where bucket IAM requires caller checks, as a bucket IAM binding with an IAM condition limited to the
inference namespace, never bucket-wide:

```
resource.name.startsWith("projects/_/buckets/<bucket>/objects/ai-inputs/")
```

The condition does not depend on the configured storage prefix. Neither identity needs object write access
for this feature, and neither may read originals, `settings/`, `migrations/` or `exports/`. This task makes no IAM
changes. See Google's
[Cloud Storage access troubleshooting](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/design-multimodal-prompts#troubleshoot-cloud-storage-access-and-permissions).

Offline tests use a fake bucket and disposable PostgreSQL. Owner acceptance must include a real input over 4 MiB,
a batch over 9 MiB, image references, audio transcription and a video media read, verifying storage-reader IAM and
deletion of the inference copy after each call. Synthetic test success does not establish live Vertex acceptance.

## Verification and rollback

Offline tests cover the URLs, headers, host pins, model defaults, seed handling, refusals, impersonation and token
caching. No live Vertex call has been made. After deploying with the switch on, use this owner-approved canary order:

1. The admin status row shows "Vertex AI: access token minted".
2. One Nano Banana Pro image.
3. One Nano Banana 2.1 image.
4. One board text job.
5. One voice note.

To roll back, unset `GOOGLE_GENAI_BACKEND` (or set it to `gemini`) on every service and redeploy.

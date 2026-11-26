# Vertex AI for Gemini calls

Veevee's Gemini calls are moving from the Gemini API (`generativelanguage.googleapis.com`, `GOOGLE_API_KEY`) to Vertex
AI (`aiplatform.googleapis.com`), billed to the Google Cloud project. Vertex AI is the production target. The move is
behind one switch, `GOOGLE_GENAI_BACKEND=vertex`, so deploying the code changes nothing until the switch is set, and
unsetting it is the rollback. The variable is read when each call is made. With it unset, or set to `gemini`, requests
are byte-for-byte what they were before the switch existed. The code is `backend/apps/integrations/google_genai.py`.

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

- **Gemini Omni video stays on the Gemini API.** Vertex does not document the Interactions API that Omni uses. While
  the Gemini API is unavailable, Omni jobs fail as before.
- **Large Agents attachments are refused.** Vertex has no Files API, so the agent reads only files that fit inline: one
  file up to 4 MB, and 9 MB per call. A larger file gets a clear refusal instead of an upload.
- **Nano Banana 2.1 sends no seed.** Vertex rejects `seed` (and `temperature`, `topP`, `topK`) for this model. The seed
  a job records is shown but not sent.
- **The admin status row cannot read a model for free.** It mints an access token and reports "access token minted"
  without making a model call, so it proves the credentials, not model access.
- **Limited-scope operator quotes stay pinned to the Gemini API.** These are `paid_guard.operator_quotes`, used for
  paid rehearsals. On Vertex they refuse, which is fail-closed.
- **Board text jobs queued before the switch** carry `gemini-flash-latest` or `gemini-pro-latest`, which Vertex does
  not serve. Such a job fails if a Vertex worker runs it; retry it after the switch.
- **Audio transcription jobs queued before the switch** record `gemini-2.5-flash`, which Vertex retired. A Vertex
  worker refuses such a job: the paid guard rejects its quote, or, with the guard off, Vertex rejects the model. Neither
  makes a billed submission; retry the job after the switch.
- **Pricing is unverified.** Usage rows and the Agents tab budget use the Gemini API rates. Vertex pricing was not
  checked.

## Verification and rollback

Offline tests cover the URLs, headers, host pins, model defaults, seed handling, refusals, impersonation and token
caching. No live Vertex call has been made. After deploying with the switch on, use this owner-approved canary order:

1. The admin status row shows "Vertex AI: access token minted".
2. One Nano Banana Pro image.
3. One Nano Banana 2.1 image.
4. One board text job.
5. One voice note.

To roll back, unset `GOOGLE_GENAI_BACKEND` (or set it to `gemini`) on every service and redeploy.

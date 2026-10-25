# Generation cancellation

Django owns `POST /api/generate/cancel` with JSON `{ "id": "generation UUID" }`.
Only the generation owner or an admin may request it. The card menu uses the
server's `canCancel` capability and the existing confirmation dialog. No
unsupported provider is stopped locally while its remote paid work continues.

Supported adapters are registered in `generation/services/cancellation.py`:
ModelArk Seedance queued tasks and Gemini Developer API background interactions.
Vertex is excluded until its official cancellation contract is verified.
Higgsfield's hosted OAuth MCP is distinct from its REST request API and has no
verified cancel contract. OmniHuman 2.0's provider is a separate change that is
not in this tree; whichever of the two lands second registers its adapter and
its paid-guard cancel endpoint. That adapter must use its own signed
`CVCancelTask` operation, fixed service `cv` and region `ap-singapore-1`, and
normalize its `canceled` query result to `cancelled` before registration.

With `VEEVEE_PAID_GUARD` set, the guard allows exactly two cancel requests
outside a submission claim: DELETE of the ModelArk task URL and POST of the
Interactions `/{id}/cancel` URL, each without a body and only for the task of a
queued or running generation of that provider whose cancellation is
`requested`. Every other non-GET request stays refused.

Cancellation claims the existing worker lease before provider I/O. Local queued
work can settle immediately only while the same claim excludes submission and
there is no task receipt or uncertain submission. Submitted work is queried
before cancellation and reconciled through the existing poller afterward. A
provider response indicating success or failure retains that real outcome.
Multiple candidate tasks settle only when every task is terminal; a completed
candidate still supplies the winning master. Every candidate must be cancelled
for the aggregate to settle as cancelled.

ModelArk DELETE also deletes completed task records. A task can complete between
the preflight query and DELETE, so an empty successful DELETE or subsequent 404
cannot prove cancellation. Such work remains active with durable cancellation
state, keeps its receipt and continues polling under the same 6-hour
poll-abandonment cap as any other poll. At the cap it settles as failed and keeps
its cancellation state, task receipt, provider evidence and estimated cost; it
can then be deleted like any failed row. Deletion refuses active work.

A confirmed `cancelled` generation is terminal, excluded from worker claims,
rendered with the existing failure treatment and included in the Failed filter.
It remains in history/counts and can be deleted under the usual admin rule.
Updates use the existing serialized history/realtime transport.

Veevee has no customer credit ledger. Confirmed cancellation of a submitted
task retains the estimated provider cost and records
`cost_basis=cancelled_billing_unconfirmed`. The rolling spend gate includes those
rows. This is conservative accounting, not a promise of a refund or a zero
provider charge. Queued work cancelled before any provider task existed was
never sent: it records cost 0 with `cost_basis=cancelled_before_submission` and
is excluded from the spend gate.

Migration `generation.0006` is additive and nullable. Apply it through the
controlled release process before promoting code that reads the new field.
No deploy or migration runs automatically at application startup.

Official contracts:

- [ModelArk cancel or delete](https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api)
- [Gemini Interactions cancellation](https://ai.google.dev/api/interactions-api#canceling-an-interaction)
- [OmniHuman 2.0](https://docs.byteplus.com/en/docs/byteplus-vision/omnihuman-2-0-video-generation)
- [Higgsfield REST cancellation](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request)

Behavioral coverage is in `backend/apps/generation/test_cancellation.py`, plus
provider/poller, card action, filter and migration suites. Live cancel canaries
need separate approval; disposable mock results do not establish live acceptance.

## Provider audit

Checked 2026-10-25, including persisted historical models.

| Provider / model | Cancel endpoint in official API | Eligible provider states | Billing on confirmed cancellation | Resulting provider state / UI eligibility |
| --- | --- | --- | --- | --- |
| Gemini / Nano Banana Pro | None in [generateContent](https://ai.google.dev/api/generate-content) | None documented | N/A - no supported cancellation | No Cancel |
| Gemini / Nano Banana 2.1 | None in [generateContent](https://ai.google.dev/api/generate-content) | None documented | N/A - no supported cancellation | No Cancel |
| Gemini / Nano Banana 2 (unoffered) | None in [generateContent](https://ai.google.dev/api/generate-content) | None documented | N/A - no supported cancellation | No Cancel |
| Seedream / Seedream 5.0 Pro | None in [image generations](https://docs.byteplus.com/en/docs/modelark/image-generation-api) | None documented | N/A - no supported cancellation | No Cancel |
| Kling / Kling Image 3.0 | None in [image generation reference](https://kling.ai/document-api/api/image/3-0-omni) | None documented | N/A - no supported cancellation | No Cancel; submitted / processing / succeed / failed lifecycle |
| Kling / Kling Image 2.1 | None documented in [image generation API](https://app.klingai.com/global/dev/document-api/apiReference/model/imageGeneration) | None documented | N/A - no supported cancellation | No Cancel; no documented cancel state |
| BytePlus ModelArk / Seedance 2.0 | [DELETE /contents/generations/tasks/{id}](https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api) | queued only; running refused | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | cancelled; verify by subsequent GET |
| BytePlus ModelArk / Seedance 2.0 Mini (unoffered) | [DELETE /contents/generations/tasks/{id}](https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api) | queued only; running refused | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | cancelled; verify by subsequent GET |
| BytePlus ModelArk / Seedance 2.5 | [DELETE /contents/generations/tasks/{id}](https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api) | queued only; running refused | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | cancelled; verify by subsequent GET |
| Google Interactions / Gemini Omni Flash 1.1 | [POST /interactions/{id}/cancel](https://ai.google.dev/api/interactions-api#canceling-an-interaction) | Running background interactions only | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | cancelled on confirmation; returns Interaction resource |
| Google Interactions / Gemini Omni Flash (retired) | [POST /interactions/{id}/cancel](https://ai.google.dev/api/interactions-api#canceling-an-interaction) | Running background interactions only | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | cancelled on confirmation; returns Interaction resource |
| Local / Depth Anything | N/A - local worker, no provider cancel API | N/A | N/A | No Cancel under provider-only scope |
| Magnific / Magnific Creative | None in [model reference](https://docs.magnific.com/api-reference/image-upscaler-creative/image-upscaler) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Precision V2 | None in [model reference](https://docs.magnific.com/api-reference/image-upscaler-precision-v2/overview) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Precision V1 | None in [model reference](https://docs.magnific.com/api-reference/image-upscaler-precision/image-upscaler) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Video Creative | None in [model reference](https://docs.magnific.com/api-reference/video/video-upscaler/overview) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Video Creative Turbo | None in [model reference](https://docs.magnific.com/api-reference/video/video-upscaler/upscale-video-turbo) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Video Precision | None in [model reference](https://docs.magnific.com/api-reference/video/video-upscaler-precision/overview) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Magnific / Magnific Video Topaz | None in [model reference](https://docs.magnific.com/api-reference/video/video-upscaler-topaz/overview) | None documented | N/A - no supported cancellation | No Cancel; create / get / list API surface |
| Higgsfield MCP / Higgsfield Nano Banana Pro (unoffered) | REST has [POST /requests/{request_id}/cancel](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request); hosted MCP equivalent not documented in reviewed official sources | REST: all jobs queued; MCP: unverified | REST: [queued cancellations refunded](https://docs.higgsfield.ai/docs/concepts/billing-and-retention); do not assume REST contract applies to MCP | REST: canceled; MCP support unresolved, so no Cancel until verified |
| Higgsfield MCP / Higgsfield Soul (unoffered) | REST has [POST /requests/{request_id}/cancel](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request); hosted MCP equivalent not documented in reviewed official sources | REST: all jobs queued; MCP: unverified | REST: [queued cancellations refunded](https://docs.higgsfield.ai/docs/concepts/billing-and-retention); do not assume REST contract applies to MCP | REST: canceled; MCP support unresolved, so no Cancel until verified |
| Higgsfield MCP / Higgsfield Seedance 2.0 (unoffered) | REST has [POST /requests/{request_id}/cancel](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request); hosted MCP equivalent not documented in reviewed official sources | REST: all jobs queued; MCP: unverified | REST: [queued cancellations refunded](https://docs.higgsfield.ai/docs/concepts/billing-and-retention); do not assume REST contract applies to MCP | REST: canceled; MCP support unresolved, so no Cancel until verified |
| Higgsfield MCP / Higgsfield Seedance 2.0 Mini (unoffered) | REST has [POST /requests/{request_id}/cancel](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request); hosted MCP equivalent not documented in reviewed official sources | REST: all jobs queued; MCP: unverified | REST: [queued cancellations refunded](https://docs.higgsfield.ai/docs/concepts/billing-and-retention); do not assume REST contract applies to MCP | REST: canceled; MCP support unresolved, so no Cancel until verified |
| BytePlus Vision / OmniHuman 2.0 (separate change, not yet registered) | [POST /?Action=CVCancelTask&Version=2024-06-06](https://docs.byteplus.com/en/docs/byteplus-vision/omnihuman-2-0-video-generation) | in_queue only; generating / executed task refused with code 50217 | Unspecified; retain estimate, mark billing unconfirmed (decision 002) | canceled; success code 10000 followed by result reconciliation |

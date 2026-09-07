# Seedream 5.0 Pro release evidence

Status on 2026-09-07: implementation and local automated checks complete; model activated with explicit user approval; six direct-provider live requests completed; authenticated preview acceptance and production promotion pending.

Production patch starts at `960766e` (current main when work began). Django/Vite mirror starts at `5c8279e`; the broader migration is not part of the production patch. Nano Banana Pro remains the default model. Seedream defaults to 2K PNG, standard prompt optimization, watermark off, and independent queued requests.

## Verified provider contract

Official [image generation tutorial](https://docs.byteplus.com/api/docs/ModelArk/1824121) and [pricing](https://docs.byteplus.com/en/docs/modelark/1544106), retrieved September 7 from embedded MDContent in the documentation pages:

- Model `dola-seedream-5-0-pro-260628`; optional `SEEDREAM_MODEL` override.
- Pro-specific 1K/2K pixel dimensions; six existing app aspect ratios. No streaming, sequential generation, seed, or native batches sent.
- Up to ten resolved references; missing upload/asset tags fail before provider submission. Original stored references remain unchanged when compliant; oversized decodable references shrink without cropping or upscaling. Opaque conversions use JPEG quality 92; transparency uses PNG. Corrupt, animated, unsupported, or excessively large undecodable input produces an actionable error.
- The current published pricing boundary is **2.61 million pixels**, superseding the plan's 2.36 million. Rates are $0.045/$0.09 per output, plus $0.003 per reference after the first. Both supported size families remain in their expected price tiers. Rates are admin-editable per 1,000 images; costs round only after summing and remain estimates.
- Original PNG results are persisted before display thumbnails; dimensions are measured from bytes. Provider URLs are not retained in history.

## Local verification

- Production Node 22: 790 tests passed, including provider payload/error/abort handling, exact dimensions, reference order/asset expansion, ten/eleven-reference boundary, original-byte preservation, oversized conversion, sequential preparation, and pricing boundaries.
- Production ESLint and Next.js build passed; final commit build to be reconfirmed before promotion.
- Migration: 812 frontend tests passed; ESLint and Vite production build passed against the existing preview API origin.
- Django: 349 relevant existing/new tests passed against an isolated PostgreSQL instance, followed by 11 focused Seedream tests including authenticated upload, idempotent pricing seed/admin unit preservation, enqueue validation and queue dispatch/persistence.
- No database schema migration is introduced. Existing administrator rates are not overwritten.

## Live gate

Initial configuration files contained redacted placeholders; attempts stopped before network submission. After the user supplied an Ark key, the documented Singapore endpoint returned HTTP 404 `ModelNotOpen` in 847 ms. No successful output has been generated. No ambiguous timed-out request has been retried. No qualitative detail-preservation or latency claim is made from mocked tests.

Enable Seedream 5.0 Pro in the account before continuing the approved maximum $5 live validation. Required cases: text generation, one-reference edit, multi-reference composition, both output sizes, and original-versus-2048 comparison. Synthetic fixtures only. Record outputs, actual dimensions, latency and cumulative estimated spend. Unseeded comparisons are qualitative.

Production promotion remains gated on those cases, authenticated preview/browser checks, and a successful deployed upload/generation/history/reuse/download/cost check. Record feature commits, deployment IDs and retained prior production deployment before promotion. Migration previews are separate and retain `docs/cutover-go-no-go.md` unchanged.

## Preview deployment checkpoint

- Production application code: `b1b6409`, draft PR [#38](https://github.com/amazingindianstories-stack/AIStudio/pull/38). GitHub web/database checks and Vercel checks passed.
- Next.js preview with supplied Ark configuration: `dpl_4DXNpMgHxaRSUcbyj6E1VMRc3Epg`, https://aistudio-v1-lcaerfxq5-amazing-indian-stories.vercel.app (Ready).
- Migration application code: `1ec5b50`. Vite preview: `dpl_7yzywezj5u9cu3uywEm7Bx29JCMf`, https://aistudio-cutover-preview.vercel.app (Ready).
- Django preview after Ark configuration: `da6d1681-cc6a-48e8-8ab9-3f1368b0fd3f` (SUCCESS); `/api/health` reports HTTP 200, `db: true`.
- Retained production: `dpl_FNsZRUGATFD8hjUaqdTBsvPfPb5A`, Ready on www.veevee.ai; no production promotion performed.
- Preview key/base configuration is limited to the feature-branch Vercel environment and the Django cutover-preview API. Existing production credentials and migration cron schedules remain unchanged.
- Browser: Next preview reaches Vercel sign-in; authenticated acceptance is pending. API rejects unauthenticated requests.
- ModelArk console confirms Dola-Seedream-5.0-pro is not activated. Its activation dialog requires acceptance of the Customer Agreement, Service Specific Terms and GenAI Acceptable Use Policy; action-time confirmation is pending. Dialog: https://console.byteplus.com/ark/region:ap-southeast-1/openManagement?tab=ComputerVision .
- Synthetic 4096px and 2048px comparison fixtures are prepared. `scripts/seedream-live-suite.js prepare` performs no generation; named cases or `all` submit with a persisted budget ledger and never automatically repeat an attempted case. The six-case maximum estimate is $0.498, with a $1 suite guard leaving room under the $5 total session ceiling for deployed-app acceptance. Live cases have not run.
- Follow-up hardening preserves upload tags in compounds such as `@img1-inspired`; the 10 focused Node and 11 Django tests pass after this adjustment. Preview IDs above identify the preceding application builds; refresh previews after the follow-up commit before acceptance.

## Activation and current acceptance build

Seedream Pro was activated on September 7 with explicit user authorization to accept the BytePlus customer, service-specific and GenAI acceptable-use terms. Only Seedream was selected; automatic activation and diagnostic retention remained off.

- Next code: `1fb3329`; preview `dpl_G3z2T3vT27LvGEjtAH493vMtxLaK` at https://aistudio-v1-22ekur3fw-amazing-indian-stories.vercel.app . All remote checks passed.
- Migration code: `5b35d20`; frontend `dpl_CPSVcgKMuB8zvsyQ2mWm67kZFuVE` at https://aistudio-cutover-preview.vercel.app . All remote checks passed.
- Migration backend: `2a99ba91-e0a9-41d4-8487-40bd13205ec7`, SUCCESS.
- Live text checks succeeded: 2K 2048×2048 PNG in 51.329 seconds; 1K portrait 800×1424 PNG in 29.270 seconds. The 2K output visibly follows the teapot, engraving, ribbon and printed-card prompt. Reference cases are in progress.
- Latest Next preview passes Vercel access but needs a separate app login; the older deployment's app session does not carry across deployment hostnames.

Qualitative findings so far: single-reference edit produced the requested green tile 28, with all 64 numbered tiles and line patterns visibly retained (2048×2048, 117.145 s). Multi-reference composition successfully placed the grid left and ROUND emblem right (2368×1776, 97.748 s), but condensed the grid to seven columns and corrupted several numbers. This is a model-fidelity limitation, not evidence of exact reference preservation in generated content. The application preserves reference input bytes; generation remains probabilistic.

## Completed direct-provider live suite

All six requests returned decodable PNG outputs, with no resubmission. Published-rate estimated total: **$0.498** of the authorized $5 (not invoice-reconciled).

| Case | Dimensions | Seconds | Estimated USD |
| --- | --- | ---: | ---: |
| text-2k | 2048×2048 | 51.329 | 0.090 |
| text-1k | 800×1424 | 29.270 | 0.045 |
| single-edit | 2048×2048 | 117.145 | 0.090 |
| multi-composition | 2368×1776 | 97.748 | 0.093 |
| compare-original | 2048×2048 | 94.370 | 0.090 |
| compare-2048 | 2048×2048 | 111.861 | 0.090 |

Both original-4096 and downscaled-2048 comparison outputs retained the 8×8 layout and visibly changed tile 28 to green. Fine lettering remains imperfect; these unseeded samples do not establish a causal quality advantage for either input resolution. Multi-composition limitations are recorded above. Evidence PNGs and the submission ledger are retained locally under `/private/tmp/seedream-live-suite`. Direct-provider success does not replace deployed storage/queue/browser acceptance, which is pending login at the latest Next preview. No production deployment has been promoted.

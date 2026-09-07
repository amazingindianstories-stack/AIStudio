# Seedream 5.0 Pro release evidence

Status on 2026-09-07: implementation and local automated checks complete; live acceptance and production promotion pending model activation.

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

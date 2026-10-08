# Isolated hosted Django preview proposal

Pending user authorization; no hosted resources have been created by this work.
This advances the first settings route toward hosted qualification. It does not
transfer production traffic or reuse the unreconciled historical API service.

## Requested resource scope

- Railway project: balanced-acceptance,
  `e7f74a09-90e4-49db-815e-02e970feaf1c` (revalidate read-only before creation).
- New environment: `django-qualification`; do not clone production variables.
- New API service: `veevee-django-qualification-api`, using committed API inputs
  from `8f703398ceeb4dd5f1784f50433edcaae01b887e`, repository-root build context,
  `backend/Dockerfile` and `backend/railway.toml`.
- New disposable PostgreSQL 16 service: `veevee-django-qualification-db`.
  Database name `veevee_django_migration`; dedicated synthetic fixture data only.
- A public HTTPS API domain generated for the new service, with exact finite
  `DJANGO_ALLOWED_HOSTS`. Generate independent secrets for this environment;
  its AUTH_SECRET must be a fixture secret, never the production signing key.
- No storage/provider credentials, external GPU workers, production data copies
  or inherited shared environment variables.

These are billable hosted resources. Authorization covers their creation and
qualification, not production API selection, schema changes, existing service
replacement, Vercel production deployment or git push. Record actual resource
IDs, deployment identity and cost information available before continuing.

## Execution and validation

1. Export the exact committed API source into a credential-free temporary
   release context. Verify its API fingerprint matches the qualified candidate.
   Never upload the dirty shared checkout or its dotenv files.
2. Create the new environment and services, configure explicit isolated secrets
   and private database transport, and inspect actual target identities without
   printing credentials before any DB utility. If isolation cannot be proven,
   stop that operation.
3. Deploy the API with production settings and health checks. Container startup
   runs no migrations. Initially `/api/health` requires connectivity only.
4. Record committed source/image provenance and hosted HTTPS health/log evidence;
   prove restart recovery and release restoration for this isolated service.
5. Only after verified disposable DB identity, install the reviewed fixture
   schema and synthetic settings/session fixtures explicitly. Current local
   fixture schema includes preserved uncommitted UI-related changes; choose and
   record its exact hash separately before upload. This is qualification data,
   not Django baseline authority or production migration coverage.
6. Qualify hosted settings behavior and sanitization. Actual browser same-origin
   proxying and Secure-cookie renewal require a separately prepared isolated
   frontend preview; do not mark those gates verified from direct API HTTP calls.

## Remaining production release gates

Reconcile deployed services and production schema/transport; qualify hosted
same-origin browser behavior; review the final authoritative UI/source revision;
obtain separately scoped settings canary authorization; monitor, close rollback
window and remove its Node method only after successful authority transfer.

The current local image evidence is in api-image-qualification.json. It is
ARM64 qualification; Railway image architecture must be checked and qualified
rather than inferred. No schema authority or route ownership changes are
included in this proposal.

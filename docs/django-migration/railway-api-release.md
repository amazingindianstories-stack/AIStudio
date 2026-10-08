# Early Django API release review — 2026-10-08

Release scope: a separate Railway Django API service, initially receiving no
frontend traffic. Existing Node API and worker ownership remain unchanged.
The repository configuration is `backend/railway.toml`, using repository-root
context and `backend/Dockerfile`. Do not replace the root worker configuration.

The API-specific `backend/Dockerfile.dockerignore` allows Python source and
requirements only, plus build instructions. Checkout dotenv files, Git data,
frontend artifacts, archives and credentials are excluded from this context.
Docker documents Dockerfile-specific ignore precedence at
https://docs.docker.com/build/concepts/context/.

## Inputs required before creating the service

| Input | Required review |
| --- | --- |
| Railway project/environment | Explicit destination IDs; separate API service name; existing worker identity preserved |
| Source revision | Reviewed, committed revision containing current authoritative UI and migration work; no upload of the dirty checkout |
| PostgreSQL transport | Reviewed host/network path, role, database and libpq TLS/CA configuration; current Cloud SQL connector does not supply this automatically |
| `DATABASE_URL` | Secret injected into Railway; never placed in release evidence or repository |
| `DJANGO_SECRET_KEY` | Independent strong secret injected into Railway |
| `AUTH_SECRET` | Existing compatible session signing secret, injected securely for staged reads |
| `DJANGO_ALLOWED_HOSTS` | Exact API service hostname and any verified forwarded hostname |
| `DJANGO_BROWSER_ORIGINS` | Exact HTTPS frontend origins; no wildcard |
| `DJANGO_SETTINGS_MODULE` | `config.settings.production` (also WSGI default) |

No provider/storage credentials are needed for the initial health/settings
service. No migration command runs on container startup. Schema authority stays
Drizzle. Qualification must continue using disposable resources, never this
shared deployment's credentials.

## Promotion evidence

1. Build the committed API context and verify its contents contain no secrets.
2. Run the container against disposable PostgreSQL, checking production startup,
   `/api/health`, sanitized database failure and structured request logs.
3. Obtain authorization for the explicit Railway destination and DB transport.
4. Create the separate API service with the reviewed configuration and record
   service/environment IDs, source revision and deployment ID without secrets.
5. Check hosted HTTPS health, readiness and logs; establish restart/rollback
   evidence before enabling any frontend route.
6. Qualify hosted same-origin settings forwarding and secure session renewal in
   an isolated preview; record browser and full-schema/PG16 evidence.
7. Request the separately scoped production settings canary authorization.

Service creation, shared DB connectivity and traffic changes remain pending.
Local Docker CLI is installed, but the daemon socket was absent when inspected;
no container build or image-content verification has run. Two-worker Gunicorn
production-settings HTTP qualification is recorded separately and cannot prove
the container or Railway transport.

## Existing Railway inventory (read-only observation)

`railway status --json` inspected on 2026-10-08 identifies linked project
`balanced-acceptance` (`e7f74a09-90e4-49db-815e-02e970feaf1c`). Only service,
environment and deployment metadata was used; no variables were retrieved.

| Environment | Existing API-like service | Active deployment reported SUCCESS |
| --- | --- | --- |
| production (`1699817d-5dbb-404c-b158-81a1d742ff81`) | backend (`61e96d6d-e46a-437e-9d67-006b9a34e3d2`) | `c72572e7-f695-4d3d-b36a-fd9e36f3e203`, created 2026-10-06 |
| cutover-preview (`4e0f5a6b-dc96-4b60-ab23-8f63b45d5bdf`) | veevee-api-preview (`c9167333-ac15-43bb-8dda-24ea67c37afc`) | `c201181c-26be-4672-a123-a39044a45b14`, created 2026-09-08 |

Preview reports start command `./run-service.sh api`, which differs from this
checkout's API Dockerfile. Production backend metadata includes a deployment
message referring to Gunicorn. Neither proves deployed code identity, current
frontend routing, database isolation, contract parity or ownership transfer for
this migration. Reconcile deployed source/configuration and routing before
choosing a new service or reusing an existing service. Do not overwrite either
service based on its name or SUCCESS status. Existing generation, export and
maintenance workers were also observed and must be preserved.

## Runtime/source reconciliation follow-up

Read-only build/startup log inspection on 2026-10-08 yielded:

- Production deployment startup explicitly reports Gunicorn 26.0.0 and workers
  booting on 2026-10-06. This checkout pins Gunicorn below 24. Its source cannot
  be identified from that runtime version or deployment message.
- Preview build installs Django 5.2.17, DRF 3.18.0 and Gunicorn 26.0.0, matching
  the requirements at local Git object
  `4c983208f4ab0eed59c558eab31a05c73f496c80`. The deployment message names
  `4c98320`, but a CLI message is not a cryptographic source attestation.
- That historical object has a multi-domain Django backend and Vite files.
  Its configured `./run-service.sh api` does not exist in that commit, so the
  deployed upload is not demonstrated to be the exact committed tree.
- `git branch -a --contains 4c98320` returns no refs; the object exists locally
  but is not reachable from the currently listed branches. `git log --all`
  alone therefore missed this deployment-linked historical evidence. Its merge
  base with current HEAD is `7539967cda49b1f285931e136583b2432b689e39`.

These services are established deployment infrastructure, but not qualification
evidence for the current Django implementation. Next action: reconcile deployed
source provenance and actual frontend rewrite destination. Do not infer that
all live traffic is Node-owned solely from the repository ownership manifest;
it records this migration's declared state, while live routing remains unproven.
No DB query, secret retrieval, request mutation or deployment was performed.

## Frontend deployment reconciliation

Read-only Vercel project/list/inspect commands on 2026-10-08 identify project
`aistudio-v1` as Next.js. Current production deployment
`dpl_Aw9qb3spGS9jswTZijRXen4Dt4ex` reports source commit
`a208e8aee3c6aa052a9482f996235e4992618a8b` on
`fix/preview-regressions-codex`, matching this migration's repository baseline.
Its aliases include `veevee.ai` and `www.veevee.ai`. Deployment build outputs
include the business API lambdas, including `/api/settings` and `/api/auth/login`.
The sanitized machine-readable inventory is frontend-deployment-evidence.json.

Baseline source has no Django method-selection rewrite and defaults its browser
API base to same-origin. It also permits `NEXT_PUBLIC_API_URL` to override that
base. Build-output function presence and source defaults do not prove the
compiled override value or every actual request destination. Live browser
destination/edge-routing verification remains required. No secret variables or
production API mutations were requested. Existing Railway Django services must
therefore be treated as separate, unreconciled infrastructure rather than proof
that this frontend has transferred ownership.

## Public compiled login asset observation

On 2026-10-08, unauthenticated GETs fetched only `/login` and its public static
JavaScript assets. The page redirects from `veevee.ai` to `www.veevee.ai` and
references deployment `dpl_Aw9qb3spGS9jswTZijRXen4Dt4ex` in its asset URLs.
No API request, login submission, cookie or credential was supplied.

Observed login asset:
`/_next/static/chunks/app/login/page-3d7a608a47106283.js`.
Module 55490 computes `(process.env.NEXT_PUBLIC_API_URL || '').replace(...)`
and fetches the resulting base plus `/api/auth/login` with credentials included.
The process resolver in shared asset
`/_next/static/chunks/1255-4b24d74c3ca6c089.js` selects a global process only
when present with an environment; otherwise module 53965 supplies the browser
shim with `env={}`. The returned HTML contains no `NEXT_PUBLIC_API_URL`,
`window.process` or `globalThis.process` assignment.

Inference from these observed assets: the ordinary browser login request uses
the frontend's same-origin `/api/auth/login`. This narrows the API-base gap for
the observed login page. It does not verify runtime browser requests, all app
chunks, edge forwarding, authenticated responses or the Railway backend's role.
No production qualification tests were run; this was public asset inspection.

## Local container build qualification

Docker Desktop was started on 2026-10-08; its daemon reports 29.5.3. The
isolated runner verified the dedicated PostgreSQL process and clean source copy
before running `scripts/django-migration/container-build.py`. That script uses
an empty temporary Docker configuration, bundled buildx discovery and explicit
BuildKit build, then inspects the image with networking disabled.

The first legacy build sent 390.3 MB of the sanitized copy and did not establish
context exclusion coverage. A subsequent image inventory caught `railway.toml`
being included by the broad backend directory exception. The final ignore file
explicitly re-excludes backend descendants before allowing Python/requirements
and build instructions. Final BuildKit context transfer was 71.21 kB; image
inspection passed with 56 application files and no unexpected file extensions.
Runtime imports report Django 5.2.18, DRF 3.18.3 and Gunicorn 23.0.0.

Image config digest: `sha256:882524b0d2474dd6cf84336d7c45d7e52f1e07f3ee6bcd33e93b2f1d30522fb9`.
This is a local ARM64 build/import/file-inventory check. Container HTTP startup,
disposable PG16 connectivity, failure/readiness behavior, Railway architecture
and hosted TLS remain unqualified. Earlier daemon-unavailable statements above
describe the initial observation and are superseded by this build evidence.

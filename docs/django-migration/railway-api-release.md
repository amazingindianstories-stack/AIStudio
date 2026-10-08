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

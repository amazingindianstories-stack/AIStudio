# Veevee

Internal image and video production application: prompt composer with references, hosted image
and video providers, a project/folder library, canvas boards and native-master exports.

- Frontend: Next.js on Vercel (`src/`), transport only.
- Backend: Django + DRF on Railway (`backend/`): API, generation worker, export worker, scheduler.
- See [docs/architecture/overview.md](docs/architecture/overview.md) for how the pieces fit and
  [docs/operations/status.md](docs/operations/status.md) for the current production state.

## Run it locally

The whole stack (restored data copy, fake providers, every service, the frontend):

```sh
local/veevee.sh up && local/veevee.sh user && local/veevee.sh frontend
```

Details in [local/README.md](local/README.md).

## Test

```sh
npm ci && npm test && npm run lint && npm run build          # frontend
scripts/dev/test-db.sh PYTHON backend/manage.py test backend  # Django suite on a throwaway PostgreSQL 18.6
scripts/dev/test-db.sh PYTHON scripts/dev/browser-harness.py --install-browser   # Playwright through Django
```

`PYTHON` is an interpreter with `backend/requirements.txt` installed (constraints in
`backend/constraints-qualified.txt`). The native runs need Docker, Node 22+, ffmpeg and libvips.

## Release

Every backend deploy needs both `scripts/release/release_gate.sh <commit>` and
`scripts/release/rehearse_local.sh <commit>` to pass, then explicit owner approval. Follow
[docs/operations/release-runbook.md](docs/operations/release-runbook.md).

This repository is public: never commit credentials, connection strings or private hostnames.

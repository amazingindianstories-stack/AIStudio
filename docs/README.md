# Veevee documentation

| Document | Use it for |
|---|---|
| [architecture/overview.md](architecture/overview.md) | How the services fit together and where code lives |
| [architecture/ADR-django-authoritative-backend.md](architecture/ADR-django-authoritative-backend.md) | Why Django owns the backend |
| [architecture/permanent-generation-names.md](architecture/permanent-generation-names.md) | Permanent generation names, their upgrade, and library delete/move authorization |
| [architecture/generation-cancellation.md](architecture/generation-cancellation.md) | Provider-backed generation cancellation, its paid-guard allowance and the provider cancel audit |
| [architecture/agent-access.md](architecture/agent-access.md) | Agent (MCP) access: tokens, the OAuth 2.1 server, the per-user opt-in, spending controls and the interface for the MCP service |
| [architecture/mcp-server.md](architecture/mcp-server.md) | The MCP server: request path, access checks and kill switches, every tool, quotes and holds, resources, prompts, the dev harness |
| [architecture/canvas-board-sync.md](architecture/canvas-board-sync.md) | Conflict-safe board autosave: the versioned save contract, board polling, the client merge and local drafts |
| [features/library-filters.md](features/library-filters.md) | Library Filters dialog, `GET /api/history` filter/sort contract, date sections |
| [operations/status.md](operations/status.md) | Current production state, incidents, owner approval gates and open items |
| [operations/release-runbook.md](operations/release-runbook.md) | Release gates, staging and rolling a backend commit to Railway, rollback |
| [operations/managed-portraits.md](operations/managed-portraits.md) | Rollout and rollback of the automatic BytePlus portrait pool |
| [providers/omnihuman.md](providers/omnihuman.md) | BytePlus OmniHuman 2.0 inputs, task lifecycle and activation prerequisites |
| [../local/README.md](../local/README.md) | Running the whole stack on one machine |
| [../depth-worker/README.md](../depth-worker/README.md) | The external GPU depth-map worker |

Keep this set current rather than adding dated plans or reports. Record decisions in an ADR,
operational facts in `operations/status.md`, and procedures in the runbooks.

## Retired documents

The migration-era plans, audits, goal prompts, qualification evidence and design records were
removed from the tree on 2026-10-15. Every one of them is still in Git at commit `19951cb`:

```sh
git show 19951cb:<path>          # read one file
git ls-tree -r --name-only 19951cb -- docs .council   # list what existed
```

| Former path | What it was |
|---|---|
| `Veevee_Django_Migration_Blueprint_2026-10-08.md`, `DEPLOYMENT_RUNBOOK.md` | Django migration blueprint and pre-cutover release plan |
| `docs/django-migration/` | Route/contract inventories, qualification reports, evidence logs, cutover and rollback plans |
| `docs/stabilization/` | Now `docs/operations/` (`STATUS.md`, `CUTOVER.md`, `MANAGED_PORTRAITS.md`) |
| `docs/audit/remediation-tracker.md` | August 2026 issue register; unresolved rows copied to `operations/status.md` |
| `docs/*.md` (naming architecture, generation coordinator, runtime coordination, ComfyUI, Seedream release, video input, canvas context bug, prompt research) | Node-era design notes |
| `progress.md`, `BACKEND_AUDIT.md`, `upgrade.md` | Node-era handoff log, backend audit, GCP migration plan |
| `FREEFORM_HIERARCHICAL_LIBRARY_PLAN.md`, `Veevee V1 ... CODEX TAKEOVER.md`, `output-quality-engineering-research.md`, `style-drift-and-quality-implementation-plan.md` | Agent prompts and research notes |
| `.council/` | Design records from the council skill (now local-only and ignored) |
| `pyserver/` | Unused InstantID SDXL server |
| `scripts/django-migration/`, `scripts/check-backend-ownership.mjs` | Migration probes, parity scripts and the old CI driver |

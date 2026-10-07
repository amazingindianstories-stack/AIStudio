# ADR: Django is the authoritative backend destination

Date: 2026-10-07. Status: Accepted architecture; implementation in progress.

The current production repository and verified live schema define product
behavior. Historical Django implementations are reference material only.

| Responsibility | Final owner |
|---|---|
| Frontend / application shell | Next.js on Vercel |
| HTTP API, authentication, business logic | Django + DRF on Railway |
| Database models and schema evolution | Django ORM and Django migrations |
| Relational and transactional persistence | Existing PostgreSQL |
| Media/object storage | Existing GCS architecture, qualified legacy fallback |
| Background execution | Python/Django workers on Railway |
| Depth ML runtime | External/local GPU worker communicating with Django |

Django cannot be retired to resolve parity issues. New backend features belong
in Django. Transfer route methods incrementally through same-origin `/api`;
never globally switch browser API origins. A domain has one traffic owner.
Duplicated Node/Django implementations are temporary qualification/rollback
infrastructure. After measured production stability and the recorded rollback
window, remove the Node owner. Subsequently use normal release restoration.

Drizzle remains temporary schema authority until fresh Django migrations,
complete catalog equivalence, production schema review, backup/PITR and safe
migration-history baselining pass. Do not fake migrations merely because tables
exist. After takeover Django migrations are the sole schema authority; no new
Drizzle push, ad-hoc JS schema mutations or HTTP admin migration authority.

Achieve all-business-API ownership before rewriting provider execution. Split
worker process boundaries, then qualify export and generation Python workers;
provider-by-provider shadow parity and authorized canaries precede ownership.

No frontend framework change, Cloud SQL cutover, storage redesign, or automatic
Redis/Celery/broker introduction. Preserve native MOV masters and current UI,
naming, exports, concurrency, worker fencing and shared-workspace access.

Production-impacting actions stop at the documented authorization gate. Local
safe implementation and isolated tests continue. Status and ownership manifests
must distinguish implementation/parity from deployed traffic and deletion.

```mermaid
flowchart TD
  Browser -->|same-origin /api| Vercel[Next.js frontend / Vercel proxy]
  Vercel --> Django[Django + DRF / Railway]
  Django --> PG[PostgreSQL / Django migrations]
  Django -->|authorize and sign| GCS[GCS / CDN]
  Browser -->|media bytes| GCS
  Python[Python generation and export workers / Railway] --> PG
  Python --> Providers[Qualified providers]
  Python --> GCS
  Depth[External GPU worker] --> Django
```

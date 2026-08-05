# GCP production infrastructure

The application uses one keyless Vercel workload identity for Cloud SQL and
Cloud Storage. Do not create or upload a service-account JSON key.

## Media delivery: signed URLs (required)

`GET /api/media/<key>` redirects the browser to a signed GCS URL instead of
streaming the object through the Vercel function. Without this the function
proxies every image and video byte, which is what produced the 2026-08-04
`/api/media/[...path]` 504 alert.

Signing under Workload Identity Federation goes through the IAM `signBlob` API
rather than a private key, and it is called with the runtime service account's
own impersonated token — so the service account needs
`roles/iam.serviceAccountTokenCreator` **on itself**. The workload identity pool
principal already holds that role on the account (that is what makes
`generateAccessToken` impersonation work); the self-binding is separate and is
easy to miss.

```bash
SA="$(gcloud iam service-accounts list --project=ais-project-for-gcp \
  --filter='displayName~Vercel OR email~aistudio' --format='value(email)')"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project=ais-project-for-gcp \
  --member="serviceAccount:$SA" \
  --role=roles/iam.serviceAccountTokenCreator
```

Confirm it took effect from the app itself: **Admin → Status → Media Delivery**
reports `Signed URLs — GCS V4 via IAM signBlob (...)` when signing works, and
`Proxying bytes through the function — <reason>` when it does not. The route
falls back to proxying rather than erroring, so this row is the only place the
difference is visible.

## Media CDN

The bucket remains private. Cloud CDN reads it through the Google-managed HTTPS
load-balancer service account, while the application service account retains
write access.

```bash
MEDIA_DOMAIN=media.example.com ./infra/gcp/bootstrap-media-cdn.sh
```

Create the printed DNS A record. Once the managed certificate reports `ACTIVE`,
set `GCP_MEDIA_CDN_URL=https://media.example.com` in Vercel production and
preview. The compatibility route `/api/media/<key>` then returns a 307 redirect,
so media bytes bypass Vercel.

Do not run the script until the final media hostname is known; managed
certificates are tied to that hostname.

## Storage lifecycle

The lifecycle file deletes database migration snapshots after 30 days. It does
not expire user media because the product does not yet have an explicit media
retention policy.

```bash
gcloud storage buckets update gs://aistudio-media-bucket \
  --lifecycle-file=infra/gcp/storage-lifecycle.json
```

## Database administration

Application traffic uses the Cloud SQL Node.js Connector with automatic IAM
database authentication. Schema administration should use the Auth Proxy and
the built-in `postgres` account; do not grant DDL privileges to the runtime
service account.

```bash
./cloud-sql-proxy --port 6543 \
  ais-project-for-gcp:us-central1:aistudio-db
```

Set a temporary local `DATABASE_URL` for port 6543 when running Drizzle. Never
put the built-in database password in Vercel.

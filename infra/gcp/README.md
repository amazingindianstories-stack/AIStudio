# GCP production infrastructure

The application uses one keyless Vercel workload identity for Cloud SQL and
Cloud Storage. Do not create or upload a service-account JSON key.

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

#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-ais-project-for-gcp}"
PROJECT_NUMBER="${GCP_PROJECT_NUMBER:-303288602776}"
BUCKET="${GCP_MEDIA_BUCKET:-aistudio-media-bucket}"
DOMAIN="${MEDIA_DOMAIN:?Set MEDIA_DOMAIN, for example media.example.com}"

BACKEND="aistudio-media-backend"
ADDRESS="aistudio-media-ip"
URL_MAP="aistudio-media-map"
CERT="aistudio-media-cert"
PROXY="aistudio-media-https-proxy"
FORWARDING_RULE="aistudio-media-https-rule"

gcloud services enable compute.googleapis.com --project="$PROJECT_ID"

gcloud compute backend-buckets describe "$BACKEND" \
  --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute backend-buckets create "$BACKEND" \
    --project="$PROJECT_ID" \
    --gcs-bucket-name="$BUCKET" \
    --enable-cdn \
    --cache-mode=CACHE_ALL_STATIC

# The load-balancer service account is created after the first backend bucket.
#
# SECURITY: scoped with an IAM condition that excludes settings/ and
# migrations/ — those two prefixes hold secrets (the Higgsfield MCP OAuth
# token) and full Postgres dump snapshots, not user media. A bucket-wide
# grant here would let the CDN serve them to anyone on the internet with no
# auth at all once GCP_MEDIA_CDN_URL is set, bypassing the app's own
# session check entirely (found in security review, 2026-07-15). Do not
# widen this back to an unconditional grant without moving those two
# prefixes to a bucket that is never wired to this backend-bucket.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@https-lb.iam.gserviceaccount.com" \
  --role=roles/storage.objectViewer \
  --condition="expression=!resource.name.startsWith(\"projects/_/buckets/$BUCKET/objects/settings/\") && !resource.name.startsWith(\"projects/_/buckets/$BUCKET/objects/migrations/\"),title=exclude-secrets-and-db-dumps,description=Excludes internal settings and migration snapshot objects from public CDN read access"

gcloud compute addresses describe "$ADDRESS" \
  --project="$PROJECT_ID" --global >/dev/null 2>&1 || \
  gcloud compute addresses create "$ADDRESS" \
    --project="$PROJECT_ID" --global --ip-version=IPV4

gcloud compute url-maps describe "$URL_MAP" \
  --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute url-maps create "$URL_MAP" \
    --project="$PROJECT_ID" --default-backend-bucket="$BACKEND"

gcloud compute ssl-certificates describe "$CERT" \
  --project="$PROJECT_ID" --global >/dev/null 2>&1 || \
  gcloud compute ssl-certificates create "$CERT" \
    --project="$PROJECT_ID" --global --domains="$DOMAIN"

gcloud compute target-https-proxies describe "$PROXY" \
  --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute target-https-proxies create "$PROXY" \
    --project="$PROJECT_ID" --url-map="$URL_MAP" --ssl-certificates="$CERT"

gcloud compute forwarding-rules describe "$FORWARDING_RULE" \
  --project="$PROJECT_ID" --global >/dev/null 2>&1 || \
  gcloud compute forwarding-rules create "$FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --network-tier=PREMIUM \
    --address="$ADDRESS" \
    --target-https-proxy="$PROXY" \
    --ports=443

IP="$(gcloud compute addresses describe "$ADDRESS" \
  --project="$PROJECT_ID" --global --format='value(address)')"
printf 'Create DNS A record: %s -> %s\n' "$DOMAIN" "$IP"
printf 'After the certificate is ACTIVE, set GCP_MEDIA_CDN_URL=https://%s\n' "$DOMAIN"

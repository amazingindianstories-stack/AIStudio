#!/bin/bash
echo "Waiting for SQL instance to be RUNNABLE..."
while true; do
  STATE=$(gcloud sql instances describe aistudio-db --format="value(state)")
  echo "Current state: $STATE"
  if [ "$STATE" == "RUNNABLE" ]; then
    break
  fi
  sleep 30
done

echo "Setting postgres user password..."
gcloud sql users set-password postgres --instance=aistudio-db --password=postgres

echo "Deploying to Cloud Run..."
gcloud run deploy aistudio-app \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --add-cloudsql-instances ais-project-for-gcp:us-central1:aistudio-db \
  --set-env-vars="DATABASE_URL=postgres://postgres:postgres@/postgres?host=/cloudsql/ais-project-for-gcp:us-central1:aistudio-db,GCS_BUCKET_NAME=aistudio-media-bucket-gcp"

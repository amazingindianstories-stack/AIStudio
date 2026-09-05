import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway((ctx) => {
  if (!ctx.isEnvironment("cutover-preview")) {
    throw new Error("This Railway specification is restricted to cutover-preview.");
  }

  const Postgres = postgres("Postgres", { region: "sfo" });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const loginCleanupPreview = service("login-cleanup-preview", {
    replicas: { "sfo": 1 },
    start: "./run-service.sh login-cleanup",
    deploy: {
      cronSchedule: "17 3 * * *",
      restartPolicyType: "NEVER",
    },
    env: { AUTH_SECRET: preserve(), CRON_SECRET: preserve(), DATABASE_URL: preserve(), DJANGO_ALLOWED_HOSTS: preserve(), DJANGO_DEBUG: preserve(), DJANGO_SECRET_KEY: preserve(), GCP_MEDIA_BUCKET: preserve(), GCP_PROJECT_ID: preserve(), MEDIA_BACKEND: preserve(), SECURE_HSTS_SECONDS: preserve() },
  });
  const videoReconciliationPreview = service("video-reconciliation-preview", {
    replicas: { "sfo": 1 },
    start: "./run-service.sh video-reconciliation",
    deploy: {
      cronSchedule: "*/15 * * * *",
      restartPolicyType: "NEVER",
    },
    env: { AUTH_SECRET: preserve(), CRON_SECRET: preserve(), DATABASE_URL: preserve(), DJANGO_ALLOWED_HOSTS: preserve(), DJANGO_DEBUG: preserve(), DJANGO_SECRET_KEY: preserve(), GCP_MEDIA_BUCKET: preserve(), GCP_PROJECT_ID: preserve(), GCP_SERVICE_ACCOUNT_JSON: preserve(), MEDIA_BACKEND: preserve(), SECURE_HSTS_SECONDS: preserve() },
  });
  const veeveeApiPreview = service("veevee-api-preview", {
    replicas: { "sfo": 1 },
    start: "./run-service.sh api",
    healthcheck: "/api/health",
    healthcheckTimeout: 100,
    deploy: {
      restartPolicyMaxRetries: 3,
    },
    env: { AUTH_SECRET: preserve(), CORS_ALLOWED_ORIGINS: preserve(), CRON_SECRET: preserve(), CSRF_TRUSTED_ORIGINS: preserve(), DATABASE_URL: preserve(), DEPTH_WORKER_TOKEN: preserve(), DJANGO_ALLOWED_HOSTS: preserve(), DJANGO_DEBUG: preserve(), DJANGO_SECRET_KEY: preserve(), GCP_MEDIA_BUCKET: preserve(), GCP_PROJECT_ID: preserve(), GCP_SERVICE_ACCOUNT_JSON: preserve(), MEDIA_BACKEND: preserve(), SECURE_HSTS_SECONDS: preserve(), SET_TOKEN_SECRET: preserve() },
  });

  return project("balanced-acceptance", {
    resources: [Postgres, loginCleanupPreview, videoReconciliationPreview, veeveeApiPreview, postgresVolume],
  });
});

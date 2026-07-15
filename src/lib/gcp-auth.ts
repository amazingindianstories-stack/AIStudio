import { getVercelOidcToken } from "@vercel/oidc";
import {
  ExternalAccountClient,
  GoogleAuth,
  type AuthClient,
} from "google-auth-library";
import {
  ExternalAccountClient as StorageExternalAccountClient,
  GoogleAuth as StorageGoogleAuth,
  type AuthClient as StorageAuthClient,
} from "google-auth-library-v9";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedAuth: AuthClient | GoogleAuth<AuthClient> | undefined;
let cachedStorageAuth:
  | StorageAuthClient
  | StorageGoogleAuth<StorageAuthClient>
  | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Vercel GCP federation`);
  return value;
}

/**
 * Returns ambient ADC on GCP/local development, or a keyless external-account
 * client on Vercel. The subject-token supplier asks Vercel for a current OIDC
 * token whenever Google refreshes credentials, so warm functions never reuse a
 * stale token file.
 */
function externalAccountOptions() {
  const projectNumber = required("GCP_PROJECT_NUMBER");
  const poolId = required("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const providerId = required("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID");
  const serviceAccount = required("GCP_SERVICE_ACCOUNT_EMAIL");
  return {
    type: "external_account",
    audience:
      `//iam.googleapis.com/projects/${projectNumber}/locations/global/` +
      `workloadIdentityPools/${poolId}/providers/${providerId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
      `${serviceAccount}:generateAccessToken`,
    scopes: [CLOUD_PLATFORM_SCOPE],
    subject_token_supplier: {
      getSubjectToken: () => getVercelOidcToken(),
    },
  };
}

export function getGoogleAuth(): AuthClient | GoogleAuth<AuthClient> {
  if (cachedAuth) return cachedAuth;

  if (process.env.GCP_AUTH_MODE !== "wif") {
    cachedAuth = new GoogleAuth({
      projectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
    return cachedAuth;
  }

  const client = ExternalAccountClient.fromJSON(externalAccountOptions());

  if (!client) throw new Error("Unable to initialize Vercel GCP federation");
  cachedAuth = client;
  return cachedAuth;
}

/** Storage 7 still requires google-auth-library v9 at runtime. */
export function getStorageAuth():
  | StorageAuthClient
  | StorageGoogleAuth<StorageAuthClient> {
  if (cachedStorageAuth) return cachedStorageAuth;

  if (process.env.GCP_AUTH_MODE !== "wif") {
    cachedStorageAuth = new StorageGoogleAuth({
      projectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
    return cachedStorageAuth;
  }

  const client = StorageExternalAccountClient.fromJSON(externalAccountOptions());
  if (!client) throw new Error("Unable to initialize Vercel GCS federation");
  cachedStorageAuth = client;
  return cachedStorageAuth;
}

export function gcpProjectId(): string {
  return (
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "ais-project-for-gcp"
  );
}

import { getVercelOidcToken } from "@vercel/oidc";
import {
  ExternalAccountClient,
  GoogleAuth,

} from "google-auth-library";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedAuth;

function required(name) {
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

export function getGoogleAuth() {
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

/**
 * Storage-specific credentials — a raw external_account JSON blob, not a
 * pre-built client. `@google-cloud/storage` pins its own nested
 * `google-auth-library` (a different major version than this app's
 * top-level one — see package.json's `google-auth-library-v9` alias, which
 * this function used to build a client from). An `ExternalAccountClient`
 * built from that aliased package is a different class than the one
 * Storage's own bundled copy checks for internally, so its signing code
 * fails an `instanceof` check on the client we handed it, silently falls
 * back to attempting ambient ADC discovery, and dies with "Unable to find
 * credentials in current environment" — which is what actually broke GCS
 * signing (both reads and writes) in production. This was previously
 * misdiagnosed as a missing `roles/iam.serviceAccountTokenCreator`
 * self-binding, which was already correctly granted (found 2026-08-14).
 * Passing the raw JSON as `credentials` instead lets Storage build the
 * client from ITS OWN nested google-auth-library, so every internal
 * instanceof check sees a class it actually recognizes.
 */
export function getStorageCredentials() {
  if (process.env.GCP_AUTH_MODE !== "wif") return undefined;
  return externalAccountOptions();
}

export function gcpProjectId() {
  return (
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "ais-project-for-gcp"
  );
}

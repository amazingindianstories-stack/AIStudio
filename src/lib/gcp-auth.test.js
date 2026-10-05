import test from "node:test";
import assert from "node:assert/strict";
import { getStorageCredentials, serviceAccountCredentials } from "./gcp-auth.js";

test("service-account secret is optional; ambient credentials remain the default", () => {
  assert.equal(serviceAccountCredentials({}), undefined);
});
test("service-account JSON is passed intact to the storage SDK", () => {
  const credentials = { type: "service_account", client_email: "preview@example.invalid", private_key: "test-private-key", project_id: "preview" };
  const previous = { mode: process.env.GCP_AUTH_MODE, json: process.env.GCP_SERVICE_ACCOUNT_JSON };
  try {
    delete process.env.GCP_AUTH_MODE;
    process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify(credentials);
    assert.deepEqual(getStorageCredentials(), credentials);
  } finally {
    for (const [key, value] of [["GCP_AUTH_MODE", previous.mode], ["GCP_SERVICE_ACCOUNT_JSON", previous.json]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test("malformed credentials fail without echoing secret contents or silently selecting ADC", () => {
  for (const value of ['{"private_key":"sensitive-example"', '{}', '{"type":"external_account"}']) {
    assert.throws(() => serviceAccountCredentials({ GCP_SERVICE_ACCOUNT_JSON: value }), error => {
      assert.match(error.message, /GCP_SERVICE_ACCOUNT_JSON/);
      assert.ok(!error.message.includes("sensitive-example"));
      return true;
    });
  }
});

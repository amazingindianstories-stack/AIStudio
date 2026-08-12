import { GoogleAuth } from "google-auth-library";
import fetch from "node-fetch";

async function run() {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const projectId = "ais-project-for-gcp";
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict`;
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  
  const tests = [
    { name: "style config", ref: { referenceType: "REFERENCE_TYPE_STYLE", referenceImage: { bytesBase64Encoded: b64 }, styleImageConfig: { styleDescription: "style" } } },
    { name: "image", ref: { referenceType: "REFERENCE_TYPE_IMAGE", referenceImage: { bytesBase64Encoded: b64 } } },
    { name: "default subject", ref: { referenceType: "REFERENCE_TYPE_SUBJECT", referenceImage: { bytesBase64Encoded: b64 }, subjectImageConfig: { subjectType: "SUBJECT_TYPE_DEFAULT" } } },
    { name: "product subject", ref: { referenceType: "REFERENCE_TYPE_SUBJECT", referenceImage: { bytesBase64Encoded: b64 }, subjectImageConfig: { subjectType: "SUBJECT_TYPE_PRODUCT" } } },
    { name: "animal subject", ref: { referenceType: "REFERENCE_TYPE_SUBJECT", referenceImage: { bytesBase64Encoded: b64 }, subjectImageConfig: { subjectType: "SUBJECT_TYPE_ANIMAL" } } }
  ];

  for (const t of tests) {
    console.log(`Test: ${t.name}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "A beautiful landscape [1]", referenceImages: [{ referenceId: 1, ...t.ref }] }], parameters: { sampleCount: 1 } })
    });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  }
}
run().catch(console.error);

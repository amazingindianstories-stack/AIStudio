/**
 * Probe: does ModelArk accept a VIDEO as a reference in the `content` array,
 * and in what exact shape?
 *
 * ⚠ MAKES REAL, BILLED GENERATIONS (one per candidate shape that is accepted).
 * Nothing calls this automatically.
 *
 *   npx tsx scripts/probe-seedance-video-input.ts <public-video-url>
 *
 * Why a probe rather than just writing the payload: the vendor docs for this
 * endpoint are not first-party-complete, and third-party write-ups disagree.
 * Two different shapes are documented in the wild —
 *
 *   A) content[]: { "type": "video_url", "video_url": { "url": "…" } }
 *      — mirrors the image_url item this provider already accepts from us,
 *        and is what apidog documents for ModelArk itself.
 *   B) references[]: { "type": "video", "role": "motion", "url": "…" }
 *      — documented by an aggregator, and probably its own wrapper rather
 *        than ModelArk's native contract.
 *
 * providers/seedance.ts's header records that several fields on this API were
 * deduced by testing because the docs were wrong or missing, so guessing here
 * would be repeating a known mistake. This sends the smallest legal request for
 * each shape and reports which one the API accepts.
 *
 * The URL must be publicly fetchable BY BYTEPLUS. Our own /api/media/… routes
 * require a session, so they will NOT work — that is precisely the blocker
 * documented alongside this script. Use any public MP4 to establish the shape.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = (
  process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3"
).replace(/\/$/, "");
const MODEL = process.env.SEEDANCE_MODEL_FAST || "dreamina-seedance-2-0-fast-260128";

const CANDIDATES = [
  {
    label: "A  content[] video_url (mirrors our working image_url item)",
    body: (url) => ({
      model: MODEL,
      content: [
        { type: "text", text: "Continue this shot, same subject and style." },
        { type: "video_url", video_url: { url } },
      ],
      ratio: "16:9",
      resolution: "480p",
      duration: 4,
      generate_audio: false,
    }),
  },
  {
    label: "B  content[] video_url + role: reference_video",
    body: (url) => ({
      model: MODEL,
      content: [
        { type: "text", text: "Continue this shot, same subject and style." },
        { type: "video_url", video_url: { url }, role: "reference_video" },
      ],
      ratio: "16:9",
      resolution: "480p",
      duration: 4,
      generate_audio: false,
    }),
  },
  {
    label: "C  top-level video_urls[] (as some write-ups describe)",
    body: (url) => ({
      model: MODEL,
      content: [{ type: "text", text: "Continue this shot using @Video1." }],
      video_urls: [url],
      ratio: "16:9",
      resolution: "480p",
      duration: 4,
      generate_audio: false,
    }),
  },
];

async function attempt(label, body) {
  const res = await fetch(`${BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ok = res.ok;
  console.log(`\n${ok ? "✔ ACCEPTED" : "✘ rejected"}  ${label}`);
  console.log(`   HTTP ${res.status}`);
  console.log(`   ${text.slice(0, 400)}`);
  if (ok) {
    console.log(
      "   ^ this created a REAL task and will be billed. Note the id above."
    );
  }
  return ok;
}

async function main() {
  const url = process.argv[2];
  if (!process.env.ARK_API_KEY) {
    console.error("ARK_API_KEY is not set in .env.local.");
    process.exit(1);
  }
  if (!url) {
    console.error(
      "Usage: npx tsx scripts/probe-seedance-video-input.ts <public-video-url>\n" +
        "The URL must be reachable by BytePlus — our /api/media/… routes are\n" +
        "session-gated and will not work."
    );
    process.exit(1);
  }

  console.log(
    `Probing ${MODEL} at ${BASE}\nEach ACCEPTED shape is a real billed generation. Ctrl-C within 5s to abort.`
  );
  await new Promise((r) => setTimeout(r, 5000));

  const accepted = [];
  for (const c of CANDIDATES) {
    try {
      if (await attempt(c.label, c.body(url))) accepted.push(c.label);
    } catch (e) {
      console.log(`\n✘ error   ${c.label}\n   ${e?.message ?? e}`);
    }
  }

  console.log("\n────────────────────────────────────────");
  if (accepted.length) {
    console.log("Accepted shape(s):");
    for (const a of accepted) console.log("  " + a);
    console.log(
      "\nWire that shape into createVideoTask in src/lib/providers/seedance.ts,\n" +
        "and record it in that file's header comment alongside the image contract."
    );
  } else {
    console.log(
      "No candidate was accepted. Either this account/model has no video-to-video\n" +
        "entitlement, or the shape differs again — capture the error bodies above\n" +
        "before changing the provider code."
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);

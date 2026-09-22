import { generationEvent } from "./generation-coordinator";

function channels(item) {
  return [...new Set([
    item.userId ? `user:${item.userId}:generations` : null,
    item.projectId ? `project:${item.projectId}:generations` : null,
  ].filter(Boolean))];
}

/** Best-effort server-side Ably REST publisher. Database state remains the
 * source of truth; reconnects use the history/status read endpoint. */
export async function publishGenerationUpdate(item, { fetchImpl = fetch, logger = console } = {}) {
  const key = process.env.ABLY_API_KEY;
  if (!key || !item?.id) return { published: false, skipped: true };
  const [name, secret] = key.split(":");
  if (!name || !secret) throw new Error("ABLY_API_KEY must be an app key (name:secret)");
  const event = generationEvent(item);
  const results = await Promise.all(channels(item).map(async (channel) => {
    const response = await fetchImpl(`https://rest.ably.io/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${name}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: event.type, data: event }),
    });
    if (!response.ok) throw new Error(`Ably publish failed (${response.status})`);
    return channel;
  }));
  logger.info?.(JSON.stringify({ event: "generation_realtime_published", generationId: item.id, channels: results.length }));
  return { published: true, channels: results };
}


import { fetchPushStatus, removePushSubscription, savePushSubscription } from "./comments-api";

/**
 * Browser notifications for comments and mentions. The server sends an empty push and the service worker
 * (public/sw.js) asks for the newest unread notification, so no content passes through the push service.
 * The feature is off unless the server has its VAPID keys; `fetchPushStatus().enabled` says which.
 */
export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** VAPID public keys travel as unpadded base64url; the browser wants the raw bytes. */
export function keyBytes(key) {
  const padded = `${key}${"=".repeat((4 - (key.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  return registration ? registration.pushManager.getSubscription() : null;
}

/** `{ enabled, subscribed, permission }`: whether the server can push, and whether this browser is subscribed. */
export async function pushState() {
  const status = await fetchPushStatus();
  const permission = pushSupported() ? Notification.permission : "unsupported";
  const subscription = pushSupported() && permission === "granted" ? await currentSubscription() : null;
  return { enabled: status.enabled, subscribed: Boolean(subscription) && status.subscribed, permission };
}

export async function enablePush() {
  const status = await fetchPushStatus();
  if (!status.enabled || !status.publicKey) throw new Error("Browser notifications are not set up on this server.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in the browser settings.");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) }));
  await savePushSubscription(subscription.endpoint);
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await removePushSubscription(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}

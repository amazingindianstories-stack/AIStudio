/**
 * Pure helpers for live facilitation (timer, voting, private mode). The server owns every number: clients
 * count down against a clock offset learned from the poll, and read vote limits off the session they were sent.
 */

export const TIMER_PRESETS = [
  { label: "1 min", ms: 60000 },
  { label: "3 min", ms: 180000 },
  { label: "5 min", ms: 300000 },
  { label: "10 min", ms: 600000 },
  { label: "15 min", ms: 900000 },
];

export const TIMER_MUSIC = [
  { id: "calm", label: "Calm" },
  { id: "focus", label: "Focus" },
  { id: "upbeat", label: "Upbeat" },
  { id: "tick", label: "Ticking" },
];

export const MAX_VOTES_PER_PERSON = 99;

/** server time minus local time, from one poll reply (the request's midpoint stands for the server's clock). */
export function clockOffset(serverNow, sentAt, receivedAt) {
  return serverNow - Math.round((sentAt + receivedAt) / 2);
}

/** Milliseconds the timer has left at local time `now`, never below zero; null when no timer is set. */
export function remainingMs(timer, offset, now) {
  if (!timer) return null;
  if (timer.state === "paused") return Math.max(0, timer.remainingMs ?? 0);
  if (timer.state === "running" && timer.endsAt != null) return Math.max(0, timer.endsAt - (now + offset));
  return null;
}

/** "4:07", "0:09", "1:02:03". */
export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The run to ring the chime for, once: a running timer that reached zero and has not rung yet. */
export function chimeDue(timer, offset, now, rungRun) {
  if (!timer || timer.state !== "running" || timer.run === rungRun) return false;
  return remainingMs(timer, offset, now) === 0;
}

/** Whether an object can take votes in `session`, the way the server decides it. */
export function votable(session, node) {
  if (!session || !node || node.type === "connector") return false;
  if (session.objectTypes && !session.objectTypes.includes(node.type)) return false;
  const area = session.area;
  if (!area) return true;
  if (area.frameId) return node.parentId === area.frameId || node.id === area.frameId;
  const x = node.x + node.w / 2;
  const y = node.y + node.h / 2;
  return x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;
}

export function votesLeft(session) {
  return Math.max(0, (session?.votesPerPerson ?? 0) - (session?.votesUsed ?? 0));
}

/** Whether one more (or one fewer) vote on an object is allowed for this person right now. */
export function canAddVote(session, nodeId) {
  if (!session || session.done) return false;
  if (votesLeft(session) < 1) return false;
  return !(session.oneVotePerObject && (session.myVotes?.[nodeId] ?? 0) >= 1);
}

export function canRemoveVote(session, nodeId) {
  return Boolean(session && !session.done && (session.myVotes?.[nodeId] ?? 0) > 0);
}

/** Seconds left of a reveal countdown (5, 4, ... 1), or null when none runs. */
export function revealCountdown(privateMode, offset, now) {
  if (!privateMode?.active || privateMode.revealAt == null) return null;
  const left = Math.ceil((privateMode.revealAt - (now + offset)) / 1000);
  return left > 0 ? left : null;
}

/** "3 min", "90 sec", "1 h 5 min" for a duration setting. */
export function durationLabel(ms) {
  if (ms == null) return "No limit";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} sec` : `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

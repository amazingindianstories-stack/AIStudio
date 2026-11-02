"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import {
  FEATURE_MODES,
  blankAnnouncement,
  parseUserIds,
  timeFromInput,
  timeToInput,
  toggleId,
} from "@/lib/admin-workspace";

const FIELD = "w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-sm text-white";
const CARD = "space-y-3 rounded-xl border border-white/10 bg-ink-800 p-4";

async function post(payload) {
  const res = await apiFetch("/api/admin/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not save."));
  return json;
}

/** Admin console tab: workspace identity, feature activation, AI availability and announcements. */
export function AdminWorkspaceTab({ models }) {
  const [config, setConfig] = useState(null);
  const [state, setState] = useState("");
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [announcements, setAnnouncements] = useState([]);

  const adopt = useCallback((json) => {
    setConfig(json);
    setName(json.name);
    setLogoUrl(json.logoUrl);
    setAnnouncements(json.announcements);
  }, []);

  useEffect(() => {
    let live = true;
    apiFetch("/api/admin/workspace")
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not load workspace settings."));
        if (live) adopt(json);
      })
      .catch((error) => live && setState(error.message));
    return () => {
      live = false;
    };
  }, [adopt]);

  const save = async (payload, done = "Saved.") => {
    setState("Saving...");
    try {
      adopt(await post(payload));
      setState(done);
    } catch (error) {
      setState(error.message);
    }
  };

  if (!config) return <p className="text-sm text-white/55" role="status">{state || "Loading..."}</p>;

  const setFeature = (id, rule) => save({ features: { ...config.features, [id]: rule } });
  const updateAnnouncement = (index, patch) =>
    setAnnouncements((list) => list.map((a, i) => (i === index ? { ...a, ...patch } : a)));

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55" role="status" aria-live="polite">{state}</p>

      <section className={CARD} aria-label="Workspace identity">
        <h2 className="text-sm font-semibold text-white">Workspace name and logo</h2>
        <label className="block text-xs text-white/55">
          Name
          <input className={FIELD} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-xs text-white/55">
          Logo address (https link or a path on this site)
          <input className={FIELD} value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
        </label>
        <button type="button" className="rounded-lg bg-ink-650 px-3 py-2 text-sm text-white" onClick={() => save({ name, logoUrl })}>
          Save identity
        </button>
      </section>

      <section className={CARD} aria-label="Feature activation">
        <h2 className="text-sm font-semibold text-white">Feature activation</h2>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={config.betaOptIn} onChange={(e) => save({ betaOptIn: e.target.checked })} />
          Public beta opt-in (early-access features stay off until this is on)
        </label>
        {config.registry.map((feature) => {
          const rule = config.features[feature.id];
          return (
            <div key={feature.id} className="space-y-2 border-t border-white/10 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-white">
                  {feature.label}
                  {feature.beta ? <span className="ml-2 text-xs text-white/45">Beta</span> : null}
                </span>
                <select
                  aria-label={`${feature.label} availability`}
                  className="rounded-lg border border-white/10 bg-ink-900 px-2 py-1 text-sm text-white"
                  value={rule.mode}
                  onChange={(e) => setFeature(feature.id, { ...rule, mode: e.target.value })}
                >
                  {FEATURE_MODES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              {rule.mode === "users" ? (
                <input
                  aria-label={`${feature.label} chosen user ids`}
                  className={FIELD}
                  defaultValue={rule.userIds.join(", ")}
                  placeholder="User ids, separated by commas"
                  onBlur={(e) => setFeature(feature.id, { ...rule, userIds: parseUserIds(e.target.value) })}
                />
              ) : null}
            </div>
          );
        })}
      </section>

      <section className={CARD} aria-label="AI model availability">
        <h2 className="text-sm font-semibold text-white">AI model availability</h2>
        <p className="text-xs text-white/45">Blocked models are refused everywhere a model is chosen, including the agent catalog.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {models.map((model) => (
            <label key={model} className="flex items-center gap-2 text-sm text-white">
              <input
                type="checkbox"
                checked={!config.aiBlocked.models.includes(model)}
                onChange={() => save({ aiBlocked: { models: toggleId(config.aiBlocked.models, model) } })}
              />
              {model}
            </label>
          ))}
        </div>
      </section>

      <section className={CARD} aria-label="Announcements">
        <h2 className="text-sm font-semibold text-white">Announcements</h2>
        {announcements.map((a, index) => (
          <div key={a.id || index} className="space-y-2 border-t border-white/10 pt-3">
            <input aria-label="Announcement title" className={FIELD} value={a.title} maxLength={120} placeholder="Title"
              onChange={(e) => updateAnnouncement(index, { title: e.target.value })} />
            <textarea aria-label="Announcement text" className={FIELD} value={a.body} maxLength={500} placeholder="Text"
              onChange={(e) => updateAnnouncement(index, { body: e.target.value })} />
            <div className="grid gap-2 sm:grid-cols-2">
              <input aria-label="Button label" className={FIELD} value={a.ctaLabel} placeholder="Button label"
                onChange={(e) => updateAnnouncement(index, { ctaLabel: e.target.value })} />
              <input aria-label="Button link" className={FIELD} value={a.ctaUrl} placeholder="https link"
                onChange={(e) => updateAnnouncement(index, { ctaUrl: e.target.value })} />
              <label className="text-xs text-white/55">Starts
                <input type="datetime-local" className={FIELD} value={timeToInput(a.startsAt)}
                  onChange={(e) => updateAnnouncement(index, { startsAt: timeFromInput(e.target.value) })} />
              </label>
              <label className="text-xs text-white/55">Ends
                <input type="datetime-local" className={FIELD} value={timeToInput(a.endsAt)}
                  onChange={(e) => updateAnnouncement(index, { endsAt: timeFromInput(e.target.value) })} />
              </label>
              <select aria-label="Priority" className={FIELD} value={a.priority}
                onChange={(e) => updateAnnouncement(index, { priority: e.target.value })}>
                <option value="info">Info</option>
                <option value="important">Important</option>
                <option value="critical">Critical</option>
              </select>
              <select aria-label="Audience" className={FIELD} value={a.audience}
                onChange={(e) => updateAnnouncement(index, { audience: e.target.value })}>
                <option value="all">Everyone</option>
                <option value="users">Chosen people</option>
              </select>
            </div>
            {a.audience === "users" ? (
              <input aria-label="Audience user ids" className={FIELD} defaultValue={a.userIds.join(", ")}
                placeholder="User ids, separated by commas"
                onBlur={(e) => updateAnnouncement(index, { userIds: parseUserIds(e.target.value) })} />
            ) : null}
            <button type="button" className="text-sm text-red-300" onClick={() => setAnnouncements((list) => list.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className="rounded-lg bg-ink-700 px-3 py-2 text-sm text-white"
            onClick={() => setAnnouncements((list) => [...list, blankAnnouncement()])}>
            Add announcement
          </button>
          <button type="button" className="rounded-lg bg-ink-650 px-3 py-2 text-sm text-white" onClick={() => save({ announcements })}>
            Save announcements
          </button>
        </div>
      </section>
    </div>
  );
}

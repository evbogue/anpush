import webpush from "npm:web-push@3.6.7";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { apds } from "https://esm.sh/gh/evbogue/apds@d9326cb/apds.js";
import {
  ensureVapidConfig,
  type VapidConfig,
} from "./scripts/generate_vapid_keys.ts";

const LATEST_URL = Deno.env.get("LATEST_URL") ?? "https://pub.wiredove.net/latest";
const POLL_MS = Number(Deno.env.get("POLL_MS") ?? "120000");
const PORT = Number(Deno.env.get("PORT") ?? "8080");

const DATA_DIR = "./data";
const SUBS_FILE = `${DATA_DIR}/subscriptions.json`;
const STATE_FILE = `${DATA_DIR}/state.json`;
const CONFIG_FILE = "./config.json";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@wiredove.net";
const PUSH_ICON_URL = Deno.env.get("PUSH_ICON_URL") ?? "https://wiredove.net/dovepurple_sm.png";
await Deno.mkdir(DATA_DIR, { recursive: true });

type Subscription = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  lastNotifiedAt?: string;
};

type State = {
  lastSeenId?: string;
  lastSeenHash?: string;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path: string, value: unknown) {
  const raw = JSON.stringify(value, null, 2);
  await Deno.writeTextFile(path, raw);
}

async function loadOrCreateConfig(): Promise<VapidConfig> {
  return await ensureVapidConfig(CONFIG_FILE, VAPID_SUBJECT);
}

function subscriptionId(endpoint: string) {
  return btoa(endpoint).replaceAll("=", "");
}

async function loadSubscriptions(): Promise<Subscription[]> {
  return await readJsonFile<Subscription[]>(SUBS_FILE, []);
}

async function saveSubscriptions(subs: Subscription[]) {
  await writeJsonFile(SUBS_FILE, subs);
}

async function loadState(): Promise<State> {
  return await readJsonFile<State>(STATE_FILE, {});
}

async function saveState(state: State) {
  await writeJsonFile(STATE_FILE, state);
}

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function parsePostYaml(text: string): Promise<{ name?: string; body?: string }> {
  try {
    const parsed = await apds.parseYaml(text);
    if (parsed && typeof parsed === "object") {
      const attrs = parsed as Record<string, unknown>;
      const name = typeof attrs.name === "string" ? attrs.name.trim() : undefined;
      const body = typeof attrs.body === "string" ? attrs.body.trim() : undefined;
      return { name: name || undefined, body: body || undefined };
    }
  } catch {
    // Fall back to defaults if YAML parsing fails.
  }
  return {};
}

function formatPushTitle(name?: string) {
  if (name) return `New Wiredove Message from ${name}`;
  return "New anproto message";
}

function formatPushBody(body?: string) {
  if (body && body.trim()) return body.trim();
  return "Tap to view the latest update";
}

async function toPushPayload(latest: unknown) {
  const record = latest && typeof latest === "object"
    ? (latest as Record<string, unknown>)
    : null;
  const hash = record && typeof record.hash === "string" ? record.hash : "";
  const targetUrl = hash
    ? `https://wiredove.net/#${hash}`
    : "https://wiredove.net/";
  const rawText = record && typeof record.text === "string" ? record.text : "";
  const parsed = rawText ? await parsePostYaml(rawText) : {};
  const title = formatPushTitle(parsed.name);
  const body = formatPushBody(parsed.body);
  return JSON.stringify({
    title,
    body,
    url: targetUrl,
    hash,
    icon: PUSH_ICON_URL,
    latest,
  });
}

async function pollLatest(force = false): Promise<{
  changed: boolean;
  sent: boolean;
  reason?: string;
  latest?: {
    hash?: string;
    author?: string;
    ts?: string;
    textPreview?: string;
  };
}> {
  try {
    const res = await fetch(LATEST_URL, { cache: "no-store" });
    if (!res.ok) {
      console.error(`Latest fetch failed: ${res.status}`);
      return { changed: false, sent: false, reason: "latest fetch failed" };
    }
    const bodyText = await res.text();
    if (!bodyText.trim()) {
      return { changed: false, sent: false, reason: "empty response" };
    }

    let latestId = "";
    let latestJson: unknown = bodyText;
    let latestRecord: Record<string, unknown> | null = null;

    try {
      latestJson = JSON.parse(bodyText);
      if (Array.isArray(latestJson)) {
        const first = latestJson[0];
        if (first && typeof first === "object") {
          latestRecord = first as Record<string, unknown>;
        }
      } else if (latestJson && typeof latestJson === "object") {
        latestRecord = latestJson as Record<string, unknown>;
      }

      if (latestRecord) {
        const candidate =
          latestRecord.hash ?? latestRecord.id ?? latestRecord.timestamp ??
            latestRecord.ts;
        if (typeof candidate === "string" || typeof candidate === "number") {
          latestId = String(candidate);
        }
      }
    } catch {
      // Non-JSON is allowed; fallback to hashing.
    }

    const state = await loadState();
    const latestHash = latestId ? "" : await hashText(bodyText);
    const latestSummary = latestRecord ? summarizeLatest(latestRecord) : undefined;

    const isNew = latestId
      ? latestId !== state.lastSeenId
      : latestHash !== state.lastSeenHash;

    if (!isNew && !force) {
      return {
        changed: false,
        sent: false,
        reason: "no new messages",
        latest: latestSummary,
      };
    }

    if (isNew) {
      await saveState({
        lastSeenId: latestId || undefined,
        lastSeenHash: latestHash || undefined,
      });
    }

    const subs = await loadSubscriptions();
    if (subs.length === 0) {
      return {
        changed: true,
        sent: false,
        reason: "no subscriptions",
        latest: latestSummary,
      };
    }

    const payload = await toPushPayload(latestRecord ?? latestJson);
    const now = new Date().toISOString();
    const nextSubs: Subscription[] = [];

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          payload,
        );
        nextSubs.push({ ...sub, lastNotifiedAt: now });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          console.warn(`Removing expired subscription: ${sub.id}`);
          continue;
        }
        console.error(`Push failed for ${sub.id}`, err);
        nextSubs.push(sub);
      }
    }

    await saveSubscriptions(nextSubs);
    return { changed: true, sent: true, latest: latestSummary };
  } catch (err) {
    console.error("Poll error", err);
    return { changed: false, sent: false, reason: "poll error" };
  }
}

function summarizeLatest(record: Record<string, unknown>) {
  const text = typeof record.text === "string" ? record.text : "";
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return {
    hash: typeof record.hash === "string" ? record.hash : undefined,
    author: typeof record.author === "string" ? record.author : undefined,
    ts: typeof record.ts === "string" ? record.ts : undefined,
    textPreview: preview || undefined,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function okResponse(text = "ok") {
  return new Response(text, { status: 200, headers: corsHeaders });
}

const config = await loadOrCreateConfig();
webpush.setVapidDetails(
  config.vapidSubject,
  config.vapidPublicKey,
  config.vapidPrivateKey,
);

const server = serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === "GET" && url.pathname === "/vapid-public-key") {
    return jsonResponse({ key: config.vapidPublicKey });
  }

  if (req.method === "POST" && url.pathname === "/subscribe") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid subscription" }, 400);
    }

    const sub = body as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return jsonResponse({ error: "missing fields" }, 400);
    }

    const subs = await loadSubscriptions();
    const id = subscriptionId(sub.endpoint);

    const existing = subs.find((item) => item.id === id);
    if (!existing) {
      subs.push({
        id,
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        createdAt: new Date().toISOString(),
      });
      await saveSubscriptions(subs);
    }

    return okResponse();
  }

  if (req.method === "POST" && url.pathname === "/unsubscribe") {
    const body = await req.json().catch(() => null);
    const endpoint = body?.endpoint;
    if (!endpoint) return jsonResponse({ error: "missing endpoint" }, 400);

    const subs = await loadSubscriptions();
    const id = subscriptionId(endpoint);
    const nextSubs = subs.filter((item) => item.id !== id);
    if (nextSubs.length !== subs.length) await saveSubscriptions(nextSubs);

    return okResponse();
  }

  if (req.method === "POST" && url.pathname === "/poll-now") {
    const result = await pollLatest();
    return jsonResponse(result);
  }

  if (req.method === "POST" && url.pathname === "/push-latest") {
    const result = await pollLatest(true);
    return jsonResponse(result);
  }

  return await serveDir(req, { fsRoot: "public" });
}, { port: PORT });

console.log(`Server running on http://localhost:${PORT}`);
console.log(`Polling ${LATEST_URL} every ${POLL_MS}ms`);

await pollLatest();
setInterval(() => {
  pollLatest();
}, POLL_MS);

await server;

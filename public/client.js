const statusEl = document.getElementById("status");
const latestEl = document.getElementById("latest");
const subscribeBtn = document.getElementById("subscribe");
const unsubscribeBtn = document.getElementById("unsubscribe");
const pollBtn = document.getElementById("poll");
const pushLatestBtn = document.getElementById("push-latest");

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function setLatest(data) {
  if (!data) {
    latestEl.textContent = "Latest: none";
    return;
  }
  const text = data.textPreview ? `\n\n${data.textPreview}` : "";
  latestEl.textContent = [
    `Latest: ${data.hash || "unknown"}`,
    `author: ${data.author || "unknown"}`,
    `ts: ${data.ts || "unknown"}`,
  ].join("\n") + text;
}

function updateButtons(enabled) {
  if (enabled) {
    subscribeBtn.textContent = "Notifications enabled";
    subscribeBtn.disabled = true;
    unsubscribeBtn.textContent = "Disable notifications";
    unsubscribeBtn.disabled = false;
  } else {
    subscribeBtn.textContent = "Enable notifications";
    subscribeBtn.disabled = false;
    unsubscribeBtn.textContent = "Notifications disabled";
    unsubscribeBtn.disabled = true;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

async function getPublicKey() {
  const res = await fetch("/vapid-public-key");
  if (!res.ok) throw new Error("Failed to load VAPID public key");
  const data = await res.json();
  return data.key;
}

async function pollNow() {
  const res = await fetch("/poll-now", { method: "POST" });
  if (!res.ok) throw new Error("Poll failed");
  const data = await res.json();
  setLatest(data.latest);
  if (data.sent) {
    setStatus("poll sent notification");
  } else {
    setStatus(data.reason || "no new messages");
  }
}

async function pushLatest() {
  const res = await fetch("/push-latest", { method: "POST" });
  if (!res.ok) throw new Error("Push latest failed");
  const data = await res.json();
  setLatest(data.latest);
  if (data.sent) {
    setStatus("sent latest notification");
  } else {
    setStatus(data.reason || "push failed");
  }
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker not supported in this browser");
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  return registration;
}

async function subscribe() {
  setStatus("requesting permission");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("permission denied");
    return;
  }

  const registration = await ensureServiceWorker();
  const key = await getPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  const res = await fetch("/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });

  if (!res.ok) throw new Error("Subscribe failed");
  setStatus("subscribed");
  updateButtons(true);
}

async function unsubscribe() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    setStatus("no service worker");
    return;
  }

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    setStatus("not subscribed");
    return;
  }

  await subscription.unsubscribe();
  await fetch("/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });

  setStatus("unsubscribed");
  updateButtons(false);
}

subscribeBtn.addEventListener("click", () => {
  subscribe().catch((err) => {
    console.error(err);
    setStatus("subscribe failed");
  });
});

unsubscribeBtn.addEventListener("click", () => {
  unsubscribe().catch((err) => {
    console.error(err);
    setStatus("unsubscribe failed");
  });
});

pollBtn.addEventListener("click", () => {
  pollNow().catch((err) => {
    console.error(err);
    setStatus("poll failed");
  });
});

pushLatestBtn.addEventListener("click", () => {
  pushLatest().catch((err) => {
    console.error(err);
    setStatus("push latest failed");
  });
});

async function refreshSubscriptionState() {
  if (!("serviceWorker" in navigator)) {
    setStatus("service worker not supported");
    updateButtons(false);
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration
    ? await registration.pushManager.getSubscription()
    : null;

  if (subscription) {
    setStatus("subscribed");
    updateButtons(true);
  } else {
    setStatus("not subscribed");
    updateButtons(false);
  }
}

refreshSubscriptionState().catch((err) => {
  console.error(err);
  setStatus("idle");
  updateButtons(false);
});

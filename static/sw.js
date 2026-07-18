/* Калаграм — push + minimal cache (never pin HTML/JS — iOS PWA was stuck on old shell) */
const CACHE = "kalagram-v24";
const PRECACHE = ["/manifest.webmanifest", "/static/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url, request) {
  const p = url.pathname;
  if (request.mode === "navigate") return true;
  if (p === "/" || p === "/index.html") return true;
  if (p === "/sw.js") return true;
  if (p.endsWith("/app.js") || p.endsWith("/style.css")) return true;
  if (p.endsWith(".html")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  if (event.request.method !== "GET") return;

  // Always network for app shell — iPhone home-screen apps were serving stale UI
  if (isShellRequest(url, event.request)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).catch(() =>
        caches.match(event.request)
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Калаграм",
    body: "Новое сообщение",
    icon: "/static/icons/icon-192.png",
    badge: "/static/icons/icon-192.png",
    data: {},
  };
  try {
    if (event.data) {
      const j = event.data.json();
      payload = { ...payload, ...j };
    }
  } catch (e) {
    try {
      payload.body = event.data ? event.data.text() : payload.body;
    } catch (_) {}
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Калаграм", {
      body: payload.body || "",
      icon: payload.icon || "/static/icons/icon-192.png",
      badge: payload.badge || "/static/icons/icon-192.png",
      data: payload.data || {},
      tag: "kalagram-msg",
      renotify: true,
      vibrate: [120, 60, 120],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = "/";

  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          c.postMessage({ type: "open-chat", ...data });
          return;
        }
      }
      if (clients.openWindow) {
        await clients.openWindow(targetUrl);
      }
    })()
  );
});

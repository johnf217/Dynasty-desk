// Dynasty Desk service worker (v37).
// Opens the app from this phone's saved copy when the network is slow or gone, and keeps the fonts and artwork
// that ship with the app. Your MFL data (/api/...) always goes straight to the network and is never stored here.
//
// The page itself is network-first: with a decent connection you always get the newest upload. If the network
// hasn't answered within PAGE_WAIT, the saved copy opens instead, and the app shows "New version ready" if a
// newer page arrives afterwards.
//
// To switch this off, replace everything in this file with these two lines and upload it:
//   self.addEventListener("install", () => self.skipWaiting());
//   self.addEventListener("activate", () => self.registration.unregister());

const SHELL = "dd-shell-v1";   // the page (one copy, always the newest that loaded)
const STATIC = "dd-static-v1"; // icons, header art, fonts
const PAGE_WAIT = 2500;        // ms to wait for the network before opening the saved copy

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.add(new Request("/", { cache: "reload" }))).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("dd-") && k !== SHELL && k !== STATIC) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/.netlify/") || u.pathname === "/sw.js") return;
    if (r.mode === "navigate") { e.respondWith(page(e)); return; }
    if (/\.(webp|png|jpe?g|svg|ico|webmanifest|woff2?)$/i.test(u.pathname)) { e.respondWith(keepFresh(e)); return; }
    return;
  }
  if (u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com") { e.respondWith(keepFresh(e)); return; }
  // Everything else (player photos, team logos, MFL) is left to the browser as usual.
});

// The page: ask the network first; fall back to the saved copy if it's slow, offline, or the server errors.
async function page(e) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match("/");
  const net = fetch(e.request).then(async (res) => {
    if (res.ok && res.type === "basic" && (res.headers.get("content-type") || "").includes("text/html")) await cache.put("/", res.clone());
    return res;
  });
  if (!saved) return net;
  e.waitUntil(net.then(() => {}, () => {}));
  let late = false;
  const res = await Promise.race([
    net.then((x) => (x.ok ? x : saved), () => saved),
    new Promise((ok) => setTimeout(() => { late = true; ok(null); }, PAGE_WAIT)),
  ]);
  if (res) return res;
  // The network was slow: open the saved copy now, and tell the app if a different page turns up.
  e.waitUntil(net.then(async (x) => {
    if (!late || !x.ok) return;
    const a = saved.headers.get("etag") || saved.headers.get("last-modified") || "";
    const b = x.headers.get("etag") || x.headers.get("last-modified") || "";
    if (a && b && a === b) return;
    for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "dd-update" });
  }, () => {}));
  return saved;
}

// Artwork, icons and fonts: show the saved copy straight away and refresh it in the background for next time.
async function keepFresh(e) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(e.request);
  const net = fetch(e.request).then(async (res) => {
    if (res.ok) await cache.put(e.request, res.clone());
    return res;
  });
  if (hit) { e.waitUntil(net.then(() => {}, () => {})); return hit; }
  return net;
}

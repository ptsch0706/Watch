// Wavelength Service Worker
// Place this file in the same directory as podcast-app.html on GitHub Pages
// It will be served at: https://yourusername.github.io/yourrepo/sw.js

const CACHE_NAME = 'wavelength-v1';
const PROXY_BASE = 'https://api.allorigins.win/get?url=';
const PROXY_FALLBACKS = [
  u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

// ── INSTALL: cache the app shell ─────────────────────────────────────────────
self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([
        './',
        './podcast-app.html',
      ])
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: serve app shell from cache, pass audio through ────────────────────
self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);

  // Let audio, proxy requests, and external resources go through normally
  if (
    ev.request.url.includes('allorigins') ||
    ev.request.url.includes('corsproxy') ||
    ev.request.url.includes('fonts.googleapis') ||
    ev.request.url.includes('gstatic') ||
    ev.request.url.includes('firebasejs')
  ) return;

  // Cache-first for the app shell
  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return cached;
      return fetch(ev.request).then(res => {
        // Cache successful HTML/JS/CSS responses
        if (res.ok && ['/', '/podcast-app.html', '/sw.js'].some(p => url.pathname.endsWith(p))) {
          caches.open(CACHE_NAME).then(c => c.put(ev.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('./podcast-app.html'));
    })
  );
});

// ── PERIODIC BACKGROUND SYNC ─────────────────────────────────────────────────
// Fires automatically in the background on Chrome/Android when registered
// with periodicSync.register('check-new-episodes', { minInterval: 3600000 })
self.addEventListener('periodicsync', ev => {
  if (ev.tag === 'check-new-episodes') {
    ev.waitUntil(backgroundCheckFeeds());
  }
});

async function backgroundCheckFeeds() {
  // Load saved podcast data from the app's localStorage via a client message,
  // or fall back to reading from IndexedDB if we stored a copy there
  const pods = await getSavedPods();
  if (!pods || !Object.keys(pods).length) return;

  const newEps = await getSavedNewEps();
  let totalFound = 0;

  for (const [feedUrl, pod] of Object.entries(pods)) {
    try {
      const fresh = await fetchFeedRaw(feedUrl);
      if (!fresh) continue;
      const knownUrls = new Set(pod.eps.map(e => e.audioUrl));
      const novel = fresh.eps.filter(e => !knownUrls.has(e.audioUrl));
      if (novel.length) {
        newEps[feedUrl] = [...(newEps[feedUrl] || []), ...novel]
          .filter((ep, i, arr) => arr.findIndex(x => x.audioUrl === ep.audioUrl) === i);
        pods[feedUrl] = fresh;
        totalFound += novel.length;
      }
    } catch(e) { /* skip failed feeds silently */ }
  }

  if (totalFound > 0) {
    // Save updated data back
    await savePods(pods);
    await saveNewEps(newEps);

    // Send message to any open clients (app windows)
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'NEW_EPISODES', newEps }));

    // Show a push notification if the app isn't open
    if (!clients.length || clients.every(c => c.visibilityState === 'hidden')) {
      await showNewEpisodeNotification(totalFound, newEps, pods);
    }
  }

  // Always update last check time
  await setLastCheck(Date.now());
}

async function showNewEpisodeNotification(count, newEps, pods) {
  if (!self.registration.showNotification) return;
  const perm = await self.registration.pushManager?.permissionState?.({ userVisibleOnly: true });
  // Build a preview of what's new
  const firstFeed = Object.keys(newEps)[0];
  const firstEp = newEps[firstFeed]?.[0];
  const podTitle = pods[firstFeed]?.title || 'Your podcast';
  const body = count === 1
    ? `${firstEp?.title || 'New episode'} — ${podTitle}`
    : `${count} new episodes across your library`;

  await self.registration.showNotification('Wavelength', {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'new-episodes',
    renotify: true,
    data: { url: './' }
  });
}

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  ev.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes('podcast-app'));
      if (existing) return existing.focus();
      return self.clients.openWindow('./podcast-app.html');
    })
  );
});

// ── STORAGE HELPERS (IndexedDB mirror) ───────────────────────────────────────
// The SW can't access localStorage directly, so we mirror critical data to IDB

function openSwDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('wl-sw', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = rej;
  });
}

async function swGet(key) {
  const db = await openSwDB();
  return new Promise(res => {
    const req = db.transaction('kv','readonly').objectStore('kv').get(key);
    req.onsuccess = e => res(e.target.result?.v ?? null);
    req.onerror = () => res(null);
  });
}

async function swSet(key, value) {
  const db = await openSwDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv','readwrite');
    tx.objectStore('kv').put({ k: key, v: value });
    tx.oncomplete = res; tx.onerror = rej;
  });
}

async function getSavedPods()   { return await swGet('pods') || {}; }
async function getSavedNewEps() { return await swGet('new_eps') || {}; }
async function savePods(p)      { return swSet('pods', p); }
async function saveNewEps(n)    { return swSet('new_eps', n); }
async function setLastCheck(t)  { return swSet('last_check', t); }

// ── FEED FETCHING (SW context) ────────────────────────────────────────────────
async function fetchFeedRaw(feedUrl) {
  for (const buildUrl of PROXY_FALLBACKS) {
    try {
      const r = await fetch(buildUrl(feedUrl), { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      let text;
      if (buildUrl === PROXY_FALLBACKS[0]) {
        const j = await r.json(); text = j.contents;
      } else {
        text = await r.text();
      }
      if (!text || text.length < 100) continue;
      if (!text.includes('<rss') && !text.includes('<feed') && !text.includes('<channel')) continue;
      return parseFeedXml(text);
    } catch(e) { continue; }
  }
  return null;
}

function parseFeedXml(raw) {
  const doc = new self.DOMParser().parseFromString(raw, 'application/xml');
  const ch = doc.querySelector('channel') || doc.querySelector('feed');
  if (!ch) return null;

  const g = (p, s) => p.querySelector(s)?.textContent?.trim() || '';

  function extractImage(node) {
    const el = Array.from(node.getElementsByTagName('*')).find(el =>
      el.tagName.toLowerCase().includes('image') && el.getAttribute('href')
    );
    if (el) return el.getAttribute('href');
    const rssUrl = node.querySelector('image > url')?.textContent?.trim();
    if (rssUrl) return rssUrl;
    const m = raw.match(/<itunes:image[^>]+href=["']([^"']+)["']/);
    return m ? m[1] : '';
  }

  const img = extractImage(ch);
  const eps = Array.from(doc.querySelectorAll('item')).map(it => {
    const enc = it.querySelector('enclosure');
    return {
      title: g(it, 'title'),
      description: g(it, 'description').replace(/<[^>]*>/g, '').trim().slice(0, 200),
      pubDate: g(it, 'pubDate'),
      duration: g(it, 'duration') || '',
      audioUrl: enc?.getAttribute('url') || '',
      image: extractImage(it) || img,
    };
  }).filter(e => e.audioUrl);

  return { title: g(ch, 'title'), image: img, eps };
}

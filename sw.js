/* 帧隐视频 · 网页版离线缓存（在线时永远以网络上的最新版本为准） */
const CACHE = 'framehidden-web-v8';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/engine.js',
  './js/app.js',
  './vendor/mp4-muxer.js',
  './vendor/gifenc.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter((k) => k !== CACHE);
    // 只有极早期版本（曾包含会卡死系统的预览全屏代码）才强制刷新一次；
    // 之后的版本升级都交给「网络优先」在下次打开时自然替换，避免打断正在导出的人。
    const hadDangerous = old.some((k) => /^framehidden-web-v[1-4]$/.test(k));
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (hadDangerous) {
      const wins = await self.clients.matchAll({ type: 'window' });
      for (const c of wins) {
        c.navigate(c.url).catch(() => {});
      }
    }
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // 网络优先：在线时永远拿最新文件；断网才回退到缓存
  e.respondWith((async () => {
    try {
      const resp = await fetch(e.request, { cache: 'no-store' });
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    } catch (err) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

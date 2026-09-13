/* 健身打卡 · Service Worker
   作用有两个：
   1. 离线缓存：断网或者信号差的时候，App 依然能打开和使用。
   2. 通知接收：预留 web push 的接收能力（当前不需要服务器，暂时用不上）。
*/

const CACHE = 'fitcheck-v1';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => { /* 有个别资源没缓存上也不影响使用 */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 网络优先：
   联网时永远拿最新的代码（改了代码刷新就能看到），
   断网时回退到缓存副本。 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/* 预留：以后如果加了服务器推送，这里负责显示 */
self.addEventListener('push', (event) => {
  let data = { title: '训练时间结束', body: '训练时间结束，完成今天的训练吧！' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) { /* 用默认文案 */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      tag: 'fitcheck-training',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow('./');
    })
  );
});

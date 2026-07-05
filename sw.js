// DeepTranslate Service Worker
// 缓存静态资源，API 请求走网络（因为是实时翻译）

const CACHE_NAME = 'deeptranslate-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/highlight.js',
  '/js/marked.min.js',
  '/js/render.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// 安装：预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 拦截请求：API 走网络，静态资源走缓存优先
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 请求：Network Only（翻译必须联网）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 静态资源：Cache First，回退到网络
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

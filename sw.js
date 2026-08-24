// ============================================================
//  QW电竞 - Service Worker（强制更新版）
// ============================================================

const CACHE_NAME = 'qw-esports-v3';  // 每次更新修改版本号

// 需要缓存的静态资源（只缓存核心文件）
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// 安装时缓存核心文件
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('缓存资源已加载');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())  // 立即激活
  );
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => self.clients.claim())  // 立即控制所有页面
  );
});

// 拦截请求
self.addEventListener('fetch', event => {
  // API 请求直接走网络，不缓存
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then(response => {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                try {
                  cache.put(event.request, responseToCache);
                } catch (e) {}
              });
            return response;
          })
          .catch(() => {
            return caches.match('/');
          });
      })
  );
});
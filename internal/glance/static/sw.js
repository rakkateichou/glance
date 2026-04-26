const CACHE_NAME = 'glance-cache-v1';
const ASSETS = [
    './',
    './assets/css/bundle.css',
    './assets/js/page.js',
    './assets/js/templating.js',
    './assets/js/utils.js',
    './assets/js/sync.js',
    './assets/js/todo.js',
    './assets/js/counters.js',
    './manifest.json'
];

// Install: Cache essential assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch: Stale-while-revalidate strategy
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Don't intercept WebSocket or specific API calls that MUST be live
    if (url.pathname.includes('/api/sync') || url.pathname.includes('/api/autocomplete')) {
        return;
    }

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            const fetchPromise = fetch(request).then((networkResponse) => {
                // Update cache with new version if it's a successful GET request for our assets
                if (request.method === 'GET' && networkResponse.ok) {
                    const cacheCopy = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, cacheCopy);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Silently fail if network is down, we already have the cache
            });

            // Return cached version immediately if we have it, otherwise wait for network
            return cachedResponse || fetchPromise;
        })
    );
});

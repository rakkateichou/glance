// Replaced by the server, so every update gets a fresh cache and old ones are dropped
const CACHE_NAME = 'glance-__STATIC_ASSETS_HASH__';
const STATIC_PREFIX = new URL('static/__STATIC_ASSETS_HASH__/', self.registration.scope).pathname;
const API_PREFIX = new URL('api/', self.registration.scope).pathname;
const USER_ASSETS_PREFIX = new URL('assets/', self.registration.scope).pathname;

// How long to wait for the server before showing the cached page instead
const NAVIGATION_TIMEOUT_MS = 1000;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Start fetching the page in parallel with the worker booting up
        if (self.registration.navigationPreload) {
            await self.registration.navigationPreload.enable();
        }

        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(API_PREFIX)) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(event));
    } else if (url.pathname.startsWith(STATIC_PREFIX)) {
        event.respondWith(handleStaticAsset(request));
    } else if (url.pathname.startsWith(USER_ASSETS_PREFIX)) {
        event.respondWith(handleUserAsset(event));
    }
});

// Pages: network first so widgets are fresh, falling back to the last cached copy
// when the server is slow, down or unreachable
async function handleNavigation(event) {
    const cache = await caches.open(CACHE_NAME);

    const network = (async () => {
        const response = (await event.preloadResponse) || await fetch(event.request);
        if (response.ok && response.type === 'basic') {
            await cache.put(event.request.url, response.clone());
        }
        return response;
    })();
    event.waitUntil(network.catch(() => {}));

    const cached = await cache.match(event.request.url);
    if (!cached) {
        return network;
    }

    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAVIGATION_TIMEOUT_MS));
    const fresh = network
        .then((response) => response.status >= 500 ? cached : response)
        .catch(() => cached);

    return Promise.race([fresh, timeout]);
}

// Static assets have the content hash in their URL, so a cached copy is always current
async function handleStaticAsset(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }

    const response = await fetch(request);
    if (response.ok) {
        cache.put(request, response.clone());
    }
    return response;
}

// User assets (custom CSS, scripts in the document head) can block rendering, so serve the
// cached copy right away and refresh it in the background; edits show up on the next load
async function handleUserAsset(event) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);

    const network = fetch(event.request, { cache: 'no-cache' }).then((response) => {
        if (response.ok) {
            return cache.put(event.request, response.clone()).then(() => response);
        }
        return response;
    });

    if (!cached) {
        return network;
    }

    event.waitUntil(network.catch(() => {}));
    return cached;
}

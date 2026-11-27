'use strict';

// This independent offline view never needs live pages or API responses in Cache Storage.
const cacheName = 'linkscope-offline-v1';
const offlineFiles = ['/offline.html', '/theme.js', '/pwa.js', '/mark.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(offlineFiles.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('linkscope-offline-') && name !== cacheName).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const home = request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname);
  if (!home && (url.search || !offlineFiles.includes(url.pathname))) return;
  event.respondWith((async () => {
    const fallback = () => caches.match(home ? '/offline.html' : url.pathname, { cacheName });
    try {
      const response = await fetch(request);
      if (home && response.status >= 500) return (await fallback()) || response;
      return response;
    } catch {
      return (await fallback()) || Response.error();
    }
  })());
});

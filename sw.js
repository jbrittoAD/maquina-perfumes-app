// Service worker: guarda o app inteiro no aparelho (um cache por versão) e responde sempre do cache, para abrir sem internet.
// As duas linhas abaixo são reescritas por exportar_pwa.py: a versão é o hash dos arquivos, e é ela que faz o navegador atualizar.
const VERSAO = '6c34fa3e7b05';
const ARQUIVOS = ["./", "index.html", "app.js", "motor.js", "dados.json", "catalogo.html", "escadas.html", "manifest.webmanifest", "icone-192.png", "icone-512.png", "icone-maskable-512.png"];
const CACHE = 'perfume-' + VERSAO;

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE)
    .then(c => Promise.all(ARQUIVOS.map(u => c.add(new Request(u, { cache: 'reload' })))))   // 'reload': nunca guardar cópia velha do cache HTTP
    .then(() => self.skipWaiting())));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('perfume-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true })).then(r => r || fetch(e.request)));
});

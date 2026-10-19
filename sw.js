/*
 * Rešeno Evidenca – service worker.
 * - Aplikacija deluje tudi brez interneta (vse datoteke so shranjene na napravi).
 * - Prikaže jutranji opomnik in opomnik za odhod. Obvestila pošilja skripta v preglednici vodje
 *   brez vsebine; besedilo sestavi ta datoteka glede na vnose na telefonu (kot v aplikaciji za Android).
 *
 * Ob vsaki spremembi datotek aplikacije povečaj VERSION, da telefoni prenesejo novo različico.
 */
importScripts('core.js', 'db.js');

const VERSION = '1.0.0';
const CACHE = 'evidenca-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'core.js',
  'db.js',
  'pdf.js',
  'lib/preact.js',
  'manifest.webmanifest',
  'slike/logo-header.png',
  'slike/logo-full.png',
  'slike/logo-pdf.jpg',
  'pisave/Roboto-Regular.ttf',
  'pisave/Roboto-Bold.ttf',
  'ikone/apple-touch-icon.png',
  'ikone/ikona-192.png',
  'ikone/ikona-512.png',
  'ikone/znacka-96.png',
  'ikone/favicon-32.png',
];

const Core = self.EvidencaCore;
const Db = self.EvidencaDb;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf('evidenca-') === 0 && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Aplikacija je ena stran: vedno vrni shranjeno index.html (tudi brez interneta).
    event.respondWith(
      caches.match(new URL('index.html', self.registration.scope).href)
        .then((cached) => cached || fetch(req)),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req)));
});

// ---------------------------------------------------------------------------
// Obvestila
// ---------------------------------------------------------------------------

const DEFAULTS = { departureEnabled: true, departureMinutes: 16 * 60, dailyMinutes: 8 * 60, paidBreakMinutes: 30 };

async function showReminder() {
  const now = new Date();
  const day = Core.Day.fromDate(now);
  const minute = Core.nowMinutes(now);
  let state = { settings: null, record: null, testPush: 0 };
  try {
    state = await Db.reminderState(day);
  } catch (e) {
    // Brez dostopa do podatkov pokaži splošen opomnik.
  }
  const settings = Object.assign({}, DEFAULTS, state.settings || {});
  const record = state.record ? Core.record(day, state.record) : null;
  const test = !!state.testPush && Date.now() - state.testPush < 5 * 60 * 1000;
  if (test) {
    try {
      await Db.put('kv', 0, 'testPush');
    } catch (e) {
      // ni pomembno
    }
  }
  const text = Core.ReminderText.make(record, settings, minute, test);
  const actions = [];
  if (text.tag === 'jutro' && !(record && (record.arrival != null || Core.Rec.isAbsence(record)))) {
    actions.push({ action: 'arrival', title: 'Zabeleži prihod' });
  } else if (text.tag === 'odhod' && record && record.arrival != null && record.departure == null) {
    actions.push({ action: 'departure', title: 'Zabeleži odhod' });
  }
  const options = {
    body: text.body,
    tag: text.tag,
    renotify: true,
    icon: 'ikone/ikona-192.png',
    badge: 'ikone/znacka-96.png',
    lang: 'sl',
    timestamp: Date.now(),
    data: { day },
  };
  if (actions.length && typeof Notification !== 'undefined' && 'actions' in Notification.prototype) options.actions = actions;
  await self.registration.showNotification(text.title, options);
}

self.addEventListener('push', (event) => {
  // Safari zahteva, da vsako potisno sporočilo prikaže obvestilo.
  event.waitUntil(showReminder().catch(() => self.registration.showNotification('Rešeno Evidenca', {
    body: 'Ne pozabi zabeležiti delovnega časa.',
    tag: 'jutro',
    icon: 'ikone/ikona-192.png',
  })));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action === 'arrival' || event.action === 'departure' ? event.action : '';
  const scope = self.registration.scope;
  const target = action ? scope + '?akcija=' + action : scope;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if (client.url.indexOf(scope) === 0 && 'focus' in client) {
        await client.focus();
        if (action) client.postMessage({ akcija: action });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Brskalnik je zamenjal naročnino (npr. potek veljavnosti): prijavi novo na strežnik.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const [state, settings] = await Promise.all([Db.get('kv', 'state'), Db.get('kv', 'settings')]);
    if (!state || !state.syncLink || !state.vapidKey) return;
    let sub = event.newSubscription;
    if (!sub) {
      const raw = atob(state.vapidKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (state.vapidKey.length % 4)) % 4));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const s = Object.assign({ morningEnabled: true, morningMinutes: 420, workdays: [1, 2, 3, 4, 5], skipHolidays: true }, DEFAULTS, settings || {});
    const name = String(s.employeeName || '').trim();
    const body = {
      action: 'subscribe',
      employee: {
        id: state.employeeId,
        name: name || 'Zaposleni ' + String(state.employeeId).slice(0, 4),
        app: 'splet',
        device: 'splet',
        dailyMinutes: s.dailyMinutes,
        paidBreakMinutes: s.paidBreakMinutes,
      },
      device: 'splet (obnovljena prijava)',
      origin: self.location.origin,
      subscription: sub.toJSON(),
      reminders: {
        morningEnabled: s.morningEnabled, morning: s.morningMinutes, days: s.workdays, skipHolidays: s.skipHolidays,
        departureEnabled: s.departureEnabled, departure: s.departureMinutes,
      },
    };
    await fetch(state.syncLink, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, credentials: 'omit' });
    state.pushEndpoint = sub.endpoint;
    state.pushKey = state.vapidKey;
    await Db.put('kv', state, 'state');
  })().catch(() => {}));
});

/*
 * Rešeno Evidenca – shramba v brskalniku (IndexedDB).
 * Uporabljata jo stran (app.js) in service worker (sw.js, za besedilo obvestil).
 *
 * Shrambe:
 *   days    – en zapis na dan: { date, record, rev, syncedRev, updatedAt }
 *   deleted – izbrisani dnevi, ki jih je treba izbrisati tudi v preglednici: { date, at }
 *   kv      – nastavitve ('settings'), stanje ('state') in zastavica preizkusnega obvestila ('testPush')
 */
(function (root) {
  'use strict';

  const NAME = 'evidenca';
  const VERSION = 1;
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open(NAME, VERSION);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
          if (!db.objectStoreNames.contains('deleted')) db.createObjectStore('deleted', { keyPath: 'date' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          db.onclose = () => {
            opening = null;
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB ni na voljo.'));
        req.onblocked = () => reject(new Error('Baza je zaklenjena (odprta v drugem oknu).'));
      });
      opening.catch(() => {
        opening = null;
      });
    }
    return opening;
  }

  function done(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error || new Error('Napaka pri zapisu.'));
      t.onabort = () => reject(t.error || new Error('Zapis je bil prekinjen.'));
    });
  }

  function result(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** Izvede operacijo; če je povezava z bazo medtem zaprta (iOS v ozadju), jo enkrat ponovi. */
  async function withDb(fn) {
    try {
      return await fn(await open());
    } catch (e) {
      if (e && (e.name === 'InvalidStateError' || e.name === 'TransactionInactiveError' || e.name === 'UnknownError')) {
        opening = null;
        return fn(await open());
      }
      throw e;
    }
  }

  const EvidencaDb = {
    open,

    get(store, key) {
      return withDb((db) => result(db.transaction(store).objectStore(store).get(key)));
    },

    getAll(store) {
      return withDb((db) => result(db.transaction(store).objectStore(store).getAll()));
    },

    put(store, value, key) {
      return withDb((db) => {
        const t = db.transaction(store, 'readwrite');
        if (key === undefined) t.objectStore(store).put(value);
        else t.objectStore(store).put(value, key);
        return done(t);
      });
    },

    del(store, key) {
      return withDb((db) => {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).delete(key);
        return done(t);
      });
    },

    /** Več sprememb v eni transakciji: [{ store, op: 'put' | 'delete' | 'clear', value, key }] */
    batch(ops) {
      if (!ops.length) return Promise.resolve();
      const stores = Array.from(new Set(ops.map((o) => o.store)));
      return withDb((db) => {
        const t = db.transaction(stores, 'readwrite');
        for (const o of ops) {
          const s = t.objectStore(o.store);
          if (o.op === 'delete') s.delete(o.key);
          else if (o.op === 'clear') s.clear();
          else if (o.key === undefined) s.put(o.value);
          else s.put(o.value, o.key);
        }
        return done(t);
      });
    },

    /** Podatki, ki jih service worker potrebuje za besedilo obvestila. */
    async reminderState(dayIso) {
      const [settings, entry, test] = await Promise.all([
        EvidencaDb.get('kv', 'settings'),
        EvidencaDb.get('days', dayIso),
        EvidencaDb.get('kv', 'testPush'),
      ]);
      return { settings: settings || null, record: entry ? entry.record : null, testPush: test || 0 };
    },
  };

  root.EvidencaDb = EvidencaDb;
})(typeof self !== 'undefined' ? self : this);

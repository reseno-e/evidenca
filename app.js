/*
 * Rešeno Evidenca – spletna različica (iPhone, Android in računalnik).
 * Enake funkcije kot aplikaciji za Android in iPhone: beleženje prihoda, malice in odhoda, opis dneva
 * (lokacija), opombe in lastno vozilo, mesečni pregled s poročilom PDF in CSV, pošiljanje ur vodji
 * (Google Preglednica), pregled ekipe za vodjo ter jutranji opomnik in opomnik za odhod
 * (spletna potisna obvestila, ki jih pošilja skripta v preglednici vodje).
 */
(function () {
  'use strict';

  const C = window.EvidencaCore;
  const DB = window.EvidencaDb;
  const PDF = window.EvidencaPdf;
  const { h, render } = window.preact;
  const { useState, useEffect, useRef } = window.preactHooks;
  const html = window.htm.bind(h);
  const {
    Day, YM, Fmt, Rec, Punch, DayType, TimeCalc, Holidays, Stats, Schedule, Csv, SyncPayload, SyncError,
    TodayStatus, DayRowText, DayHeader, SummaryTexts, TeamTexts, SettingsTexts, listDays,
  } = C;

  const APP_VERSION = '1.0';

  // ---------------------------------------------------------------------------
  // Naprava
  // ---------------------------------------------------------------------------

  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);

  function isStandalone() {
    if (navigator.standalone === true) return true;
    try {
      return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
    } catch (e) {
      return false;
    }
  }

  /** Ali je različica iOS vsaj major.minor (neznana različica velja za dovolj novo). */
  function iosAtLeast(major, minor) {
    const m = /OS (\d+)[_.](\d+)/.exec(ua);
    if (!m) return true;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > major || (a === major && b >= minor);
  }

  function deviceName() {
    let m;
    if ((m = /iPhone OS (\d+)[_.](\d+)/.exec(ua))) return 'iPhone, iOS ' + m[1] + '.' + m[2];
    if (isIOS) {
      m = /OS (\d+)[_.](\d+)/.exec(ua) || /Version\/(\d+)\.(\d+)/.exec(ua);
      return 'iPad' + (m ? ', iPadOS ' + m[1] + '.' + m[2] : '');
    }
    if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) return 'Android ' + m[1];
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Brskalnik';
  }

  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Ljubljana';
    } catch (e) {
      return 'Europe/Ljubljana';
    }
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const x = Array.from(b, (v) => (v < 16 ? '0' : '') + v.toString(16)).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  function errorText(e) {
    if (e instanceof SyncError) return e.message;
    return String((e && e.message) || e || 'Neznana napaka.');
  }

  // ---------------------------------------------------------------------------
  // Stanje aplikacije
  // ---------------------------------------------------------------------------

  const DEFAULT_SETTINGS = {
    employeeName: '',
    reportEmail: '',
    morningEnabled: true,
    morningMinutes: 7 * 60,
    workdays: [1, 2, 3, 4, 5],
    skipHolidays: true,
    departureEnabled: true,
    departureMinutes: 16 * 60,
    dailyMinutes: 8 * 60,
    paidBreakMinutes: 30,
    firstRunDone: false,
  };

  const DEFAULT_STATE = {
    employeeId: '',
    syncLink: '',
    syncRole: '',
    syncSheetUrl: '',
    lastSyncOk: 0,
    lastSyncError: '',
    lastPing: 0,
    pushServer: false,
    vapidKey: '',
    pushEndpoint: '',
    pushKey: '',
    pushRefreshed: '',
    connectHintHidden: 0,
  };

  const app = {
    days: new Map(),
    deleted: new Map(),
    settings: Object.assign({}, DEFAULT_SETTINGS),
    state: Object.assign({}, DEFAULT_STATE),
    revision: 0,
    listeners: new Set(),
    route: { tab: 'danes', sub: null },
    ui: {
      toast: null,
      modal: null,
      updateReady: false,
      storageError: '',
      syncing: false,
      month: YM.current(),
      teamMonth: YM.current(),
      team: {},
      teamLoadedAt: {},
      teamLoading: false,
      teamError: null,
      connectError: null,
      pushSubscribed: false,
      pushBusy: false,
      permission: 'default',
      installEvent: null,
      focusLink: false,
    },
  };

  function emit() {
    app.revision++;
    app.listeners.forEach((fn) => fn(app.revision));
  }

  function calc() {
    return { dailyMinutes: app.settings.dailyMinutes, paidBreakMinutes: app.settings.paidBreakMinutes };
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  }

  function sanitizeSettings(s) {
    const d = DEFAULT_SETTINGS;
    const days = Array.isArray(s.workdays) ? s.workdays.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 7) : d.workdays;
    return {
      employeeName: typeof s.employeeName === 'string' ? s.employeeName : '',
      reportEmail: typeof s.reportEmail === 'string' ? s.reportEmail : '',
      morningEnabled: s.morningEnabled !== false,
      morningMinutes: clampInt(s.morningMinutes, 0, 1439, d.morningMinutes),
      workdays: Array.from(new Set(days)).sort((a, b) => a - b),
      skipHolidays: s.skipHolidays !== false,
      departureEnabled: s.departureEnabled !== false,
      departureMinutes: clampInt(s.departureMinutes, 0, 1439, d.departureMinutes),
      dailyMinutes: clampInt(s.dailyMinutes, 1, 1440, d.dailyMinutes),
      paidBreakMinutes: clampInt(s.paidBreakMinutes, 0, 240, d.paidBreakMinutes),
      firstRunDone: s.firstRunDone === true,
    };
  }

  function persist(ops) {
    return DB.batch(ops).then(() => {
      if (app.ui.storageError) {
        app.ui.storageError = '';
        emit();
      }
    }).catch((e) => {
      app.ui.storageError = 'Podatkov ni bilo mogoče shraniti na telefon (' + errorText(e) + '). Ne zapiraj aplikacije in poskusi znova.';
      emit();
    });
  }

  function saveSettings() {
    return persist([{ store: 'kv', op: 'put', key: 'settings', value: Object.assign({}, app.settings) }]);
  }

  function saveState() {
    return persist([{ store: 'kv', op: 'put', key: 'state', value: Object.assign({}, app.state) }]);
  }

  async function loadAll() {
    const [days, deleted, settings, state] = await Promise.all([
      DB.getAll('days'), DB.getAll('deleted'), DB.get('kv', 'settings'), DB.get('kv', 'state'),
    ]);
    for (const e of days || []) {
      if (!e || !Day.valid(e.date)) continue;
      app.days.set(e.date, {
        record: C.record(e.date, e.record || {}),
        rev: Number(e.rev) || 0,
        syncedRev: Number(e.syncedRev) || 0,
        updatedAt: Number(e.updatedAt) || 0,
      });
    }
    for (const d of deleted || []) if (d && Day.valid(d.date)) app.deleted.set(d.date, d.at || 0);
    app.settings = sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, settings || {}));
    app.state = Object.assign({}, DEFAULT_STATE, state || {});
    if (!app.state.employeeId) app.state.employeeId = uuid();
    await DB.batch([
      { store: 'kv', op: 'put', key: 'settings', value: Object.assign({}, app.settings) },
      { store: 'kv', op: 'put', key: 'state', value: Object.assign({}, app.state) },
    ]);
  }

  // --- Dnevi ---

  function getRecord(day) {
    const e = app.days.get(day);
    return e ? Object.assign({}, e.record) : C.record(day);
  }

  function monthRecords(ym) {
    const out = {};
    for (const [d, e] of app.days) if (Day.ym(d) === ym) out[d] = e.record;
    return out;
  }

  function rangeRecords(from, to) {
    const out = {};
    for (const [d, e] of app.days) if (d >= from && d <= to) out[d] = e.record;
    return out;
  }

  function allRecords() {
    return Array.from(app.days.values(), (e) => e.record).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** Nedavni opisi/lokacije (najnovejši najprej). */
  function recentLocations(limit) {
    const last = new Map();
    for (const e of app.days.values()) {
      const loc = e.record.location;
      if (C.isBlank(loc)) continue;
      const prev = last.get(loc);
      if (!prev || prev < e.record.date) last.set(loc, e.record.date);
    }
    return Array.from(last.entries())
      .sort((a, b) => (a[1] !== b[1] ? (a[1] > b[1] ? -1 : 1) : a[0].localeCompare(b[0], 'sl')))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((x) => x[0]);
  }

  function pendingCount() {
    let n = 0;
    for (const e of app.days.values()) if (e.rev !== e.syncedRev) n++;
    return n + app.deleted.size;
  }

  function entryValue(key) {
    const e = app.days.get(key);
    return { date: key, record: e.record, rev: e.rev, syncedRev: e.syncedRev, updatedAt: e.updatedAt };
  }

  /** Shrani zapis dneva (prazen zapis izbriše dan). */
  function saveRecord(r) {
    const key = r.date;
    if (Rec.isEmpty(r)) return removeDay(key);
    const e = app.days.get(key);
    if (e) {
      if (Rec.equals(e.record, r) && !app.deleted.has(key)) return false;
      e.record = Object.assign({}, r);
      e.rev += 1;
      e.updatedAt = Date.now();
    } else {
      app.days.set(key, { record: Object.assign({}, r), rev: 1, syncedRev: 0, updatedAt: Date.now() });
    }
    const ops = [{ store: 'days', op: 'put', value: entryValue(key) }];
    if (app.deleted.delete(key)) ops.push({ store: 'deleted', op: 'delete', key });
    persist(ops);
    return true;
  }

  function removeDay(key) {
    if (!app.days.has(key)) return false;
    app.days.delete(key);
    const at = Date.now();
    app.deleted.set(key, at);
    persist([{ store: 'days', op: 'delete', key }, { store: 'deleted', op: 'put', value: { date: key, at } }]);
    return true;
  }

  function resetSync() {
    const ops = [];
    for (const [key, e] of app.days) {
      if (e.syncedRev !== 0) {
        e.syncedRev = 0;
        ops.push({ store: 'days', op: 'put', value: entryValue(key) });
      }
    }
    if (ops.length) persist(ops);
  }

  // --- Spremembe (enako kot AppModel v iPhone različici) ---

  function changed() {
    emit();
    scheduleSync(4);
  }

  function updateDay(day, fn) {
    const r = getRecord(day);
    const before = Object.assign({}, r);
    fn(r);
    if (Rec.equals(r, before)) return;
    saveRecord(r);
    changed();
  }

  function setTime(p, minutes, day) {
    updateDay(day, (r) => {
      r[p] = minutes;
    });
  }

  function setDayType(t, day) {
    updateDay(day, (r) => {
      r.dayType = t;
    });
  }

  function setVehicle(on, day) {
    updateDay(day, (r) => {
      r.ownVehicle = on;
    });
  }

  function setTexts(location, notes, km, day) {
    updateDay(day, (r) => {
      r.location = location.trim();
      r.notes = notes.trim();
      r.km = Math.min(Math.max(km | 0, 0), 99999);
    });
  }

  function deleteDay(day) {
    if (removeDay(day)) changed();
  }

  function deleteAll() {
    app.days.clear();
    app.deleted.clear();
    persist([{ store: 'days', op: 'clear' }, { store: 'deleted', op: 'clear' }]);
    changed();
  }

  let lastPunchAt = 0;

  /** Zabeleži dogodek za danes ob trenutnem času. Že vnesenega časa ne prepiše. */
  function punch(p) {
    const day = Day.today();
    const existing = getRecord(day);
    if (existing[p] != null) return { punch: p, time: existing[p], alreadySet: true };
    const now = C.nowMinutes();
    const r = Object.assign({}, existing);
    r[p] = now;
    // Če je bil dan označen kot odsotnost, a se zaposleni vseeno prijavi, je to delovni dan.
    if (p === 'arrival' && Rec.isAbsence(r)) r.dayType = 'WORK';
    saveRecord(r);
    changed();
    closeNotifications(p === 'arrival' ? 'jutro' : p === 'departure' ? 'odhod' : null);
    return { punch: p, time: now, alreadySet: false };
  }

  function punchMessage(res) {
    return res.alreadySet
      ? Punch.label(res.punch) + ' je bil že zabeležen ob ' + Fmt.clock(res.time) + '.'
      : Punch.doneLabel(res.punch) + ' ob ' + Fmt.clock(res.time) + '.';
  }

  /** Velik gumb na zaslonu Danes (z zaščito pred dvojnim tapom). */
  function punchFromButton(p) {
    if (Date.now() - lastPunchAt < 1500) return null;
    lastPunchAt = Date.now();
    const res = punch(p);
    toast(punchMessage(res));
    return res;
  }

  /** Gumb v obvestilu (Android) ali povezava ?akcija=… */
  function handleAction(a) {
    if (Punch.all.indexOf(a) < 0) return;
    const r = getRecord(Day.today());
    if (r[a] != null) {
      toast(punchMessage({ punch: a, time: r[a], alreadySet: true }));
      return;
    }
    toast(punchMessage(punch(a)));
  }

  function closeNotifications(tag) {
    if (!tag || !swReg || !swReg.getNotifications) return;
    swReg.getNotifications({ tag }).then((list) => list.forEach((n) => n.close())).catch(() => {});
  }

  // --- Sporočila ---

  let toastTimer = null;

  function toast(text) {
    app.ui.toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      app.ui.toast = null;
      emit();
    }, 2800);
    emit();
  }

  function showModal(m) {
    app.ui.modal = m;
    emit();
  }

  function closeModal() {
    app.ui.modal = null;
    emit();
  }

  function alertModal(title, text) {
    showModal({ title, text, buttons: [{ label: 'V redu', kind: 'primary' }] });
  }

  function confirmModal(title, text, okLabel, danger, onOk) {
    showModal({
      title,
      text,
      buttons: [{ label: 'Prekliči', kind: 'plain' }, { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: onOk }],
    });
  }

  // ---------------------------------------------------------------------------
  // Pošiljanje ur vodji (Google Apps Script)
  // ---------------------------------------------------------------------------

  function syncConnected() {
    return !C.isBlank(app.state.syncLink);
  }

  function isManager() {
    return syncConnected() && app.state.syncRole === 'manager';
  }

  function employeeInfo() {
    const name = app.settings.employeeName.trim();
    const id = app.state.employeeId;
    return {
      id,
      name: name || 'Zaposleni ' + id.slice(0, 4),
      app: APP_VERSION + ' (splet)',
      device: deviceName() + ' · splet',
      dailyMinutes: app.settings.dailyMinutes,
      paidBreakMinutes: app.settings.paidBreakMinutes,
    };
  }

  function withAction(base, action, extra) {
    const b = base.trim();
    return b + (b.indexOf('?') >= 0 ? '&' : '?') + 'action=' + action + (extra || '');
  }

  /**
   * Zahteva do skripte. POST pošlje besedilo (text/plain), da brskalnik ne potrebuje predhodne
   * zahteve CORS; Google odgovor vrne prek preusmeritve, ki ji brskalnik sledi sam.
   */
  async function request(method, url, body) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch(url, {
        method,
        body: body == null ? undefined : body,
        headers: body == null ? undefined : { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new SyncError('Strežnik se ne odziva (časovna omejitev).', true);
      if (navigator.onLine === false) throw new SyncError('Ni internetne povezave.', true);
      throw new SyncError('Strežnik ni dosegljiv. Preveri internetno povezavo in ali je povezava od vodje pravilna ' +
        '(spletna aplikacija skripte mora imeti dostop »Kdor koli«).', true);
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      throw new SyncError('Povezava se je prekinila. Poskusi znova.', true);
    }
    clearTimeout(timer);
    if (!res.ok) {
      const code = res.status;
      const transient = code >= 500 || code === 408 || code === 429;
      if (code === 401 || code === 403) throw new SyncError('Dostop zavrnjen (HTTP ' + code + '). Spletna aplikacija mora imeti dostop »Kdor koli« (Anyone).', transient);
      if (code === 404) throw new SyncError('Povezava ne obstaja (HTTP 404). Preveri, ali je povezava pravilno kopirana.', transient);
      throw new SyncError('Napaka strežnika (HTTP ' + code + '). Poskusi znova pozneje.', transient);
    }
    return text;
  }

  let syncTimer = null;
  let syncRunning = null;

  function scheduleSync(seconds) {
    if (!syncConnected()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncNow();
    }, seconds * 1000);
  }

  function pendingBatch(limit) {
    const out = [];
    for (const e of app.days.values()) if (e.rev !== e.syncedRev) out.push({ record: Object.assign({}, e.record), rev: e.rev });
    out.sort((a, b) => (a.record.date < b.record.date ? -1 : 1));
    return out.slice(0, limit);
  }

  function markSynced(items) {
    const ops = [];
    for (const p of items) {
      const e = app.days.get(p.record.date);
      if (e && e.rev === p.rev) {
        e.syncedRev = p.rev;
        ops.push({ store: 'days', op: 'put', value: entryValue(p.record.date) });
      }
    }
    if (ops.length) persist(ops);
  }

  function clearDeletes(days) {
    const ops = [];
    for (const d of days) {
      if (app.deleted.delete(d)) ops.push({ store: 'deleted', op: 'delete', key: d });
    }
    if (ops.length) persist(ops);
  }

  /** Pošlje vse neposlane spremembe (po 100 dni naenkrat). */
  function syncNow() {
    if (!syncConnected()) return Promise.resolve({ ok: true, message: 'Povezava z vodjo ni nastavljena.', sent: 0 });
    if (syncRunning) return syncRunning;
    clearTimeout(syncTimer);
    app.ui.syncing = true;
    emit();
    syncRunning = runSync().then((out) => {
      syncRunning = null;
      app.ui.syncing = false;
      if (!out.ok && out.transient && pendingCount() > 0) scheduleSync(90);
      emit();
      return out;
    });
    return syncRunning;
  }

  async function runSync() {
    let sent = 0;
    const link = app.state.syncLink.trim();
    try {
      for (let rounds = 0; rounds < 50; rounds++) {
        const batch = pendingBatch(100);
        const deletes = Array.from(app.deleted.keys()).sort();
        // Vodja, ki samo pregleduje ekipo (npr. na računalniku), se ne pojavi med zaposlenimi z 0 urami.
        if (isManager() && app.days.size === 0 && !batch.length && !deletes.length) break;
        const day = Day.today();
        const now = C.nowMinutes();
        const months = new Set([Day.ym(day), YM.add(Day.ym(day), -1)]);
        batch.forEach((p) => months.add(Day.ym(p.record.date)));
        deletes.forEach((d) => months.add(Day.ym(d)));
        const summaries = Array.from(months).sort((a, b) => a - b).map((m) => Stats.summarize(m, monthRecords(m), calc(), day, now));
        const body = SyncPayload.push(employeeInfo(), batch.map((p) => p.record), deletes, summaries, calc(), day);
        SyncPayload.parsePush(await request('POST', link, body));
        if (app.state.syncLink.trim() !== link) break;
        markSynced(batch);
        clearDeletes(deletes);
        sent += batch.length + deletes.length;
        if (batch.length < 100) break;
      }
      app.state.lastSyncOk = Date.now();
      app.state.lastSyncError = '';
      saveState();
      return { ok: true, message: sent > 0 ? 'Poslano vodji: ' + Fmt.days(sent) + '.' : 'Vse je že poslano.', sent };
    } catch (e) {
      const message = e instanceof SyncError ? e.message : 'Napaka: ' + errorText(e);
      if (app.state.syncLink.trim() === link) {
        app.state.lastSyncError = message;
        saveState();
      }
      return { ok: false, message, transient: !(e instanceof SyncError) || e.transient, sent };
    }
  }

  function applyPing(ping) {
    app.state.syncRole = ping.role;
    if (ping.spreadsheetUrl) app.state.syncSheetUrl = ping.spreadsheetUrl;
    app.state.pushServer = ping.push;
    app.state.vapidKey = ping.vapidPublicKey;
    app.state.lastPing = Date.now();
  }

  /** Preveri povezavo pri vodji in jo shrani. Vrne opis napake ali null. */
  async function connect(link) {
    const problem = SyncPayload.validateLink(link);
    if (problem) return problem;
    const base = link.trim();
    try {
      const ping = SyncPayload.parsePing(await request('GET', withAction(base, 'ping')));
      app.state.syncLink = base;
      app.state.syncSheetUrl = '';
      app.state.lastSyncError = '';
      app.state.lastSyncOk = 0;
      applyPing(ping);
      await saveState();
      resetSync();
      app.ui.team = {};
      app.ui.teamLoadedAt = {};
      app.ui.teamError = null;
      app.ui.connectError = null;
      emit();
      toast(ping.isManager ? 'Povezano kot vodja ✓ Ure ekipe so v zavihku Ekipa.' : 'Povezano ✓ Ure se bodo samodejno pošiljale vodji.');
      syncNow();
      refreshPushRegistration(true);
      return null;
    } catch (e) {
      return errorText(e);
    }
  }

  function disconnect() {
    const link = app.state.syncLink.trim();
    const endpoint = app.state.pushEndpoint;
    if (endpoint && link) {
      request('POST', link, JSON.stringify({ action: 'unsubscribe', endpoint })).catch(() => {});
    }
    if (swReg && swReg.pushManager) {
      swReg.pushManager.getSubscription().then((s) => s && s.unsubscribe()).catch(() => {});
    }
    Object.assign(app.state, {
      syncLink: '', syncRole: '', syncSheetUrl: '', lastSyncOk: 0, lastSyncError: '', pushServer: false, vapidKey: '',
      pushEndpoint: '', pushKey: '', pushRefreshed: '',
    });
    saveState();
    app.ui.team = {};
    app.ui.teamLoadedAt = {};
    app.ui.teamError = null;
    app.ui.pushSubscribed = false;
    if (app.route.tab === 'ekipa') navigate('nastavitve');
    emit();
  }

  /** Občasno osveži vlogo, URL preglednice in podatke za obvestila. */
  async function refreshPing(force) {
    if (!syncConnected()) return false;
    if (!force && Date.now() - app.state.lastPing < 6 * 3600 * 1000) return true;
    try {
      const ping = SyncPayload.parsePing(await request('GET', withAction(app.state.syncLink, 'ping')));
      const wasManager = isManager();
      applyPing(ping);
      saveState();
      if (wasManager && !isManager() && app.route.tab === 'ekipa') navigate('danes');
      emit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Ekipa (vodja)
  // ---------------------------------------------------------------------------

  function teamAge(month) {
    const t = app.ui.teamLoadedAt[month];
    return t ? (Date.now() - t) / 1000 : Infinity;
  }

  async function loadTeam(month) {
    if (!isManager() || app.ui.teamLoading) return;
    app.ui.teamLoading = true;
    emit();
    try {
      const data = SyncPayload.parseTeam(await request('GET', withAction(app.state.syncLink, 'team', '&month=' + month + '&today=' + Day.today())));
      app.ui.team[month] = data;
      app.ui.teamLoadedAt[month] = Date.now();
      app.ui.teamError = null;
      if (data.spreadsheetUrl && data.spreadsheetUrl !== app.state.syncSheetUrl) {
        app.state.syncSheetUrl = data.spreadsheetUrl;
        saveState();
      }
    } catch (e) {
      app.ui.teamError = errorText(e);
    }
    app.ui.teamLoading = false;
    emit();
  }

  // ---------------------------------------------------------------------------
  // Opomniki (spletna potisna obvestila)
  // ---------------------------------------------------------------------------

  let swReg = null;

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function notificationPermission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }

  function remindersWanted() {
    return app.settings.morningEnabled || app.settings.departureEnabled;
  }

  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function reminderPayload() {
    const s = app.settings;
    return {
      morningEnabled: s.morningEnabled,
      morning: s.morningMinutes,
      days: s.workdays.slice(),
      skipHolidays: s.skipHolidays,
      departureEnabled: s.departureEnabled,
      departure: s.departureMinutes,
    };
  }

  /** Stanje opomnikov na tej napravi (za besedila v nastavitvah). */
  function pushStatus() {
    if (!syncConnected()) return 'notConnected';
    if (!pushSupported()) return 'unsupported';
    if (!app.state.pushServer || !app.state.vapidKey) return 'serverOff';
    if (app.ui.permission === 'denied') return 'denied';
    if (app.ui.pushSubscribed && app.state.pushKey && app.state.pushKey !== app.state.vapidKey) return 'keyChanged';
    return app.ui.pushSubscribed ? 'on' : 'off';
  }

  async function registerWithServer(sub) {
    const body = JSON.stringify({
      action: 'subscribe',
      employee: employeeInfo(),
      device: deviceName() + ' · splet',
      origin: location.origin,
      timeZone: timeZone(),
      subscription: sub.toJSON(),
      reminders: reminderPayload(),
    });
    const res = SyncPayload.checkOk(await request('POST', app.state.syncLink.trim(), body));
    app.state.pushEndpoint = sub.endpoint;
    app.state.pushKey = app.state.vapidKey;
    app.state.pushRefreshed = Day.today();
    saveState();
    app.ui.pushSubscribed = true;
    return res;
  }

  /**
   * Vklop opomnikov na tej napravi. Kliče se neposredno iz tapa (Safari dovoli prijavo na
   * obvestila samo kot odziv na dejanje uporabnika), zato pred subscribe() ni čakanja.
   */
  function enableReminders(then) {
    const status = pushStatus();
    if (status === 'notConnected') {
      alertModal('Opomniki', 'Opomnike v spletni različici pošilja preglednica vodje. Najprej v Nastavitvah prilepi povezavo, ki si jo dobil od vodje.');
      return;
    }
    if (status === 'unsupported') {
      alertModal('Opomniki', unsupportedText());
      return;
    }
    if (status === 'serverOff') {
      app.ui.pushBusy = true;
      emit();
      refreshPing(true).then(() => {
        app.ui.pushBusy = false;
        emit();
        if (pushStatus() === 'serverOff') {
          alertModal('Opomniki še niso na voljo', 'Preglednica vodje še ne pošilja opomnikov. Vodja naj v Google Preglednici posodobi skripto (navodila so v datoteki README pri spletni različici).');
        } else {
          alertModal('Opomniki', 'Strežnik je pripravljen. Tapni »Vklopi opomnike« še enkrat.');
        }
      });
      return;
    }
    if (!swReg) {
      alertModal('Opomniki', 'Aplikacija se še nalaga. Poskusi znova čez nekaj sekund.');
      return;
    }
    let promise;
    try {
      promise = swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(app.state.vapidKey) });
    } catch (e) {
      promise = Promise.reject(e);
    }
    app.ui.pushBusy = true;
    emit();
    promise.then(async (sub) => {
      await registerWithServer(sub);
      toast('Opomniki so vklopljeni ✓');
      if (then) then();
    }).catch(async (e) => {
      app.ui.permission = notificationPermission();
      if (app.ui.permission === 'denied') {
        alertModal('Obvestila so izklopljena', deniedText());
      } else if (e && e.name === 'InvalidStateError') {
        try {
          const old = await swReg.pushManager.getSubscription();
          if (old) await old.unsubscribe();
        } catch (x) {
          // ni pomembno
        }
        alertModal('Opomniki', 'Ključ za obvestila se je zamenjal. Tapni »Vklopi opomnike« še enkrat.');
      } else if (app.ui.permission === 'default') {
        alertModal('Opomniki', 'Obvestila niso bila dovoljena. Če želiš opomnike, tapni »Vklopi opomnike« in izberi »Dovoli«.');
      } else {
        alertModal('Opomnikov ni bilo mogoče vklopiti', errorText(e));
      }
    }).finally(() => {
      app.ui.pushBusy = false;
      app.ui.permission = notificationPermission();
      emit();
    });
  }

  async function disableReminders() {
    app.ui.pushBusy = true;
    emit();
    try {
      const sub = swReg ? await swReg.pushManager.getSubscription() : null;
      const endpoint = (sub && sub.endpoint) || app.state.pushEndpoint;
      if (sub) await sub.unsubscribe();
      if (endpoint && syncConnected()) await request('POST', app.state.syncLink.trim(), JSON.stringify({ action: 'unsubscribe', endpoint })).catch(() => {});
      app.state.pushEndpoint = '';
      app.state.pushKey = '';
      saveState();
      app.ui.pushSubscribed = false;
      toast('Opomniki na tej napravi so izklopljeni.');
    } catch (e) {
      alertModal('Opomniki', errorText(e));
    }
    app.ui.pushBusy = false;
    emit();
  }

  function testNotification() {
    const status = pushStatus();
    if (status !== 'on') {
      enableReminders(() => sendTestPush());
      return;
    }
    sendTestPush();
  }

  async function sendTestPush() {
    app.ui.pushBusy = true;
    emit();
    try {
      await DB.put('kv', Date.now(), 'testPush');
      SyncPayload.checkOk(await request('POST', app.state.syncLink.trim(), JSON.stringify({ action: 'testPush', endpoint: app.state.pushEndpoint })));
      toast('Obvestilo je poslano – prikazalo se bo v nekaj sekundah.');
    } catch (e) {
      DB.put('kv', 0, 'testPush').catch(() => {});
      alertModal('Preizkus obvestila', errorText(e));
      checkPush();
    }
    app.ui.pushBusy = false;
    emit();
  }

  let pushTimer = null;

  /** Nastavitve opomnikov so se spremenile: sporoči jih strežniku (z zamikom). */
  function remindersChanged() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => refreshPushRegistration(true), 1500);
  }

  /** Osveži prijavo na strežniku (enkrat na dan ali ob spremembi nastavitev). */
  async function refreshPushRegistration(force) {
    if (!syncConnected() || !swReg || !pushSupported()) return;
    try {
      const sub = await swReg.pushManager.getSubscription();
      if (!sub) return;
      if (app.state.pushKey && app.state.vapidKey && app.state.pushKey !== app.state.vapidKey) return;
      if (!force && app.state.pushRefreshed === Day.today() && app.state.pushEndpoint === sub.endpoint) return;
      await registerWithServer(sub);
      emit();
    } catch (e) {
      // Poskusi znova ob naslednjem odprtju aplikacije.
    }
  }

  /** Ali je ta naprava še prijavljena (dovoljenje se lahko prekliče v nastavitvah telefona). */
  async function checkPush() {
    app.ui.permission = notificationPermission();
    if (!swReg || !pushSupported()) {
      app.ui.pushSubscribed = false;
      emit();
      return;
    }
    try {
      const sub = await swReg.pushManager.getSubscription();
      if (sub && syncConnected()) {
        app.ui.pushSubscribed = true;
        if (sub.endpoint !== app.state.pushEndpoint || app.state.pushRefreshed !== Day.today()) refreshPushRegistration(true);
      } else {
        app.ui.pushSubscribed = false;
        if (!sub && app.state.pushEndpoint) {
          const old = app.state.pushEndpoint;
          app.state.pushEndpoint = '';
          app.state.pushKey = '';
          saveState();
          if (syncConnected()) request('POST', app.state.syncLink.trim(), JSON.stringify({ action: 'unsubscribe', endpoint: old })).catch(() => {});
        }
      }
    } catch (e) {
      app.ui.pushSubscribed = false;
    }
    emit();
  }

  function unsupportedText() {
    if (isIOS && !isStandalone()) return 'Na iPhonu obvestila delujejo samo v aplikaciji, dodani na začetni zaslon. V Safariju tapni Deli → Dodaj na začetni zaslon in aplikacijo odpri z začetnega zaslona.';
    if (isIOS && !iosAtLeast(16, 4)) return 'Za obvestila potrebuješ iOS 16.4 ali novejši. Posodobi iPhone v Nastavitve → Splošno → Posodobitev programske opreme.';
    return 'Ta brskalnik ne podpira spletnih obvestil. Uporabi Safari (iPhone), Chrome ali Edge.';
  }

  function deniedText() {
    if (isIOS) return 'Obvestila za aplikacijo Evidenca so izklopljena. Vklopiš jih v nastavitvah telefona: Nastavitve → Obvestila → Evidenca → Dovoli obvestila.';
    return 'Obvestila za to stran so v brskalniku blokirana. Dovoli jih v nastavitvah strani (ikona ključavnice ob naslovu) in poskusi znova.';
  }

  /** Naslednji jutranji opomnik (brez dni, ko je prihod že vnesen ali je dan odsotnost). */
  function nextMorningReminder(today, now) {
    const s = app.settings;
    if (!s.morningEnabled) return null;
    const days = Schedule.upcoming(today, now, s.morningMinutes, s.workdays, s.skipHolidays, 30);
    for (const d of days) {
      const r = getRecord(d);
      if (r.arrival == null && !Rec.isAbsence(r)) return d;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Lokacija (GPS → naslov prek OpenStreetMap Nominatim)
  // ---------------------------------------------------------------------------

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Ta naprava ne omogoča določanja lokacije.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        if (err && err.code === 1) {
          reject(new Error(isIOS
            ? 'Dostop do lokacije ni dovoljen. Vklopiš ga v Nastavitve → Zasebnost in varnost → Lokacijske storitve (vklopljeno) in za Safari spletna mesta izberi »Med uporabo aplikacije«.'
            : 'Dostop do lokacije ni dovoljen. Dovoli ga v nastavitvah brskalnika za to stran.'));
        } else if (err && err.code === 3) {
          reject(new Error('Lokacije ni bilo mogoče določiti. Poskusi znova na prostem.'));
        } else {
          reject(new Error('Lokacije ni bilo mogoče določiti. Preveri, ali je lokacija vklopljena.'));
        }
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  }

  function formatAddress(a) {
    if (!a) return null;
    const street = [a.road || a.pedestrian || a.footway || a.path || a.square || a.place, a.house_number].filter(Boolean).join(' ').trim();
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county;
    const parts = [street, town].filter((x) => x && String(x).trim());
    return parts.length ? parts.join(', ') : null;
  }

  /** Naslov, npr. »Mariborska cesta 5, Celje«; če ga ni, koordinate. */
  async function currentAddress() {
    const pos = await currentPosition();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const coords = lat.toFixed(5) + ', ' + lon.toFixed(5);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 10000);
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=sl&lat=' +
        lat.toFixed(6) + '&lon=' + lon.toFixed(6), { headers: { Accept: 'application/json' }, credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) return coords;
      const j = await res.json();
      return formatAddress(j && j.address) || coords;
    } catch (e) {
      return coords;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Poročila (PDF in CSV) in deljenje
  // ---------------------------------------------------------------------------

  let pdfAssets = null;

  function loadPdfAssets() {
    if (!pdfAssets) {
      const get = (u) => fetch(u).then((r) => {
        if (!r.ok) throw new Error('Datoteke ' + u + ' ni bilo mogoče naložiti.');
        return r.arrayBuffer();
      });
      pdfAssets = Promise.all([get('Roboto-Regular.ttf'), get('Roboto-Bold.ttf'), get('logo-pdf.jpg')])
        .then(([regular, bold, logo]) => ({
          fonts: { regular: new PDF.TtfFont(regular, 'Roboto-Regular'), bold: new PDF.TtfFont(bold, 'Roboto-Bold') },
          logo,
        }));
      pdfAssets.catch(() => {
        pdfAssets = null;
      });
    }
    return pdfAssets;
  }

  function baseName(tag) {
    const who = Fmt.fileSafe(app.settings.employeeName);
    return who ? 'Evidenca_' + tag + '_' + who : 'Evidenca_' + tag;
  }

  async function makeReport(kind, month) {
    const today = Day.today();
    const who = app.settings.employeeName.trim();
    if (kind === 'pdf') {
      const assets = await loadPdfAssets();
      const bytes = await PDF.monthReport({
        month, records: monthRecords(month), settings: calc(), employee: who, today, now: C.nowMinutes(), fonts: assets.fonts, logo: assets.logo,
      });
      const mail = SummaryTexts.reportMail(month, who);
      return { file: new File([bytes], baseName(YM.text(month)) + '.pdf', { type: 'application/pdf' }), subject: mail.subject, body: mail.body };
    }
    if (kind === 'csv') {
      const mail = SummaryTexts.reportMail(month, who);
      const text = Csv.month(month, monthRecords(month), calc(), today);
      return { file: new File([text], baseName(YM.text(month)) + '.csv', { type: 'text/csv' }), subject: mail.subject, body: mail.body };
    }
    const text = Csv.all(allRecords(), calc(), today);
    return {
      file: new File([text], baseName('vse_' + today) + '.csv', { type: 'text/csv' }),
      subject: SummaryTexts.allDataMail.subject,
      body: SummaryTexts.allDataMail.body,
    };
  }

  function canShareFile(file) {
    try {
      return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
    } catch (e) {
      return false;
    }
  }

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('Kopirano: ' + text), () => alertModal('Kopiranje', text));
    } else {
      alertModal('E-naslov', text);
    }
  }

  /** Ustvari poročilo in odpre okno za deljenje (deljenje mora sprožiti nov tap). */
  async function exportReport(kind, month) {
    showModal({ title: 'Pripravljam poročilo …', text: '', buttons: [], busy: true });
    let rep;
    try {
      rep = await makeReport(kind, month);
    } catch (e) {
      alertModal('Poročilo', 'Poročila ni bilo mogoče ustvariti: ' + errorText(e));
      return;
    }
    const email = app.settings.reportEmail.trim();
    const share = canShareFile(rep.file);
    const size = rep.file.size < 1024 * 1024 ? Math.max(1, Math.round(rep.file.size / 1024)) + ' kB' : (rep.file.size / 1048576).toFixed(1).replace('.', ',') + ' MB';
    const buttons = [];
    if (share) {
      buttons.push({
        label: 'Pošlji / deli', kind: 'primary', icon: 'share', keepOpen: true,
        onClick: () => {
          navigator.share({ files: [rep.file], title: rep.subject }).then(closeModal, (e) => {
            if (!e || e.name !== 'AbortError') downloadFile(rep.file);
          });
        },
      });
    }
    buttons.push({ label: 'Prenesi', kind: share ? 'outline' : 'primary', icon: 'download', keepOpen: true, onClick: () => downloadFile(rep.file) });
    if (email) buttons.push({ label: 'Kopiraj e-naslov', kind: 'outline', icon: 'mail', keepOpen: true, onClick: () => copyText(email) });
    buttons.push({ label: 'Zapri', kind: 'plain' });
    let text = rep.file.name + ' · ' + size;
    if (share) text += '\n\nTapni »Pošlji / deli« in izberi Mail, Viber, WhatsApp ali Shrani v Datoteke.';
    if (email) text += '\n\nPrejemnik poročil: ' + email + (share ? ' (naslov kopiraš z gumbom spodaj in ga prilepiš v polje Za).' : '');
    showModal({ title: 'Poročilo je pripravljeno', text, buttons, stack: true });
  }

  // ---------------------------------------------------------------------------
  // Usmerjanje med zasloni
  // ---------------------------------------------------------------------------

  const TABS = ['danes', 'pregled', 'ekipa', 'nastavitve'];
  const scrollMemory = {};

  let pendingTab = null;

  function navigate(tab) {
    // Odprt podzaslon ima svoj vnos v zgodovini – najprej se vrni, nato preklopi zavihek.
    if (app.route.sub && history.state && history.state.sub) {
      pendingTab = tab;
      history.back();
      setTimeout(() => {
        if (pendingTab) {
          const t = pendingTab;
          pendingTab = null;
          app.route = { tab: t, sub: null };
          navigate(t);
        }
      }, 400);
      return;
    }
    app.route = { tab, sub: null };
    try {
      history.replaceState({ tab }, '', '#' + tab);
    } catch (e) {
      // ni pomembno
    }
    window.scrollTo(0, 0);
    emit();
  }

  function openSub(sub) {
    scrollMemory[app.route.tab] = window.scrollY;
    app.route = { tab: app.route.tab, sub };
    try {
      history.pushState({ tab: app.route.tab, sub }, '', '#' + app.route.tab + '/' + (sub.type === 'day' ? sub.date : sub.id));
    } catch (e) {
      // ni pomembno
    }
    window.scrollTo(0, 0);
    emit();
  }

  function goBack() {
    if (history.state && history.state.sub) history.back();
    else closeSub();
  }

  function closeSub() {
    const tab = app.route.tab;
    app.route = { tab, sub: null };
    emit();
    const y = scrollMemory[tab] || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  window.addEventListener('popstate', (e) => {
    const st = e.state || {};
    if (app.ui.modal && !app.ui.modal.busy) app.ui.modal = null;
    if (pendingTab) {
      const t = pendingTab;
      pendingTab = null;
      app.route = { tab: t, sub: null };
      navigate(t);
      return;
    }
    if (st.sub) {
      app.route = { tab: st.tab || app.route.tab, sub: st.sub };
      emit();
    } else {
      if (st.tab && TABS.indexOf(st.tab) >= 0) app.route.tab = st.tab;
      closeSub();
    }
  });

  // ---------------------------------------------------------------------------
  // Gradniki
  // ---------------------------------------------------------------------------

  /* Ikone Material Design (Apache 2.0), enake kot v Androidni različici. */
  const ICONS = {"back": "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z","bell": "M12,22c1.1,0 2,-0.9 2,-2h-4c0,1.1 0.89,2 2,2zM18,16v-5c0,-3.07 -1.64,-5.64 -4.5,-6.32V4c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68C7.63,5.36 6,7.92 6,11v5l-2,2v1h16v-1l-2,-2z","car": "M18.92,6.01C18.72,5.42 18.16,5 17.5,5h-11c-0.66,0 -1.21,0.42 -1.42,1.01L3,12v8c0,0.55 0.45,1 1,1h1c0.55,0 1,-0.45 1,-1v-1h12v1c0,0.55 0.45,1 1,1h1c0.55,0 1,-0.45 1,-1v-8l-2.08,-5.99zM6.5,16c-0.83,0 -1.5,-0.67 -1.5,-1.5S5.67,13 6.5,13s1.5,0.67 1.5,1.5S7.33,16 6.5,16zM17.5,16c-0.83,0 -1.5,-0.67 -1.5,-1.5s0.67,-1.5 1.5,-1.5 1.5,0.67 1.5,1.5 -0.67,1.5 -1.5,1.5zM5,11l1.5,-4.5h11L19,11H5z","check": "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM10,17l-5,-5 1.41,-1.41L10,14.17l7.59,-7.59L19,8l-9,9z","chevron_left": "M15.41,7.41L14,6l-6,6 6,6 1.41,-1.41L10.83,12z","chevron_right": "M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z","clock": "M11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10C17.52,22 22,17.52 22,12S17.52,2 11.99,2zM12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8zM12.5,7H11v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z","close": "M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z","cloud_done": "M19.35,10.04C18.67,6.59 15.64,4 12,4 9.11,4 6.6,5.64 5.35,8.04 2.34,8.36 0,10.91 0,14c0,3.31 2.69,6 6,6h13c2.76,0 5,-2.24 5,-5 0,-2.64 -2.05,-4.78 -4.65,-4.96zM10,17l-3.5,-3.5 1.41,-1.41L10,14.17 15.18,9l1.41,1.41L10,17z","cloud_off": "M19.35,10.04C18.67,6.59 15.64,4 12,4c-1.48,0 -2.85,0.43 -4.01,1.17l1.46,1.46C10.21,6.23 11.08,6 12,6c3.04,0 5.5,2.46 5.5,5.5v0.5H19c1.66,0 3,1.34 3,3 0,1.13 -0.64,2.11 -1.56,2.62l1.45,1.45C23.16,18.16 24,16.68 24,15c0,-2.64 -2.05,-4.78 -4.65,-4.96zM3,5.27l2.75,2.74C2.56,8.15 0,10.77 0,14c0,3.31 2.69,6 6,6h11.73l2,2L21,20.73 4.27,4 3,5.27zM7.73,10l8,8H6c-2.21,0 -4,-1.79 -4,-4s1.79,-4 4,-4h1.73z","coffee": "M20,3H4v10c0,2.21 1.79,4 4,4h6c2.21,0 4,-1.79 4,-4v-3h2c1.11,0 2,-0.9 2,-2V5C22,3.89 21.11,3 20,3zM20,8h-2V5h2V8zM4,19h16v2H4V19z","delete": "M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z","doc": "M14,2H6c-1.1,0 -1.99,0.9 -1.99,2L4,20c0,1.1 0.89,2 1.99,2H18c1.1,0 2,-0.9 2,-2V8L14,2zM16,18H8v-2h8V18zM16,14H8v-2h8V14zM13,9V3.5L18.5,9H13z","edit": "M3,17.25V21h3.75L17.81,9.94l-3.75,-3.75L3,17.25zM20.71,7.04c0.39,-0.39 0.39,-1.02 0,-1.41l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83z","link": "M3.9,12c0,-1.71 1.39,-3.1 3.1,-3.1h4L11,7L7,7c-2.76,0 -5,2.24 -5,5s2.24,5 5,5h4v-1.9L7,15.1c-1.71,0 -3.1,-1.39 -3.1,-3.1zM8,13h8v-2L8,11v2zM17,7h-4v1.9h4c1.71,0 3.1,1.39 3.1,3.1s-1.39,3.1 -3.1,3.1h-4L13,17h4c2.76,0 5,-2.24 5,-5s-2.24,-5 -5,-5z","location": "M12,2C8.13,2 5,5.13 5,9c0,5.25 7,13 7,13s7,-7.75 7,-13C19,5.13 15.87,2 12,2zM12,11.5c-1.38,0 -2.5,-1.12 -2.5,-2.5s1.12,-2.5 2.5,-2.5 2.5,1.12 2.5,2.5 -1.12,2.5 -2.5,2.5z","location_small": "M12,2C8.13,2 5,5.13 5,9c0,5.25 7,13 7,13s7,-7.75 7,-13C19,5.13 15.87,2 12,2zM12,11.5c-1.380,0 -2.5,-1.12 -2.5,-2.5s1.12,-2.5 2.5,-2.5 2.5,1.12 2.5,2.5 -1.12,2.5 -2.5,2.5z","login": "M11,7L9.6,8.4l2.6,2.6H2v2h10.2l-2.6,2.6L11,17l5,-5L11,7zM20,19h-8v2h8c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2h-8v2h8V19z","logout": "M17,7l-1.41,1.41L18.17,11H8v2h10.17l-2.58,2.58L17,17l5,-5zM4,5h8V3H4c-1.1,0 -2,0.9 -2,2v14c0,1.1 0.9,2 2,2h8v-2H4V5z","lunch": "M11,9H9V2H7v7H5V2H3v7c0,2.12 1.66,3.84 3.75,3.97V22h2.5v-9.03C11.34,12.84 13,11.12 13,9V2h-2V9zM16,6v8h2.5v8H21V2C18.24,2 16,4.24 16,6z","mail": "M20,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2zM20,8l-8,5 -8,-5V6l8,5 8,-5v2z","month": "M19,4h-1V2h-2v2H8V2H6v2H5C3.89,4 3.01,4.9 3.01,6L3,20c0,1.1 0.89,2 2,2h14c1.1,0 2,-0.9 2,-2V6C21,4.9 20.1,4 19,4zM19,20H5V10h14V20zM9,14H7v-2h2V14zM13,14h-2v-2h2V14zM17,14h-2v-2h2V14zM9,18H7v-2h2V18zM13,18h-2v-2h2V18zM17,18h-2v-2h2V18z","open": "M19,19H5V5h7V3H5c-1.11,0 -2,0.9 -2,2v14c0,1.1 0.89,2 2,2h14c1.1,0 2,-0.9 2,-2v-7h-2v7zM14,3v2h3.59l-9.83,9.83 1.41,1.41L19,6.41V10h2V3h-7z","person": "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM12,6c1.93,0 3.5,1.57 3.5,3.5S13.93,13 12,13s-3.5,-1.57 -3.5,-3.5S10.07,6 12,6zM12,20c-2.03,0 -4.43,-0.82 -6.14,-2.88C7.55,15.8 9.68,15 12,15s4.45,0.8 6.14,2.12C16.43,19.18 14.03,20 12,20z","play": "M8,5v14l11,-7z","refresh": "M17.65,6.35C16.2,4.9 14.21,4 12,4c-4.42,0 -7.99,3.58 -7.99,8s3.57,8 7.99,8c3.73,0 6.84,-2.55 7.73,-6h-2.08c-0.82,2.33 -3.04,4 -5.65,4 -3.31,0 -6,-2.69 -6,-6s2.69,-6 6,-6c1.66,0 3.14,0.69 4.22,1.78L13,11h7V4l-2.35,2.35z","settings": "M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z","share": "M18,16.08c-0.76,0 -1.44,0.3 -1.96,0.77L8.91,12.7c0.05,-0.23 0.09,-0.46 0.09,-0.7s-0.04,-0.47 -0.09,-0.7l7.05,-4.11c0.54,0.5 1.25,0.81 2.04,0.81 1.66,0 3,-1.34 3,-3s-1.34,-3 -3,-3 -3,1.34 -3,3c0,0.24 0.04,0.47 0.09,0.7L8.04,9.81C7.5,9.31 6.79,9 6,9c-1.66,0 -3,1.34 -3,3s1.34,3 3,3c0.79,0 1.5,-0.31 2.04,-0.81l7.12,4.16c-0.05,0.21 -0.08,0.43 -0.08,0.65 0,1.61 1.31,2.92 2.92,2.92 1.61,0 2.92,-1.31 2.92,-2.92s-1.31,-2.92 -2.92,-2.92z","stat_reseno": ["M1.4,12.6L3.3,11.1L5.7,14.2L11.5,5.4L13.4,5.4L22.6,14.6L20.2,17L12.6,9.2L6.6,18.1L4.8,18.1Z","M9.5,11.9h2v2h-2zM12.1,11.9h2v2h-2zM9.5,14.5h2v2h-2zM12.1,14.5h2v2h-2z","M19.4,2.3a2.4,2.4 0,1 1,-0.01 0z"],"sun": "M6.76,4.84l-1.8,-1.79 -1.41,1.41 1.79,1.79 1.42,-1.41zM4,10.5H1v2h3v-2zM13,0.55h-2V3.5h2V0.55zM20.45,4.46l-1.41,-1.41 -1.79,1.79 1.41,1.41 1.79,-1.79zM17.24,18.16l1.79,1.8 1.41,-1.41 -1.8,-1.79 -1.4,1.4zM20,10.5v2h3v-2h-3zM12,5.5c-3.31,0 -6,2.69 -6,6s2.69,6 6,6 6,-2.69 6,-6 -2.69,-6 -6,-6zM11,22.45h2V19.5h-2v2.95zM3.55,18.54l1.41,1.41 1.79,-1.8 -1.41,-1.41 -1.79,1.8z","table": "M10,10.02h5V21h-5zM17,21h3c1.1,0 2,-0.9 2,-2v-9h-5v11zM20,3H5c-1.1,0 -2,0.9 -2,2v3h19V5c0,-1.1 -0.9,-2 -2,-2zM3,19c0,1.1 0.9,2 2,2h3V10H3v9z","team": "M16,11c1.66,0 2.99,-1.34 2.99,-3S17.66,5 16,5c-1.66,0 -3,1.34 -3,3s1.34,3 3,3zM8,11c1.66,0 2.99,-1.34 2.99,-3S9.66,5 8,5C6.34,5 5,6.34 5,8s1.34,3 3,3zM8,13c-2.33,0 -7,1.17 -7,3.5L1,19h14v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5zM16,13c-0.29,0 -0.62,0.02 -0.97,0.05 1.16,0.84 1.97,1.97 1.97,3.45L17,19h6v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5z","today": "M19,3h-1V1h-2v2H8V1H6v2H5C3.89,3 3.01,3.9 3.01,5L3,19c0,1.1 0.89,2 2,2h14c1.1,0 2,-0.9 2,-2V5C21,3.9 20.1,3 19,3zM19,19H5V8h14V19zM7,10h5v5H7z","warning": "M1,21h22L12,2 1,21zM13,18h-2v-2h2v2zM13,14h-2v-4h2v4z"};
  Object.assign(ICONS, {
    info: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM13,17h-2v-6h2v6zM13,9h-2V7h2v2z',
    paste: 'M19,2h-4.18C14.4,0.84 13.3,0 12,0c-1.3,0 -2.4,0.84 -2.82,2H5c-1.1,0 -2,0.9 -2,2v16c0,1.1 0.9,2 2,2h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM12,2c0.55,0 1,0.45 1,1s-0.45,1 -1,1 -1,-0.45 -1,-1 0.45,-1 1,-1zM19,20H5V4h2v3h10V4h2v16z',
    download: 'M19,9h-4V3H9v6H5l7,7 7,-7zM5,18v2h14v-2H5z',
    ios_share: 'M16,5l-1.42,1.42 -1.59,-1.59V16h-1.98V4.83L9.42,6.42 8,5l4,-4 4,4zM20,10v11c0,1.1 -0.9,2 -2,2H6c-1.11,0 -2,-0.9 -2,-2V10c0,-1.11 0.89,-2 2,-2h3v2H6v11h12V10h-3V8h3c1.1,0 2,0.89 2,2z',
    add_box: 'M19,3H5c-1.11,0 -2,0.9 -2,2v14c0,1.1 0.89,2 2,2h14c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2zM19,19H5V5h14v14zM11,17h2v-4h4v-2h-4V7h-2v4H7v2h4z',
    bell_off: 'M20,18.69L7.84,6.14 5.27,3.49 4,4.76l2.8,2.8v0.01c-0.52,0.99 -0.8,2.16 -0.8,3.42v5l-2,2v1h13.73l2,2L21,19.72l-1,-1.03zM12,22c1.11,0 2,-0.89 2,-2h-4c0,1.11 0.89,2 2,2zM18,14.68V11c0,-3.08 -1.64,-5.64 -4.5,-6.32V4c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68c-0.15,0.03 -0.29,0.08 -0.42,0.12 -0.1,0.03 -0.2,0.07 -0.3,0.11h-0.01c-0.01,0 -0.01,0 -0.02,0.01 -0.23,0.09 -0.46,0.2 -0.68,0.31 0,0 -0.01,0 -0.01,0.01L18,14.68z',
    send: 'M2.01,21L23,12 2.01,3 2,10l15,2 -15,2z',
    phone: 'M17,1.01L7,1c-1.1,0 -2,0.9 -2,2v18c0,1.1 0.9,2 2,2h10c1.1,0 2,-0.9 2,-2V3c0,-1.1 -0.9,-1.99 -2,-1.99zM17,19H7V5h10v14z',
    minus: 'M19,13H5v-2h14v2z',
    plus: 'M19,13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  });

  const STAT_ICONS = { month: 'month', sun: 'sun', car: 'car', clock: 'clock', warning: 'warning', settings: 'settings' };

  function Icon({ name, size, cls }) {
    const p = ICONS[name];
    if (!p) return null;
    const list = Array.isArray(p) ? p : [p];
    const s = size || 22;
    return html`<svg class=${'icon' + (cls ? ' ' + cls : '')} width=${s} height=${s} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${list.map((d) => html`<path d=${d} />`)}
    </svg>`;
  }

  function AppHeader({ title, back, actions }) {
    return html`<header class="app-header">
      ${back
        ? html`<button class="hdr-back" onClick=${back} aria-label="Nazaj"><${Icon} name="chevron_left" size=${26} /><span>Nazaj</span></button>`
        : html`<img class="hdr-logo" src="logo-header.png" alt="Rešeno – rešitve energetske oskrbe" />`}
      <div class=${'hdr-title' + (back ? ' hdr-title-sub' : '')}>${title}</div>
      ${actions ? html`<div class="hdr-actions">${actions}</div>` : null}
    </header>`;
  }

  function CardTitle({ children }) {
    return html`<div class="card-title">${children}</div>`;
  }

  function HintCard({ icon, text, button, onClick, secondary, onSecondary, tone }) {
    return html`<div class=${'hint' + (tone === 'danger' ? ' hint-danger' : '')} role="status">
      <div class="hint-row"><${Icon} name=${icon} cls="hint-icon" /><div class="hint-text">${text}</div></div>
      ${(button || secondary) && html`<div class="hint-actions">
        ${secondary && html`<button class="btn-link" onClick=${onSecondary}>${secondary}</button>`}
        ${button && html`<button class="btn-outline-sm" onClick=${onClick}>${button}</button>`}
      </div>`}
    </div>`;
  }

  function Toggle({ checked, onChange, label, sub, disabled }) {
    return html`<label class=${'toggle-row' + (disabled ? ' disabled' : '')}>
      <span class="toggle-text"><span class="toggle-label">${label}</span>${sub && html`<span class="toggle-sub">${sub}</span>`}</span>
      <input type="checkbox" role="switch" class="switch" checked=${checked} disabled=${disabled}
        onChange=${(e) => onChange(e.currentTarget.checked)} />
    </label>`;
  }

  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const MINUTES = Array.from({ length: 60 }, (_, i) => i);

  /** Izbira ure v 24-urnem zapisu (dva izbirnika; na iPhonu se odpre kolesce). */
  function ClockPicker({ minutes, onChange, disabled, big, label }) {
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return html`<span class=${'clock' + (big ? ' big' : '') + (disabled ? ' disabled' : '')} role="group" aria-label=${label}>
      <select class="clock-sel num" value=${hh} disabled=${disabled} aria-label=${label + ' – ura'}
        onChange=${(e) => onChange(Number(e.currentTarget.value) * 60 + mm)}>
        ${HOURS.map((x) => html`<option key=${x} value=${x}>${C.pad(x, 2)}</option>`)}
      </select>
      <span class="clock-colon" aria-hidden="true">:</span>
      <select class="clock-sel num" value=${mm} disabled=${disabled} aria-label=${label + ' – minute'}
        onChange=${(e) => onChange(hh * 60 + Number(e.currentTarget.value))}>
        ${MINUTES.map((x) => html`<option key=${x} value=${x}>${C.pad(x, 2)}</option>`)}
      </select>
    </span>`;
  }

  function AutoTextarea(props) {
    const ref = useRef(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, props.minHeight || 0) + 'px';
    }, [props.value]);
    const rest = Object.assign({}, props);
    delete rest.minHeight;
    return html`<textarea ref=${ref} ...${rest}></textarea>`;
  }

  // --- Zaslon Danes ---

  const SUN_RAYS = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const r = (v) => Math.round(v * 10) / 10;
    return [r(60 + 37 * Math.cos(a)), r(60 + 37 * Math.sin(a)), r(60 + 51 * Math.cos(a)), r(60 + 51 * Math.sin(a))];
  });

  function HeroSun() {
    return html`<svg class="hero-sun" width="130" height="130" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle cx="60" cy="60" r="27" />
      ${SUN_RAYS.map((l, i) => html`<line key=${i} x1=${l[0]} y1=${l[1]} x2=${l[2]} y2=${l[3]} />`)}
    </svg>`;
  }

  function HeroCard({ status }) {
    return html`<section class="hero" aria-live="polite">
      <${HeroSun} />
      <div class="hero-date">${status.date}</div>
      <div class="hero-status"><span class=${'dot dot-hero-' + status.dot}></span><span>${status.status}</span></div>
      <div class="hero-worked num">${status.worked}</div>
      <div class="hero-sub">${status.sub}</div>
      ${status.showProgress && html`<div class="progress" aria-hidden="true">
          <div class="progress-fill" style=${{ width: status.progress > 0 ? 'max(10px, ' + (status.progress * 100).toFixed(1) + '%)' : '0' }}></div>
        </div>
        <div class="hero-target">${status.target}</div>`}
    </section>`;
  }

  const PUNCH_STYLE = {
    arrival: { icon: 'login', text: 'Prihod', cls: 'punch-arrival' },
    lunchStart: { icon: 'lunch', text: 'Malica', cls: 'punch-lunch' },
    lunchEnd: { icon: 'coffee', text: 'Konec malice', cls: 'punch-lunch' },
    departure: { icon: 'logout', text: 'Odhod', cls: 'punch-departure' },
  };

  function PunchButton({ punch: p, onClick }) {
    const st = PUNCH_STYLE[p];
    return html`<button class=${'punch ' + st.cls} onClick=${onClick} aria-label=${'Zabeleži: ' + Punch.label(p)}>
      <${Icon} name=${st.icon} size=${24} /><span>${st.text}</span>
    </button>`;
  }

  function TodayHints({ today }) {
    const hints = [];
    const status = pushStatus();
    if (app.ui.storageError) {
      hints.push(html`<${HintCard} key="storage" icon="warning" tone="danger" text=${app.ui.storageError} />`);
    }
    if (!syncConnected() && Date.now() - app.state.connectHintHidden > 30 * 86400000) {
      hints.push(html`<${HintCard} key="connect" icon="link"
        text="Poveži aplikacijo z vodjo: ure se bodo samodejno pošiljale v preglednico podjetja, vsako jutro pa te opomnik spomni na prihod."
        button="Poveži" onClick=${() => {
          app.ui.focusLink = true;
          navigate('nastavitve');
        }}
        secondary="Ne zdaj" onSecondary=${() => {
          app.state.connectHintHidden = Date.now();
          saveState();
          emit();
        }} />`);
    } else if (remindersWanted() && status === 'off' && app.settings.firstRunDone) {
      hints.push(html`<${HintCard} key="push" icon="bell" text="Jutranji opomnik na tej napravi še ni vklopljen."
        button=${app.ui.pushBusy ? 'Vklapljam …' : 'Vklopi opomnike'} onClick=${() => enableReminders()} />`);
    } else if (remindersWanted() && status === 'denied') {
      hints.push(html`<${HintCard} key="denied" icon="bell_off" text=${'Obvestila so izklopljena, zato opomnikov ne boš prejel. ' + deniedText()} />`);
    } else if (remindersWanted() && status === 'keyChanged') {
      hints.push(html`<${HintCard} key="key" icon="bell" text="Opomnike je treba na tej napravi znova vklopiti." button="Vklopi opomnike" onClick=${() => enableReminders()} />`);
    }
    return hints.length ? hints : null;
  }

  function TodayScreen({ now }) {
    const today = Day.fromDate(now);
    const minute = C.nowMinutes(now);
    const s = calc();
    const record = getRecord(today);
    const status = TodayStatus.make(record, s, minute);
    const punches = Rec.suggestedPunches(record);

    function tapped(p) {
      if (p === 'departure') {
        const nowM = C.nowMinutes();
        const worked = TimeCalc.totals(getRecord(Day.today()), calc(), nowM).worked;
        if (TodayStatus.confirmDeparture(worked, calc())) {
          confirmModal('Zabeležim odhod?', TodayStatus.departureQuestion(worked, nowM), 'Zabeleži odhod', false, () => punchFromButton('departure'));
          return;
        }
      }
      punchFromButton(p);
    }

    return html`<div class="screen">
      <${AppHeader} title="Evidenca dela" />
      <main class="content">
        <${TodayHints} today=${today} />
        <${HeroCard} status=${status} />
        ${punches.length > 0 && html`<div class="punch-row">${punches.map((p) => html`<${PunchButton} key=${p} punch=${p} onClick=${() => tapped(p)} />`)}</div>`}
        <${DayEditor} key=${today} day=${today} now=${now} />
        <${WeekCard} today=${today} minute=${minute} />
        <p class="save-note">${TodayStatus.saveNote(syncConnected(), pendingCount(), app.state.lastSyncOk, app.state.lastSyncError, today)}</p>
      </main>
    </div>`;
  }

  function WeekCard({ today, minute }) {
    const s = calc();
    const monday = Stats.weekStart(today);
    const records = rangeRecords(monday, Day.add(monday, 6));
    const minutes = Stats.weekMinutes(monday, records, s, today, minute);
    const expected = Stats.weekExpected(monday, s);
    const total = minutes.reduce((a, b) => a + b, 0);
    return html`<section class="card">
      <div class="card-head"><${CardTitle}>Ta teden<//><span class="card-head-value num">${Fmt.duration(total) + ' / ' + Fmt.hoursSetting(expected)}</span></div>
      <${WeekBars} minutes=${minutes} target=${s.dailyMinutes} todayIndex=${Day.dayOfWeek(today) - 1} />
    </section>`;
  }

  function WeekBars({ minutes, target, todayIndex }) {
    const height = 132;
    const labelH = 20;
    const valueH = 16;
    const chartH = height - labelH - valueH;
    const maxVal = Math.max(target * 1.2, Math.max.apply(null, minutes) * 1.05, 60);
    const targetY = height - labelH - chartH * (target / maxVal);
    const label = 'Ta teden: ' + minutes.map((v, i) => Fmt.dayTwo(i + 1) + ' ' + Fmt.hm(v)).join(', ');
    return html`<div class="week" style=${{ height: height + 'px' }} role="img" aria-label=${label}>
      ${target > 0 && html`<div class="week-target" style=${{ top: targetY + 'px' }}></div>`}
      ${minutes.map((v, i) => {
        const barH = v > 0 ? Math.max(chartH * (v / maxVal), 4) : 3;
        let color = 'var(--divider)';
        if (v > 0) color = i === todayIndex ? 'var(--sun)' : v >= target ? 'var(--navy)' : 'var(--blue)';
        return html`<div class="week-col" key=${i}>
          <div class="week-val num">${v > 0 ? Fmt.hm(v) : ''}</div>
          <div class="week-bar" style=${{ height: barH + 'px', background: color }}></div>
          <div class=${'week-day' + (i === todayIndex ? ' today' : '')}>${Fmt.dayTwo(i + 1)}</div>
        </div>`;
      })}
    </div>`;
  }

  // --- Urejevalnik dneva ---

  const TIME_STYLE = {
    arrival: { icon: 'login', cls: 'ti-blue' },
    lunchStart: { icon: 'lunch', cls: 'ti-sun' },
    lunchEnd: { icon: 'coffee', cls: 'ti-sun' },
    departure: { icon: 'logout', cls: 'ti-navy' },
  };

  function sameTexts(a, b) {
    return a.location === b.location && a.notes === b.notes && a.km === b.km;
  }

  /**
   * Urejevalnik enega dne: časi, opis/lokacija, lastno vozilo, opombe in vrsta dneva.
   * Vse spremembe se shranijo samodejno (besedilo z zamikom 0,7 s).
   */
  function DayEditor({ day }) {
    const record = getRecord(day);
    const [location, setLocation] = useState(record.location);
    const [notes, setNotes] = useState(record.notes);
    const [km, setKm] = useState(record.km > 0 ? String(record.km) : '');
    const [gpsBusy, setGpsBusy] = useState(false);
    const saved = useRef({ location: record.location, notes: record.notes, km: record.km });
    const vals = useRef(null);
    const timer = useRef(null);
    vals.current = { location, notes, km };

    function current() {
      const v = vals.current;
      return { location: v.location.trim(), notes: v.notes.trim(), km: parseInt(v.km || '0', 10) || 0 };
    }

    function save() {
      clearTimeout(timer.current);
      timer.current = null;
      const cur = current();
      if (sameTexts(cur, saved.current)) return;
      setTexts(cur.location, cur.notes, cur.km, day);
      saved.current = cur;
    }

    function scheduleSave() {
      clearTimeout(timer.current);
      timer.current = setTimeout(save, 700);
    }

    // Shrani ob zapiranju zaslona.
    useEffect(() => () => save(), []);

    // Besedilo se je lahko spremenilo drugje (npr. brisanje dneva); prevzemi ga, če tu ni neshranjenih sprememb.
    useEffect(() => {
      const stored = { location: record.location, notes: record.notes, km: record.km };
      if (sameTexts(current(), saved.current) && !sameTexts(stored, saved.current)) {
        setLocation(stored.location);
        setNotes(stored.notes);
        setKm(stored.km > 0 ? String(stored.km) : '');
        saved.current = stored;
      }
    }, [record.location, record.notes, record.km]);

    function editTime(p) {
      save();
      const existing = getRecord(day)[p];
      const initial = existing != null ? existing : DayHeader.suggestTime(p, getRecord(day), Day.today(), C.nowMinutes(), app.settings.dailyMinutes);
      showModal({ type: 'time', punch: p, day, initial, canClear: existing != null });
    }

    function fillLocation() {
      setGpsBusy(true);
      currentAddress().then((address) => {
        const merged = DayHeader.mergeLocation(vals.current.location, address);
        vals.current = Object.assign({}, vals.current, { location: merged });
        setLocation(merged);
        save();
      }).catch((e) => alertModal('Lokacija', errorText(e))).finally(() => setGpsBusy(false));
    }

    const problems = TimeCalc.problems(record, day < Day.today());
    const typed = location.trim();
    const typedLower = typed.toLocaleLowerCase('sl');
    const chips = recentLocations(15)
      .filter((loc) => loc !== typed && (!typed || loc.toLocaleLowerCase('sl').indexOf(typedLower) >= 0))
      .slice(0, 6);

    return html`<div class="editor">
      <section class="card">
        <${CardTitle}>Prihod, malica, odhod<//>
        <div class="time-rows">
          ${Punch.all.map((p) => {
            const st = TIME_STYLE[p];
            const m = record[p];
            return html`<button class="time-row" key=${p} onClick=${() => editTime(p)}
                aria-label=${Punch.label(p) + ': ' + (m != null ? Fmt.clock(m) : 'ni vneseno')}>
              <span class=${'time-icon ' + st.cls}><${Icon} name=${st.icon} size=${20} /></span>
              <span class="time-text"><span class="time-label">${Punch.label(p)}</span>
                <span class="time-hint">${m != null ? 'Tapni za popravek' : 'Tapni za vnos časa'}</span></span>
              <span class=${'time-value num' + (m == null ? ' empty' : '')}>${Fmt.clock(m)}</span>
            </button>`;
          })}
        </div>
        ${problems.length > 0 && html`<div class="problems">${problems.join('\n')}</div>`}
      </section>

      <section class="card">
        <${CardTitle}>Opis dneva / lokacija<//>
        <div class="loc-row">
          <${AutoTextarea} class="input" rows="1" value=${location} placeholder="npr. Celje, Mariborska 5 – montaža FE"
            enterkeyhint="done" autocapitalize="sentences"
            onInput=${(e) => {
              const v = e.currentTarget.value.replace(/\n/g, '');
              setLocation(v);
              vals.current = Object.assign({}, vals.current, { location: v });
              scheduleSave();
            }}
            onKeyDown=${(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            onBlur=${save} />
          <button class=${'gps-btn' + (gpsBusy ? ' busy' : '')} onClick=${fillLocation} disabled=${gpsBusy} aria-label="Vstavi trenutno lokacijo">
            ${gpsBusy ? html`<span class="spinner"></span>` : html`<${Icon} name="location" size=${22} />`}
          </button>
        </div>
        ${chips.length > 0 && html`<div class="chips">${chips.map((loc) => html`<button class="chip" key=${loc} onClick=${() => {
          vals.current = Object.assign({}, vals.current, { location: loc });
          setLocation(loc);
          save();
        }}>${loc}</button>`)}</div>`}
      </section>

      <section class="card">
        <${CardTitle}>Opombe<//>
        <label class="toggle-row">
          <span class="toggle-text with-icon"><${Icon} name="car" cls="blue" /><span class="toggle-label">Uporaba lastnega vozila</span></span>
          <input type="checkbox" role="switch" class="switch" checked=${record.ownVehicle}
            onChange=${(e) => {
              save();
              setVehicle(e.currentTarget.checked, day);
            }} />
        </label>
        ${record.ownVehicle && html`<div class="km-row">
          <span>Prevoženi kilometri</span>
          <input class="input km-input num" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="km" value=${km}
            onInput=${(e) => {
              const digits = e.currentTarget.value.replace(/[^0-9]/g, '').slice(0, 5);
              if (digits !== e.currentTarget.value) e.currentTarget.value = digits;
              setKm(digits);
              vals.current = Object.assign({}, vals.current, { km: digits });
              scheduleSave();
            }}
            onBlur=${save} />
        </div>`}
        <${AutoTextarea} class="input notes" rows="3" minHeight=${76} value=${notes} placeholder="Dodatne opombe (material, posebnosti …)"
          onInput=${(e) => {
            setNotes(e.currentTarget.value);
            vals.current = Object.assign({}, vals.current, { notes: e.currentTarget.value });
            scheduleSave();
          }}
          onBlur=${save} />
      </section>

      <section class="card">
        <${CardTitle}>Vrsta dneva<//>
        <div class="chips wrap" role="radiogroup" aria-label="Vrsta dneva">
          ${DayType.codes.map((t) => html`<button key=${t} role="radio" aria-checked=${record.dayType === t ? 'true' : 'false'}
            class=${'chip type' + (record.dayType === t ? ' on' : '')} onClick=${() => {
              save();
              setDayType(t, day);
            }}>${DayType.label(t)}</button>`)}
        </div>
      </section>
    </div>`;
  }

  /** Okno za izbiro ure (24-urni zapis). */
  function TimeSheet({ m }) {
    const [value, setValue] = useState(m.initial);
    const isToday = m.day === Day.today();
    const shift = (delta) => setValue(((value + delta) % 1440 + 1440) % 1440);
    return html`<div class="modal sheet" role="dialog" aria-modal="true" aria-label=${Punch.label(m.punch)}>
      <h2>${Punch.label(m.punch)}</h2>
      <p class="sheet-day">${Fmt.cap(Fmt.dateLong(m.day))}</p>
      <div class="time-pick">
        <button class="round-btn" onClick=${() => shift(-5)} aria-label="5 minut prej"><${Icon} name="minus" /></button>
        <${ClockPicker} big minutes=${value} label=${Punch.label(m.punch)} onChange=${setValue} />
        <button class="round-btn" onClick=${() => shift(5)} aria-label="5 minut pozneje"><${Icon} name="plus" /></button>
      </div>
      ${isToday && html`<button class="btn-link center" onClick=${() => setValue(C.nowMinutes())}>Nastavi na zdaj (${Fmt.clock(C.nowMinutes())})</button>`}
      <div class="modal-actions stack">
        <button class="btn btn-primary" onClick=${() => {
          closeModal();
          setTime(m.punch, value, m.day);
        }}>Shrani</button>
        ${m.canClear && html`<button class="btn btn-danger-outline" onClick=${() => {
          closeModal();
          setTime(m.punch, null, m.day);
        }}>Počisti čas</button>`}
        <button class="btn btn-plain" onClick=${closeModal}>Prekliči</button>
      </div>
    </div>`;
  }

  // --- Mesečni pregled ---

  function MonthSwitcher({ month, max, onChange }) {
    const canNext = month < max;
    return html`<div class="month-switch">
      <button class="icon-btn" onClick=${() => onChange(YM.add(month, -1))} aria-label="Prejšnji mesec"><${Icon} name="chevron_left" size=${26} /></button>
      <div class="month-title">${Fmt.monthTitle(month)}</div>
      <button class=${'icon-btn' + (canNext ? '' : ' dim')} onClick=${() => canNext && onChange(YM.add(month, 1))} aria-label="Naslednji mesec" disabled=${!canNext}>
        <${Icon} name="chevron_right" size=${26} /></button>
    </div>`;
  }

  function SummaryHero({ worked, expectedLabel, expected, balance, days }) {
    return html`<section class="hero summary">
      <div class="hero-label">Opravljene ure</div>
      <div class="summary-worked num">${Fmt.duration(worked)}</div>
      <div class="summary-cols">
        <div><div class="col-label">${expectedLabel}</div><div class="col-value num">${expected}</div></div>
        <div><div class="col-label">Razlika</div><div class="col-value num">${balance}</div></div>
        <div><div class="col-label">Dni dela</div><div class="col-value num">${days}</div></div>
      </div>
    </section>`;
  }

  function StatRows({ items }) {
    return html`<section class="card stats">
      ${items.map((it) => html`<div class=${'stat' + (it.warn ? ' warn' : '')} key=${it.label}>
        <${Icon} name=${STAT_ICONS[it.icon] || 'info'} size=${19} />
        <span class="stat-label">${it.label}</span>
        <span class="stat-value">${it.value}</span>
      </div>`)}
    </section>`;
  }

  function DayRow({ day, record, today, now, settings, onClick }) {
    const t = DayRowText.make(day, record || null, today, now, settings);
    return html`<button class=${'day-row bg-' + t.background} onClick=${onClick} aria-label=${t.accessibility}>
      <span class="day-num"><span class="day-dom">${Day.dom(day)}</span><span class="day-dow">${Fmt.dayShort(day).toUpperCase()}</span></span>
      <span class="day-body">
        <span class=${'day-main num tone-' + t.mainTone}>${t.main}</span>
        ${t.desc && html`<span class="day-desc">${t.desc}</span>`}
        ${t.flags && html`<span class=${'day-flags' + (t.flagsWarn ? ' warn' : '')}>${t.flags}</span>`}
      </span>
      ${t.total && html`<span class="day-total num">${t.total}</span>`}
    </button>`;
  }

  function MonthScreen({ now }) {
    const today = Day.fromDate(now);
    const minute = C.nowMinutes(now);
    const s = calc();
    const month = app.ui.month;
    const records = monthRecords(month);
    const sum = Stats.summarize(month, records, s, today, minute);
    const hero = SummaryTexts.monthHero(sum, month, today);
    const days = listDays(month, records, today);
    return html`<div class="screen">
      <${AppHeader} title="Mesečni pregled" />
      <main class="content">
        <${MonthSwitcher} month=${month} max=${YM.add(Day.ym(today), 12)} onChange=${(m) => {
          app.ui.month = m;
          emit();
        }} />
        <${SummaryHero} worked=${sum.workedMinutes} expectedLabel=${hero.expectedLabel} expected=${hero.expected} balance=${hero.balance} days=${sum.daysWorked} />
        <${StatRows} items=${SummaryTexts.monthExtras(sum)} />
        <div class="export-row">
          <button class="btn btn-outline" onClick=${() => exportReport('pdf', month)}><${Icon} name="doc" size=${20} />PDF poročilo</button>
          <button class="btn btn-outline" onClick=${() => exportReport('csv', month)}><${Icon} name="table" size=${20} />Excel (CSV)</button>
        </div>
        <div class="list-head"><${CardTitle}>Dnevi<//><span>Tapni dan za vnos ali popravek.</span></div>
        <div class="card list">
          ${days.map((d) => html`<${DayRow} key=${d} day=${d} record=${records[d]} today=${today} now=${minute} settings=${s}
            onClick=${() => openSub({ type: 'day', date: d })} />`)}
        </div>
      </main>
    </div>`;
  }

  function DayEditScreen({ date, now }) {
    const [gen, setGen] = useState(0);
    const today = Day.fromDate(now);
    const header = DayHeader.make(date, getRecord(date), today, C.nowMinutes(now), calc());
    function go(delta) {
      const d = Day.add(date, delta);
      app.route = { tab: app.route.tab, sub: { type: 'day', date: d } };
      try {
        history.replaceState({ tab: app.route.tab, sub: app.route.sub }, '', '#' + app.route.tab + '/' + d);
      } catch (e) {
        // ni pomembno
      }
      emit();
    }
    const actions = html`
      <button class="icon-btn" onClick=${() => go(-1)} aria-label="Prejšnji dan"><${Icon} name="chevron_left" size=${24} /></button>
      <button class="icon-btn" onClick=${() => go(1)} aria-label="Naslednji dan"><${Icon} name="chevron_right" size=${24} /></button>
      <button class="icon-btn danger" aria-label="Izbriši dan" onClick=${() => confirmModal('Izbrišem vnos?',
        'Izbrisani bodo vsi podatki za ' + Fmt.dateMedium(date) + '.', 'Izbriši', true, () => {
          deleteDay(date);
          setGen(gen + 1);
          toast('Vnos je izbrisan.');
        })}><${Icon} name="delete" size=${22} /></button>`;
    return html`<div class="screen">
      <${AppHeader} title=${header.title} back=${goBack} actions=${actions} />
      <main class="content">
        <div class="sub-title">${header.sub}</div>
        ${header.info && html`<div class="info-box"><${Icon} name="info" size=${20} /><span>${header.info}</span></div>`}
        <${DayEditor} key=${date + ':' + gen} day=${date} now=${now} />
      </main>
    </div>`;
  }

  // --- Ekipa (vodja) ---

  function latestTeam() {
    let best = null;
    for (const k of Object.keys(app.ui.team)) {
      const d = app.ui.team[k];
      if (!best || (d.generatedAt || 0) > (best.generatedAt || 0)) best = d;
    }
    return best;
  }

  const TEAM_DOT = { off: 'var(--input)', absent: 'var(--text2)', working: 'var(--sun)', lunch: 'var(--cyan)', done: 'var(--navy)' };

  function TeamScreen({ now }) {
    const today = Day.fromDate(now);
    const minute = C.nowMinutes(now);
    const month = app.ui.teamMonth;
    const data = app.ui.team[month] || null;
    const loading = app.ui.teamLoading;
    const status = TeamTexts.status(loading, app.ui.teamError, data, today);
    const sheetUrl = (app.state.syncSheetUrl || '').trim();

    useEffect(() => {
      if (teamAge(month) > 30) loadTeam(month);
      const id = setInterval(() => {
        if (document.visibilityState === 'visible' && teamAge(month) > 180) loadTeam(month);
      }, 60000);
      return () => clearInterval(id);
    }, [month]);

    const latest = latestTeam();
    const workday = Holidays.isWorkday(today);
    let todayBody;
    if (!latest) todayBody = html`<p class="empty">${loading ? 'Nalagam …' : 'Ni podatkov.'}</p>`;
    else if (latest.today !== today) todayBody = html`<p class="empty">Osveži za današnje stanje.</p>`;
    else if (!latest.members.length) todayBody = html`<p class="empty">V preglednici še ni zaposlenih. Pošlji jim povezavo za zaposlene.</p>`;
    else {
      todayBody = latest.members.map((m) => {
        const row = TeamTexts.todayRow(m, today, minute, workday);
        return html`<button class="team-today" key=${m.id} onClick=${() => openSub({ type: 'member', month: latest.month, id: m.id })}>
          <span class="team-dot" style=${{ background: TEAM_DOT[row.dot] }}></span>
          <span class="team-body"><span class="team-name">${m.name}</span><span class="team-status">${row.status}</span>
            ${row.place && html`<span class="team-place">${row.place}</span>`}</span>
          ${row.hours && html`<span class="team-hours num">${row.hours}</span>`}
          <${Icon} name="chevron_right" size=${18} cls="chev" />
        </button>`;
      });
    }

    let membersBody;
    if (!data) membersBody = html`<p class="empty pad">${loading ? 'Nalagam …' : 'Ni podatkov.'}</p>`;
    else if (!data.members.length) membersBody = html`<p class="empty pad">Za ta mesec še ni podatkov.</p>`;
    else {
      membersBody = data.members.map((m) => {
        const row = TeamTexts.memberRow(m, month, today);
        return html`<button class="member-row" key=${m.id} onClick=${() => openSub({ type: 'member', month, id: m.id })}>
          <span class="member-body">
            <span class="member-name">${m.name}</span>
            <span class=${'member-hours' + (row.hoursMuted ? ' muted' : '')}>${row.hours}</span>
            ${row.details && html`<span class="member-details">${row.details}</span>`}
            <span class="member-sync">${row.sync}</span>
          </span>
          <span class="member-balance"><span class=${'num bal-' + row.balanceTone}>${row.balance}</span><span class="bal-label">Razlika</span></span>
        </button>`;
      });
    }

    return html`<div class="screen">
      <${AppHeader} title="Pregled ekipe" />
      <main class="content">
        <${MonthSwitcher} month=${month} max=${Day.ym(today)} onChange=${(m) => {
          app.ui.teamMonth = m;
          emit();
        }} />
        <div class="status-row">
          <span class=${'status-text' + (app.ui.teamError ? ' warn' : '')}>${status}</span>
          <button class=${'icon-btn' + (loading ? ' spin' : '')} disabled=${loading} onClick=${() => loadTeam(month)} aria-label="Osveži">
            <${Icon} name="refresh" size=${22} /></button>
        </div>
        ${!data && app.ui.teamError && !loading && html`<${HintCard} icon="cloud_off" text=${'Podatkov ni bilo mogoče naložiti: ' + app.ui.teamError}
          button="Poskusi znova" onClick=${() => loadTeam(month)} />`}
        <section class="card">
          <div class="card-head"><${CardTitle}>Danes<//><span class="card-head-sub">${Fmt.cap(Fmt.dayName(today)) + ', ' + Fmt.dateShort(today)}</span></div>
          <div class="team-list">${todayBody}</div>
        </section>
        <section class="card list">
          <div class="card-title pad-title">Ure v mesecu · ${Fmt.monthName(month)}</div>
          ${membersBody}
        </section>
        ${sheetUrl && html`<a class="btn btn-outline" href=${sheetUrl} target="_blank" rel="noopener"><${Icon} name="table" size=${20} />Odpri Google Preglednico</a>`}
        <p class="foot-note">Ure pošiljajo aplikacije zaposlenih, ko imajo internet. Pri vsakem zaposlenem piše, kdaj je zadnjič poslal podatke.</p>
      </main>
    </div>`;
  }

  function TeamMemberScreen({ month, id, now }) {
    const today = Day.fromDate(now);
    const minute = C.nowMinutes(now);
    const data = app.ui.team[month];
    const m = data ? data.members.find((x) => x.id === id) : null;
    if (!m) {
      return html`<div class="screen">
        <${AppHeader} title="Zaposleni" back=${goBack} />
        <main class="content"><p class="empty">Podatki niso več na voljo. Osveži zavihek Ekipa.</p></main>
      </div>`;
    }
    const records = {};
    for (const r of m.days) records[r.date] = r;
    const sum = TeamTexts.summary(m, month, today, minute);
    const sub = Fmt.monthTitle(month) + (m.lastSync != null ? ' · poslano ' + TeamTexts.synced(m.lastSync, today) : '');
    return html`<div class="screen">
      <${AppHeader} title=${m.name} back=${goBack} />
      <main class="content">
        <div class="sub-title">${sub}</div>
        <${SummaryHero} worked=${sum.worked} expectedLabel="Fond ur" expected=${Fmt.hoursSetting(sum.expected)}
          balance=${SummaryTexts.memberBalance(sum, month, today)} days=${sum.daysWorked} />
        <${StatRows} items=${SummaryTexts.memberExtras(sum, month, today, m.settings)} />
        <div class="list-head"><${CardTitle}>Dnevi<//><span>Tapni dan za podrobnosti.</span></div>
        <div class="card list">
          ${listDays(month, records, today).map((d) => html`<${DayRow} key=${d} day=${d} record=${records[d]} today=${today} now=${minute}
            settings=${m.settings} onClick=${() => {
              if (records[d]) alertModal(Fmt.cap(Fmt.dateLong(d)), DayRowText.details(records[d], m.settings, today, minute));
            }} />`)}
        </div>
      </main>
    </div>`;
  }

  // --- Nastavitve ---

  function Section({ title, children, footer }) {
    return html`<section class="settings-section">
      <h2 class="section-title">${title}</h2>
      <div class="card settings-card">${children}</div>
      ${footer && html`<p class="section-footer">${footer}</p>`}
    </section>`;
  }

  function updateSettings(patch, opts) {
    Object.assign(app.settings, patch);
    app.settings = sanitizeSettings(app.settings);
    saveSettings();
    emit();
    const o = opts || {};
    if (o.reminders) remindersChanged();
    if (o.calc && syncConnected()) {
      resetSync();
      scheduleSync(4);
    }
    if (o.name && syncConnected()) scheduleSync(4);
  }

  function SettingsScreen({ now }) {
    const today = Day.fromDate(now);
    const s = app.settings;
    const [name, setName] = useState(s.employeeName);
    const [email, setEmail] = useState(s.reportEmail);
    const [link, setLink] = useState('');
    const [connecting, setConnecting] = useState(false);
    const linkRef = useRef(null);

    useEffect(() => {
      if (app.ui.focusLink && linkRef.current) {
        app.ui.focusLink = false;
        linkRef.current.scrollIntoView({ block: 'center' });
        linkRef.current.focus();
      }
    });

    function connectNow() {
      const value = link.trim();
      const problem = SyncPayload.validateLink(value);
      if (problem) {
        app.ui.connectError = problem;
        emit();
        return;
      }
      if (C.isBlank(app.settings.employeeName)) {
        alertModal('Ime in priimek', 'Najprej vpiši svoje ime in priimek (zgoraj pod Profil).');
        return;
      }
      setConnecting(true);
      app.ui.connectError = null;
      connect(value).then((err) => {
        setConnecting(false);
        app.ui.connectError = err;
        if (!err) setLink('');
        emit();
      });
    }

    function paste() {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        if (linkRef.current) linkRef.current.focus();
        return;
      }
      navigator.clipboard.readText().then((t) => setLink((t || '').trim()), () => {
        if (linkRef.current) linkRef.current.focus();
      });
    }

    const st = SettingsTexts.sync(syncConnected(), isManager(), pendingCount(), app.state.lastSyncOk, app.state.lastSyncError, app.ui.connectError, today);
    const syncIcon = !syncConnected() ? 'cloud_off' : st.ok ? 'cloud_done' : 'warning';
    const syncIconCls = !syncConnected() ? 'hint-color' : st.ok ? 'blue' : 'warn';
    const detailCls = st.danger ? 'danger' : st.tone === 'warning' ? 'warn' : 'muted';

    const next = nextMorningReminder(today, C.nowMinutes(now));
    const nextText = SettingsTexts.nextReminder(next, s.morningMinutes, s.morningEnabled, s.workdays.length === 0, today);
    const ps = pushStatus();
    const pushText = {
      notConnected: 'Opomnike v spletni različici pošilja preglednica vodje, zato delujejo, ko je aplikacija povezana z vodjo (zgoraj).',
      unsupported: unsupportedText(),
      serverOff: 'Preglednica vodje še ne pošilja opomnikov. Vodja naj posodobi skripto v Google Preglednici.',
      denied: deniedText(),
      keyChanged: 'Ključ za obvestila se je zamenjal. Opomnike je treba na tej napravi znova vklopiti.',
      off: 'Opomniki na tej napravi še niso vklopljeni.',
      on: 'Opomniki so vklopljeni na tej napravi.',
    }[ps];

    const dailyChoices = SettingsTexts.dailyChoices.indexOf(s.dailyMinutes) >= 0 ? SettingsTexts.dailyChoices
      : SettingsTexts.dailyChoices.concat([s.dailyMinutes]).sort((a, b) => a - b);
    const breakChoices = SettingsTexts.breakChoices.indexOf(s.paidBreakMinutes) >= 0 ? SettingsTexts.breakChoices
      : SettingsTexts.breakChoices.concat([s.paidBreakMinutes]).sort((a, b) => a - b);

    return html`<div class="screen">
      <${AppHeader} title="Nastavitve" />
      <main class="content settings">
        <${Section} title="Profil">
          <label class="field"><span class="field-label">Ime in priimek (za poročila)</span>
            <input class="input" type="text" value=${name} placeholder="npr. Janez Novak" autocomplete="name" autocapitalize="words" spellcheck=${false}
              onInput=${(e) => setName(e.currentTarget.value)}
              onBlur=${() => {
                if (name.trim() !== s.employeeName) updateSettings({ employeeName: name.trim() }, { name: true });
              }} /></label>
          <label class="field"><span class="field-label">E-naslov za pošiljanje poročil</span>
            <input class="input" type="email" value=${email} placeholder="npr. racunovodstvo@podjetje.si" autocomplete="email" autocapitalize="off" spellcheck=${false}
              onInput=${(e) => setEmail(e.currentTarget.value)}
              onBlur=${() => {
                if (email.trim() !== s.reportEmail) updateSettings({ reportEmail: email.trim() });
              }} /></label>
        <//>

        <${Section} title="Pošiljanje ur vodji">
          <div class="sync-status">
            <${Icon} name=${syncIcon} size=${26} cls=${syncIconCls} />
            <div><div class="sync-title">${st.title}</div><div class=${'sync-detail ' + detailCls}>${st.detail}</div></div>
          </div>
          ${syncConnected() ? html`
            <button class="row-btn" disabled=${app.ui.syncing} onClick=${() => syncNow().then((out) => toast(out.message))}>
              <${Icon} name="send" size=${20} />${app.ui.syncing ? 'Pošiljam …' : 'Pošlji zdaj'}</button>
            <button class="row-btn danger" onClick=${() => confirmModal('Prekinem povezavo z vodjo?',
              'Ure se ne bodo več pošiljale vodji, opomniki na tej napravi se izklopijo. Podatki na tem telefonu ostanejo.', 'Prekini', true, disconnect)}>
              <${Icon} name="close" size=${20} />Prekini povezavo</button>` : html`
            <div class="link-row">
              <textarea ref=${linkRef} class="input link-input" rows="2" value=${link} placeholder="Prilepi povezavo, ki si jo dobil od vodje"
                autocapitalize="off" autocomplete="off" spellcheck=${false} inputmode="url"
                onInput=${(e) => setLink(e.currentTarget.value.replace(/\s+/g, ''))}></textarea>
              <button class="paste-btn" onClick=${paste} aria-label="Prilepi"><${Icon} name="paste" size=${22} /></button>
            </div>
            <button class="btn btn-primary" disabled=${connecting || C.isBlank(link)} onClick=${connectNow}>
              <${Icon} name="link" size=${20} />${connecting ? 'Povezujem …' : 'Poveži'}</button>`}
        <//>

        <${Section} title="Opomniki" footer=${nextText + ' Opomnike pošilja preglednica vodje kot obvestilo – pridejo v nekaj minutah po nastavljeni uri, tudi ko aplikacija ni odprta. Če je prihod že zabeležen ali je označen dopust, jutranjega opomnika ni.'}>
          <div class=${'push-status push-' + ps}>
            <${Icon} name=${ps === 'on' ? 'bell' : ps === 'denied' ? 'bell_off' : 'bell'} size=${22} />
            <span>${pushText}</span>
          </div>
          ${(ps === 'off' || ps === 'keyChanged' || ps === 'serverOff') && html`<button class="btn btn-primary" disabled=${app.ui.pushBusy}
            onClick=${() => enableReminders()}><${Icon} name="bell" size=${20} />${app.ui.pushBusy ? 'Vklapljam …' : 'Vklopi opomnike'}</button>`}
          <${Toggle} label="Jutranji opomnik" sub="Obvestilo za beleženje prihoda" checked=${s.morningEnabled}
            onChange=${(v) => updateSettings({ morningEnabled: v }, { reminders: true })} />
          <div class=${'set-row' + (s.morningEnabled ? '' : ' disabled')}><span>Ura opomnika</span>
            <${ClockPicker} minutes=${s.morningMinutes} disabled=${!s.morningEnabled} label="Ura jutranjega opomnika"
              onChange=${(m) => updateSettings({ morningMinutes: m }, { reminders: true })} /></div>
          <div class=${'set-block' + (s.morningEnabled ? '' : ' disabled')}>
            <span>Dnevi opomnika</span>
            <div class="weekdays">${[1, 2, 3, 4, 5, 6, 7].map((d) => {
              const on = s.workdays.indexOf(d) >= 0;
              return html`<button key=${d} class=${'wd' + (on ? ' on' : '')} disabled=${!s.morningEnabled} aria-pressed=${on ? 'true' : 'false'}
                onClick=${() => updateSettings({ workdays: on ? s.workdays.filter((x) => x !== d) : s.workdays.concat([d]) }, { reminders: true })}>${Fmt.dayTwo(d)}</button>`;
            })}</div>
          </div>
          <${Toggle} label="Preskoči praznike" sub="Na dela proste dneve ni opomnika" checked=${s.skipHolidays}
            onChange=${(v) => updateSettings({ skipHolidays: v }, { reminders: true })} />
          <${Toggle} label="Opomnik za odhod" sub="Če odhod do te ure še ni zabeležen" checked=${s.departureEnabled}
            onChange=${(v) => updateSettings({ departureEnabled: v }, { reminders: true })} />
          <div class=${'set-row' + (s.departureEnabled ? '' : ' disabled')}><span>Ura opomnika za odhod</span>
            <${ClockPicker} minutes=${s.departureMinutes} disabled=${!s.departureEnabled} label="Ura opomnika za odhod"
              onChange=${(m) => updateSettings({ departureMinutes: m }, { reminders: true })} /></div>
          <button class="row-btn" disabled=${app.ui.pushBusy || ps === 'notConnected'} onClick=${testNotification}>
            <${Icon} name="bell" size=${20} />Preizkusi obvestilo</button>
          ${ps === 'on' && html`<button class="row-btn danger" disabled=${app.ui.pushBusy} onClick=${disableReminders}>
            <${Icon} name="bell_off" size=${20} />Izklopi opomnike na tej napravi</button>`}
        <//>

        <${Section} title="Delovni čas">
          <label class="set-row"><span class="toggle-text"><span class="toggle-label">Dnevni delovni čas</span><span class="toggle-sub">Za izračun fonda ur in nadur</span></span>
            <select class="select" value=${s.dailyMinutes} onChange=${(e) => updateSettings({ dailyMinutes: Number(e.currentTarget.value) }, { calc: true })}>
              ${dailyChoices.map((m) => html`<option key=${m} value=${m}>${Fmt.hoursSetting(m)}</option>`)}
            </select></label>
          <label class="set-row"><span class="toggle-text"><span class="toggle-label">Plačan odmor (malica)</span><span class="toggle-sub">Malica do te dolžine se šteje v delovni čas</span></span>
            <select class="select" value=${s.paidBreakMinutes} onChange=${(e) => updateSettings({ paidBreakMinutes: Number(e.currentTarget.value) }, { calc: true })}>
              ${breakChoices.map((m) => html`<option key=${m} value=${m}>${m + ' min'}</option>`)}
            </select></label>
        <//>

        ${!isStandalone() && html`<${Section} title="Namestitev">
          <p class="plain-text">${isIOS
            ? 'Na iPhonu aplikacijo namestiš v Safariju: Deli → Dodaj na začetni zaslon. Opomniki delujejo samo v nameščeni aplikaciji.'
            : 'Aplikacijo lahko namestiš kot samostojno aplikacijo z ikono na začetnem zaslonu ali namizju.'}</p>
          ${app.ui.installEvent && html`<button class="btn btn-primary" onClick=${() => {
            const ev = app.ui.installEvent;
            app.ui.installEvent = null;
            ev.prompt();
            emit();
          }}><${Icon} name="phone" size=${20} />Namesti aplikacijo</button>`}
        <//>`}

        <${Section} title="Podatki">
          <button class="row-btn" onClick=${() => exportReport('all', null)}>
            <${Icon} name="share" size=${20} /><span class="toggle-text"><span class="toggle-label">Izvozi vse podatke</span><span class="toggle-sub">CSV za Excel ali kot varnostna kopija</span></span></button>
          <button class="row-btn danger" onClick=${() => confirmModal('Izbrišem vse podatke?', SettingsTexts.deleteAllMessage(syncConnected()), 'Izbriši vse', true, () => {
            deleteAll();
            toast('Vsi podatki so izbrisani.');
          })}><${Icon} name="delete" size=${20} />Izbriši vse podatke</button>
        <//>

        <section class="about">
          <div class="about-head"><img src="logo-header.png" alt="" /><span>Rešeno Evidenca · spletna različica ${APP_VERSION}</span></div>
          <p>Podatki so shranjeni na tej napravi. Če je nastavljena povezava z vodjo, se vnosi pošiljajo tudi v preglednico podjetja (Google Preglednice).
            Trenutna lokacija se uporabi samo, ko tapneš gumb za lokacijo; naslov poišče OpenStreetMap.</p>
          <p>Podatki o naslovih © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">sodelavci OpenStreetMap</a>.
            Pisava Roboto (Apache 2.0), Preact (MIT).</p>
        </section>
      </main>
    </div>`;
  }

  // --- Dobrodošlica in namestitev ---

  function WelcomeScreen() {
    const [name, setName] = useState(app.settings.employeeName);
    const [link, setLink] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    function finish() {
      const n = name.trim();
      if (!n) {
        setError('Vpiši svoje ime in priimek.');
        return;
      }
      const l = link.trim();
      if (l) {
        const problem = SyncPayload.validateLink(l);
        if (problem) {
          setError(problem);
          return;
        }
      }
      updateSettings({ employeeName: n, firstRunDone: true });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      if (!l) return;
      setBusy(true);
      connect(l).then((err) => {
        setBusy(false);
        if (err) {
          app.ui.connectError = err;
          alertModal('Povezava ni uspela', err + '\n\nPovezavo lahko vneseš tudi pozneje v Nastavitvah.');
        }
      });
    }

    return html`<div class="welcome">
      <img class="welcome-logo" src="logo-full.png" alt="Rešeno – rešitve energetske oskrbe" />
      <h1>Dobrodošli! 👋</h1>
      <p class="welcome-text">${SettingsTexts.welcomeText(app.settings.morningMinutes)}</p>
      <input class="input big" type="text" value=${name} placeholder="npr. Janez Novak" autocomplete="name" autocapitalize="words" spellcheck=${false}
        onInput=${(e) => {
          setName(e.currentTarget.value);
          setError('');
        }} />
      <label class="field"><span class="field-label">Povezava od vodje (neobvezno – lahko tudi pozneje)</span>
        <textarea class="input link-input" rows="2" value=${link} placeholder="https://script.google.com/macros/s/…/exec?k=…"
          autocapitalize="off" autocomplete="off" spellcheck=${false} inputmode="url"
          onInput=${(e) => {
            setLink(e.currentTarget.value.replace(/\s+/g, ''));
            setError('');
          }}></textarea></label>
      ${error && html`<p class="form-error">${error}</p>`}
      <button class="btn btn-primary big" disabled=${busy} onClick=${finish}>${busy ? 'Povezujem …' : 'Začni'}</button>
    </div>`;
  }

  function InstallScreen({ onContinue }) {
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
    const oldIos = !iosAtLeast(16, 4);
    return html`<div class="install">
      <img class="welcome-logo" src="logo-full.png" alt="Rešeno – rešitve energetske oskrbe" />
      <h1>Namesti aplikacijo na začetni zaslon</h1>
      <p class="welcome-text">Rešeno Evidenca deluje kot aplikacija na iPhonu – brez App Stora. Namestitev traja 10 sekund:</p>
      <ol class="steps">
        <li><span class="step-num">1</span><span>Tapni gumb <b>Deli</b> <span class="inline-icon"><${Icon} name="ios_share" size=${20} /></span>
          ${safari ? ' v spodnji (ali zgornji) vrstici Safarija.' : ' v brskalniku (v Chromu je zgoraj desno).'}</span></li>
        <li><span class="step-num">2</span><span>Izberi <b>Dodaj na začetni zaslon</b> <span class="inline-icon"><${Icon} name="add_box" size=${20} /></span>
          (morda se moraš v seznamu pomakniti navzdol).</span></li>
        <li><span class="step-num">3</span><span>Tapni <b>Dodaj</b> zgoraj desno.</span></li>
        <li><span class="step-num">4</span><span>Aplikacijo <b>Evidenca</b> odpri z začetnega zaslona.</span></li>
      </ol>
      ${!safari && html`<p class="install-note">Če gumba ni, povezavo odpri v Safariju (npr. iz Viberja ali e-pošte: ⋯ → Odpri v Safariju).</p>`}
      ${oldIos && html`<p class="install-note warn">Za opomnike potrebuješ iOS 16.4 ali novejši (Nastavitve → Splošno → Posodobitev programske opreme).</p>`}
      <p class="install-note">Opomniki (obvestila) delujejo samo v aplikaciji na začetnem zaslonu. Podatki se shranjujejo v aplikaciji, zato ure vnašaj tam – ne v Safariju.</p>
      <button class="btn-link center small" onClick=${onContinue}>Vseeno nadaljuj v brskalniku</button>
    </div>`;
  }

  // --- Okna in sporočila ---

  function ModalHost() {
    const m = app.ui.modal;
    if (!m) return null;
    let content;
    if (m.type === 'time') {
      content = html`<${TimeSheet} key=${m.day + m.punch} m=${m} />`;
    } else {
      content = html`<div class="modal" role="dialog" aria-modal="true" aria-label=${m.title}>
        <h2>${m.title}</h2>
        ${m.busy && html`<div class="center pad"><span class="spinner big"></span></div>`}
        ${m.text && html`<p class="modal-text">${m.text}</p>`}
        ${m.buttons && m.buttons.length > 0 && html`<div class=${'modal-actions' + (m.stack ? ' stack' : '')}>
          ${m.buttons.map((b, i) => html`<button key=${i} class=${'btn btn-' + (b.kind || 'plain')} onClick=${() => {
            if (!b.keepOpen) closeModal();
            if (b.onClick) b.onClick();
          }}>${b.icon && html`<${Icon} name=${b.icon} size=${20} />`}${b.label}</button>`)}
        </div>`}
      </div>`;
    }
    return html`<div class=${'backdrop' + (m.type === 'time' ? ' bottom' : '')} onClick=${(e) => {
      if (e.target === e.currentTarget && !m.busy) closeModal();
    }}>${content}</div>`;
  }

  function TabBar() {
    const tabs = [
      { id: 'danes', label: 'Danes', icon: 'clock' },
      { id: 'pregled', label: 'Pregled', icon: 'month' },
    ];
    if (isManager()) tabs.push({ id: 'ekipa', label: 'Ekipa', icon: 'team' });
    tabs.push({ id: 'nastavitve', label: 'Nastavitve', icon: 'settings' });
    return html`<nav class="tabbar" aria-label="Zavihki">
      ${tabs.map((t) => html`<button key=${t.id} class=${'tab' + (app.route.tab === t.id ? ' on' : '')} aria-current=${app.route.tab === t.id ? 'page' : undefined}
        onClick=${() => {
          if (app.route.tab === t.id && !app.route.sub) window.scrollTo({ top: 0, behavior: 'smooth' });
          else navigate(t.id);
        }}><${Icon} name=${t.icon} size=${24} /><span>${t.label}</span></button>`)}
    </nav>`;
  }

  function App() {
    const [, setRev] = useState(0);
    const [now, setNow] = useState(new Date());
    useEffect(() => {
      const fn = (r) => setRev(r);
      app.listeners.add(fn);
      // Osveži vsakih 30 sekund (ure, ki tečejo) in ob polnoči preklopi na nov dan.
      const id = setInterval(() => setNow(new Date()), 30000);
      const vis = () => {
        if (document.visibilityState === 'visible') setNow(new Date());
      };
      document.addEventListener('visibilitychange', vis);
      return () => {
        app.listeners.delete(fn);
        clearInterval(id);
        document.removeEventListener('visibilitychange', vis);
      };
    }, []);
    useEffect(() => {
      document.documentElement.classList.toggle('modal-open', !!app.ui.modal);
    });

    if (!app.settings.firstRunDone) {
      return html`<${WelcomeScreen} />${app.ui.modal && html`<${ModalHost} />`}`;
    }
    const r = app.route;
    let screen;
    if (r.sub && r.sub.type === 'day') screen = html`<${DayEditScreen} key=${'d' + r.sub.date} date=${r.sub.date} now=${now} />`;
    else if (r.sub && r.sub.type === 'member') screen = html`<${TeamMemberScreen} key=${'m' + r.sub.id} month=${r.sub.month} id=${r.sub.id} now=${now} />`;
    else if (r.tab === 'pregled') screen = html`<${MonthScreen} now=${now} />`;
    else if (r.tab === 'ekipa' && isManager()) screen = html`<${TeamScreen} now=${now} />`;
    else if (r.tab === 'nastavitve') screen = html`<${SettingsScreen} now=${now} />`;
    else screen = html`<${TodayScreen} now=${now} />`;
    return html`
      ${app.ui.updateReady && html`<div class="update-bar">Na voljo je nova različica aplikacije.
        <button onClick=${() => location.reload()}>Osveži</button></div>`}
      ${screen}
      <${TabBar} />
      ${app.ui.toast && html`<div class="toast" role="status" key=${app.ui.toast}>${app.ui.toast}</div>`}
      <${ModalHost} />`;
  }

  // ---------------------------------------------------------------------------
  // Zagon
  // ---------------------------------------------------------------------------

  let lastUpdateCheck = 0;

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      swReg = reg;
      return navigator.serviceWorker.ready;
    }).then((reg) => {
      swReg = reg;
      checkPush();
    }).catch(() => {
      // Brez service workerja aplikacija deluje, vendar brez obvestil in delovanja brez povezave.
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) {
        app.ui.updateReady = true;
        emit();
      }
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.akcija) handleAction(e.data.akcija);
    });
  }

  function onActive() {
    if (syncConnected()) {
      const stale = Date.now() - app.state.lastSyncOk > 4 * 3600 * 1000;
      if (pendingCount() > 0 || stale) scheduleSync(1);
      refreshPing(false);
    }
    if (swReg) {
      checkPush();
      if (Date.now() - lastUpdateCheck > 3600 * 1000) {
        lastUpdateCheck = Date.now();
        swReg.update().catch(() => {});
      }
    }
  }

  async function start() {
    const root = document.getElementById('app');
    // iOS uporabi slog :active samo, če obstaja poslušalec dotikov.
    document.addEventListener('touchstart', () => {}, { passive: true });
    // Med tipkanjem na telefonu skrij zavihke (sicer jih tipkovnica potisne čez vsebino).
    const typing = (on) => document.documentElement.classList.toggle('typing', on);
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/checkbox|radio/.test(t.type)))) typing(true);
    });
    document.addEventListener('focusout', () => typing(false));
    let browserOk = false;
    try {
      browserOk = sessionStorage.getItem('evidenca-brskalnik') === '1';
    } catch (e) {
      browserOk = false;
    }
    if (isIOS && !isStandalone() && !browserOk) {
      render(html`<${InstallScreen} onContinue=${() => {
        try {
          sessionStorage.setItem('evidenca-brskalnik', '1');
        } catch (e) {
          // ni pomembno
        }
        location.reload();
      }} />`, root);
      return;
    }
    try {
      await loadAll();
    } catch (e) {
      render(html`<div class="fatal"><img src="logo-header.png" alt="Rešeno" />
        <h1>Shramba ni na voljo</h1>
        <p>Aplikacija ne more shraniti podatkov na to napravo (${errorText(e)}). Če uporabljaš zasebno brskanje, ga izklopi in poskusi znova.</p></div>`, root);
      return;
    }
    const hash = (location.hash || '').replace(/^#/, '').split('/')[0];
    if (TABS.indexOf(hash) >= 0) app.route.tab = hash;
    try {
      history.replaceState({ tab: app.route.tab }, '', '#' + app.route.tab);
    } catch (e) {
      // ni pomembno
    }
    root.textContent = '';
    render(html`<${App} />`, root);
    registerServiceWorker();
    app.ui.permission = notificationPermission();

    const params = new URLSearchParams(location.search);
    const akcija = params.get('akcija');
    if (akcija) {
      try {
        history.replaceState({ tab: app.route.tab }, '', location.pathname + '#' + app.route.tab);
      } catch (e) {
        // ni pomembno
      }
      if (app.settings.firstRunDone) handleAction(akcija);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        emit();
        onActive();
      } else if (syncConnected() && pendingCount() > 0) {
        syncNow();
      }
    });
    window.addEventListener('online', () => {
      if (syncConnected() && pendingCount() > 0) scheduleSync(1);
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      app.ui.installEvent = e;
      emit();
    });
    onActive();
  }

  // Za preizkuse in odpravljanje napak.
  window.EvidencaApp = { app, punch, syncNow, getRecord, pendingCount, connect };

  start();
})();

/*
 * Rešeno Evidenca – jedro spletne različice.
 * Izračuni, prazniki, povzetki, CSV, oblika podatkov za Google Preglednico, besedila zaslonov in
 * postavitev PDF poročila. Enako kot v Androidni (Kotlin) in iPhone (Swift) različici.
 * Datoteko uporabljajo stran (app.js), service worker (sw.js) in preizkusi v Node.js.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EvidencaCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Datumi (dan = niz 'YYYY-MM-DD', mesec = število 202610)
  // ---------------------------------------------------------------------------

  function pad(n, w) {
    let s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function isLeap(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function monthLength(y, m) {
    if (m === 2) return isLeap(y) ? 29 : 28;
    if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
    return 31;
  }

  const Day = {
    make(y, m, d) {
      return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
    },

    /** Strogo branje 'YYYY-MM-DD'; neveljaven datum vrne null. */
    parse(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
      if (!m) return null;
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo)) return null;
      return { y, m: mo, d };
    },

    valid(iso) {
      return Day.parse(iso) !== null;
    },

    /** Število dni od 1. 1. 1970 (algoritem H. Hinnanta). */
    epochDay(iso) {
      const p = Day.parse(iso);
      const y = p.m <= 2 ? p.y - 1 : p.y;
      const era = Math.floor(y / 400);
      const yoe = y - era * 400;
      const mp = (p.m + 9) % 12;
      const doy = Math.floor((153 * mp + 2) / 5) + p.d - 1;
      const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
      return era * 146097 + doe - 719468;
    },

    fromEpochDay(n) {
      const z = n + 719468;
      const era = Math.floor(z / 146097);
      const doe = z - era * 146097;
      const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
      const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
      const mp = Math.floor((5 * doy + 2) / 153);
      const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
      const m = mp < 10 ? mp + 3 : mp - 9;
      return Day.make(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
    },

    add(iso, n) {
      return Day.fromEpochDay(Day.epochDay(iso) + n);
    },

    /** 1 = ponedeljek … 7 = nedelja */
    dayOfWeek(iso) {
      const r = (Day.epochDay(iso) + 3) % 7;
      return (r < 0 ? r + 7 : r) + 1;
    },

    year(iso) {
      return Number(iso.slice(0, 4));
    },

    month(iso) {
      return Number(iso.slice(5, 7));
    },

    dom(iso) {
      return Number(iso.slice(8, 10));
    },

    ym(iso) {
      return Day.year(iso) * 100 + Day.month(iso);
    },

    fromDate(date) {
      return Day.make(date.getFullYear(), date.getMonth() + 1, date.getDate());
    },

    today() {
      return Day.fromDate(new Date());
    },
  };

  const YM = {
    valid(code) {
      const n = Number(code);
      return Number.isInteger(n) && n >= 190001 && n <= 299912 && n % 100 >= 1 && n % 100 <= 12;
    },
    year(code) {
      return Math.floor(code / 100);
    },
    month(code) {
      return code % 100;
    },
    length(code) {
      return monthLength(YM.year(code), YM.month(code));
    },
    day(code, d) {
      return Day.make(YM.year(code), YM.month(code), d);
    },
    first(code) {
      return YM.day(code, 1);
    },
    last(code) {
      return YM.day(code, YM.length(code));
    },
    days(code) {
      const out = [];
      for (let d = 1; d <= YM.length(code); d++) out.push(YM.day(code, d));
      return out;
    },
    add(code, n) {
      const total = YM.year(code) * 12 + (YM.month(code) - 1) + n;
      const y = Math.floor(total / 12);
      return y * 100 + (total - y * 12 + 1);
    },
    /** 2026-10 (za imena datotek) */
    text(code) {
      return pad(YM.year(code), 4) + '-' + pad(YM.month(code), 2);
    },
    current() {
      return Day.ym(Day.today());
    },
  };

  /** Trenutni čas v minutah od polnoči. */
  function nowMinutes(date) {
    const d = date || new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function isBlank(s) {
    return String(s == null ? '' : s).trim() === '';
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  const DAY_TYPES = {
    WORK: 'Delo',
    VACATION: 'Dopust',
    SICK: 'Bolniška',
    TIME_OFF: 'Prosto',
    OTHER: 'Drugo',
  };
  const DAY_TYPE_CODES = ['WORK', 'VACATION', 'SICK', 'TIME_OFF', 'OTHER'];

  const DayType = {
    codes: DAY_TYPE_CODES,
    label(code) {
      return DAY_TYPES[code] || DAY_TYPES.WORK;
    },
    fromCode(code) {
      return Object.prototype.hasOwnProperty.call(DAY_TYPES, code) ? code : 'WORK';
    },
    isAbsence(code) {
      return code === 'VACATION' || code === 'SICK' || code === 'TIME_OFF';
    },
  };

  const PUNCHES = ['arrival', 'lunchStart', 'lunchEnd', 'departure'];
  const PUNCH_LABEL = {
    arrival: 'Prihod',
    lunchStart: 'Začetek malice',
    lunchEnd: 'Konec malice',
    departure: 'Odhod',
  };
  const PUNCH_DONE = {
    arrival: 'Prihod zabeležen',
    lunchStart: 'Začetek malice zabeležen',
    lunchEnd: 'Konec malice zabeležen',
    departure: 'Odhod zabeležen',
  };
  /** Imena kot v Androidni različici (za primerjalne preizkuse). */
  const PUNCH_CODE = { arrival: 'ARRIVAL', lunchStart: 'LUNCH_START', lunchEnd: 'LUNCH_END', departure: 'DEPARTURE' };

  const Punch = {
    all: PUNCHES,
    label(p) {
      return PUNCH_LABEL[p];
    },
    doneLabel(p) {
      return PUNCH_DONE[p];
    },
    code(p) {
      return PUNCH_CODE[p];
    },
  };

  function timeOrNull(v) {
    return Number.isInteger(v) && v >= 0 && v < 1440 ? v : null;
  }

  /** Nov zapis dneva (manjkajoča polja dobijo privzete vrednosti). */
  function record(date, fields) {
    const f = fields || {};
    return {
      date,
      arrival: timeOrNull(f.arrival),
      lunchStart: timeOrNull(f.lunchStart),
      lunchEnd: timeOrNull(f.lunchEnd),
      departure: timeOrNull(f.departure),
      location: f.location == null ? '' : String(f.location),
      notes: f.notes == null ? '' : String(f.notes),
      ownVehicle: f.ownVehicle === true,
      km: Number.isInteger(f.km) ? f.km : 0,
      dayType: DayType.fromCode(f.dayType),
    };
  }

  const Rec = {
    hasTimes(r) {
      return r.arrival != null || r.lunchStart != null || r.lunchEnd != null || r.departure != null;
    },
    isEmpty(r) {
      return !Rec.hasTimes(r) && isBlank(r.location) && isBlank(r.notes) && !r.ownVehicle && r.km === 0 &&
        r.dayType === 'WORK';
    },
    isAbsence(r) {
      return DayType.isAbsence(r.dayType);
    },
    lunchTaken(r) {
      return r.lunchStart != null || r.lunchEnd != null;
    },
    /** 'notStarted' | 'working' | 'onLunch' | 'done' */
    state(r) {
      if (r.departure != null) return 'done';
      if (r.arrival == null) return 'notStarted';
      if (r.lunchStart != null && r.lunchEnd == null) return 'onLunch';
      return 'working';
    },
    nextPunches(r) {
      switch (Rec.state(r)) {
        case 'notStarted':
          return ['arrival'];
        case 'working':
          return Rec.lunchTaken(r) ? ['departure'] : ['lunchStart', 'departure'];
        case 'onLunch':
          return ['lunchEnd'];
        default:
          return [];
      }
    },
    suggestedPunches(r) {
      return Rec.isAbsence(r) && !Rec.hasTimes(r) ? [] : Rec.nextPunches(r);
    },
    equals(a, b) {
      return a.date === b.date && a.arrival === b.arrival && a.lunchStart === b.lunchStart &&
        a.lunchEnd === b.lunchEnd && a.departure === b.departure && a.location === b.location &&
        a.notes === b.notes && a.ownVehicle === b.ownVehicle && a.km === b.km && a.dayType === b.dayType;
    },
  };

  // ---------------------------------------------------------------------------
  // Izračun ur (ZDR-1: plačan odmor do 30 min se šteje v delovni čas)
  // ---------------------------------------------------------------------------

  const TimeCalc = {
    DAY: 1440,

    span(from, to) {
      return to >= from ? to - from : to + 1440 - from;
    },

    /**
     * @param s {dailyMinutes, paidBreakMinutes}
     * @param now trenutni čas za tekoči dan; za pretekle dni null (brez odhoda → 0)
     */
    totals(r, s, now) {
      const zero = { presence: 0, lunch: 0, worked: 0, running: false };
      const a = r.arrival;
      if (a == null) return zero;
      const d = r.departure;
      const running = d == null;
      let presence;
      let rel;
      if (d != null) {
        presence = TimeCalc.span(a, d);
        rel = (t) => TimeCalc.span(a, t);
      } else {
        if (now == null) return zero;
        presence = Math.max(now - a, 0);
        rel = (t) => t - a;
      }
      const ls = r.lunchStart;
      const le = r.lunchEnd != null ? r.lunchEnd : (running && ls != null ? a + presence : null);
      let lunch = 0;
      if (ls != null && le != null) {
        const s0 = Math.min(Math.max(rel(ls), 0), presence);
        const e0 = Math.min(Math.max(rel(le), 0), presence);
        lunch = Math.max(e0 - s0, 0);
      }
      const unpaid = Math.max(lunch - Math.max(s.paidBreakMinutes, 0), 0);
      const worked = Math.max(presence - unpaid, 0);
      return { presence, lunch, worked, running };
    },

    problems(r, isPast) {
      const out = [];
      const a = r.arrival;
      const d = r.departure;
      const ls = r.lunchStart;
      const le = r.lunchEnd;
      if (a == null && (d != null || Rec.lunchTaken(r))) out.push('Manjka prihod');
      if (a != null && d == null && isPast) out.push('Manjka odhod');
      if (ls != null && le == null && (isPast || d != null)) out.push('Manjka konec malice');
      if (le != null && ls == null) out.push('Manjka začetek malice');
      if (a != null && d != null && d < a) out.push('Odhod je pred prihodom');
      if (a != null && ls != null && ls < a && (d == null || d >= a)) out.push('Malica je pred prihodom');
      if (ls != null && le != null && le < ls) out.push('Konec malice je pred začetkom');
      if (d != null && le != null && le > d && (a == null || d >= a)) out.push('Malica je po odhodu');
      return out;
    },
  };

  // ---------------------------------------------------------------------------
  // Oblikovanje (slovensko)
  // ---------------------------------------------------------------------------

  const DAYS = ['ponedeljek', 'torek', 'sreda', 'četrtek', 'petek', 'sobota', 'nedelja'];
  const DAYS_SHORT = ['pon', 'tor', 'sre', 'čet', 'pet', 'sob', 'ned'];
  const DAYS_TWO = ['Po', 'To', 'Sr', 'Če', 'Pe', 'So', 'Ne'];
  const MONTHS = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober',
    'november', 'december'];
  const MONTHS_GEN = ['januarja', 'februarja', 'marca', 'aprila', 'maja', 'junija', 'julija', 'avgusta', 'septembra',
    'oktobra', 'novembra', 'decembra'];
  const MINUS = '−';

  const Fmt = {
    MINUS,

    clock(min) {
      if (min == null) return '--:--';
      return pad(Math.floor(min / 60) % 24, 2) + ':' + pad(min % 60, 2);
    },

    /** 7 h 05 min · 45 min · 8 h · −1 h 30 min */
    duration(min) {
      const sign = min < 0 ? MINUS : '';
      const m = Math.abs(min);
      const h = Math.floor(m / 60);
      const r = m % 60;
      if (h === 0) return sign + r + ' min';
      if (r === 0) return sign + h + ' h';
      return sign + h + ' h ' + pad(r, 2) + ' min';
    },

    /** 7:05 · −1:30 */
    hm(min) {
      const sign = min < 0 ? MINUS : '';
      const m = Math.abs(min);
      return sign + Math.floor(m / 60) + ':' + pad(m % 60, 2);
    },

    /** 7,08 */
    hoursDecimal(min) {
      const hundredths = Math.floor(Math.abs(min) * 100 / 60 + 0.5);
      const sign = min < 0 ? '-' : '';
      return sign + Math.floor(hundredths / 100) + ',' + pad(hundredths % 100, 2);
    },

    /** 8 h · 7,5 h */
    hoursSetting(min) {
      return min % 60 === 0 ? (min / 60) + ' h' : Math.floor(min / 60) + ',' + Math.floor((min % 60) * 10 / 60) + ' h';
    },

    dayName(iso) {
      return DAYS[Day.dayOfWeek(iso) - 1];
    },
    dayShort(iso) {
      return DAYS_SHORT[Day.dayOfWeek(iso) - 1];
    },
    dayTwo(dow) {
      return DAYS_TWO[Math.min(Math.max(dow - 1, 0), 6)];
    },
    /** torek, 13. oktobra 2026 */
    dateLong(iso) {
      return Fmt.dayName(iso) + ', ' + Day.dom(iso) + '. ' + MONTHS_GEN[Day.month(iso) - 1] + ' ' + Day.year(iso);
    },
    dateMedium(iso) {
      return Day.dom(iso) + '. ' + MONTHS_GEN[Day.month(iso) - 1] + ' ' + Day.year(iso);
    },
    dateNumeric(iso) {
      return Day.dom(iso) + '. ' + Day.month(iso) + '. ' + Day.year(iso);
    },
    dateShort(iso) {
      return Day.dom(iso) + '. ' + Day.month(iso) + '.';
    },
    monthTitle(code) {
      return Fmt.cap(MONTHS[YM.month(code) - 1]) + ' ' + YM.year(code);
    },
    monthName(code) {
      return MONTHS[YM.month(code) - 1];
    },
    cap(s) {
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    },
    plural(n, one, two, few, many) {
      switch (Math.abs(n) % 100) {
        case 1:
          return one;
        case 2:
          return two;
        case 3:
        case 4:
          return few;
        default:
          return many;
      }
    },
    days(n) {
      return n + ' ' + Fmt.plural(n, 'dan', 'dneva', 'dnevi', 'dni');
    },
    /** danes ob 15:32 · včeraj ob 09:05 · 13. 10. ob 15:32 */
    moment(dayIso, minute, today) {
      let label;
      if (dayIso === today) label = 'danes';
      else if (dayIso === Day.add(today, -1)) label = 'včeraj';
      else label = Fmt.dateShort(dayIso) + (Day.year(dayIso) !== Day.year(today) ? ' ' + Day.year(dayIso) : '');
      return label + ' ob ' + Fmt.clock(minute);
    },
    /** Trenutek (ms od 1970) po času naprave. */
    momentMs(ms, today) {
      const d = new Date(ms);
      return Fmt.moment(Day.fromDate(d), nowMinutes(d), today);
    },
    /** Varno ime datoteke (brez šumnikov in posebnih znakov). */
    fileSafe(s) {
      const map = { č: 'c', š: 's', ž: 'z', ć: 'c', đ: 'd', Č: 'C', Š: 'S', Ž: 'Z', Ć: 'C', Đ: 'D' };
      let out = '';
      for (const ch of String(s).trim()) {
        const c = map[ch] || ch;
        if (/^[A-Za-z0-9]$/.test(c)) out += c;
        else if (c === ' ' || c === '-' || c === '_') out += '_';
      }
      return out.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    },
  };

  // ---------------------------------------------------------------------------
  // Dela prosti dnevi v RS (ZPDPD)
  // ---------------------------------------------------------------------------

  const holidayCache = {};

  const Holidays = {
    easterSunday(year) {
      const a = year % 19;
      const b = Math.floor(year / 100);
      const c = year % 100;
      const d = Math.floor(b / 4);
      const e = b % 4;
      const f = Math.floor((b + 8) / 25);
      const g = Math.floor((b - f + 1) / 3);
      const h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4);
      const k = c % 4;
      const l = (32 + 2 * e + 2 * i - h - k) % 7;
      const m = Math.floor((a + 11 * h + 22 * l) / 451);
      const month = Math.floor((h + l - 7 * m + 114) / 31);
      const day = (h + l - 7 * m + 114) % 31 + 1;
      return Day.make(year, month, day);
    },

    forYear(year) {
      if (holidayCache[year]) return holidayCache[year];
      const easter = Holidays.easterSunday(year);
      const list = [
        [Day.make(year, 1, 1), 'Novo leto'],
        [Day.make(year, 1, 2), 'Novo leto'],
        [Day.make(year, 2, 8), 'Prešernov dan'],
        [easter, 'Velika noč'],
        [Day.add(easter, 1), 'Velikonočni ponedeljek'],
        [Day.make(year, 4, 27), 'Dan upora proti okupatorju'],
        [Day.make(year, 5, 1), 'Praznik dela'],
        [Day.make(year, 5, 2), 'Praznik dela'],
        [Day.add(easter, 49), 'Binkošti'],
        [Day.make(year, 6, 25), 'Dan državnosti'],
        [Day.make(year, 8, 15), 'Marijino vnebovzetje'],
        [Day.make(year, 10, 31), 'Dan reformacije'],
        [Day.make(year, 11, 1), 'Dan spomina na mrtve'],
        [Day.make(year, 12, 25), 'Božič'],
        [Day.make(year, 12, 26), 'Dan samostojnosti in enotnosti'],
      ];
      const map = {};
      for (const [date, name] of list) map[date] = map[date] ? map[date] + ', ' + name : name;
      holidayCache[year] = map;
      return map;
    },

    name(iso) {
      return Holidays.forYear(Day.year(iso))[iso] || null;
    },
    isHoliday(iso) {
      return Holidays.name(iso) != null;
    },
    isWeekend(iso) {
      return Day.dayOfWeek(iso) >= 6;
    },
    isWorkday(iso) {
      return !Holidays.isWeekend(iso) && !Holidays.isHoliday(iso);
    },
  };

  // ---------------------------------------------------------------------------
  // Mesečni povzetek in teden
  // ---------------------------------------------------------------------------

  function getRec(records, iso) {
    if (!records) return undefined;
    if (typeof records.get === 'function') return records.get(iso);
    return records[iso];
  }

  const Stats = {
    countsToDate(d, r, today) {
      if (d < today) return true;
      if (d === today) return !!r && (Rec.state(r) === 'done' || (Rec.isAbsence(r) && !Rec.hasTimes(r)));
      return false;
    },

    summarize(month, records, s, today, now) {
      let worked = 0;
      let workdays = 0;
      let expectedToDate = 0;
      let covered = 0;
      let balanceWorked = 0;
      let daysWorked = 0;
      let vacation = 0;
      let sick = 0;
      let timeOff = 0;
      let other = 0;
      let vehicleDays = 0;
      let km = 0;
      let offDay = 0;
      let incomplete = 0;
      for (const d of YM.days(month)) {
        const r = getRec(records, d);
        const workday = Holidays.isWorkday(d);
        const toDate = Stats.countsToDate(d, r, today);
        if (workday) {
          workdays++;
          if (toDate) expectedToDate += s.dailyMinutes;
        }
        if (!r) continue;
        const t = TimeCalc.totals(r, s, d === today ? now : null);
        worked += t.worked;
        if (toDate) balanceWorked += t.worked;
        if (t.worked > 0) daysWorked++;
        if (!workday) offDay += t.worked;
        switch (r.dayType) {
          case 'VACATION':
            vacation++;
            if (workday && toDate) covered += s.dailyMinutes;
            break;
          case 'SICK':
            sick++;
            if (workday && toDate) covered += s.dailyMinutes;
            break;
          case 'TIME_OFF':
            timeOff++;
            break;
          case 'OTHER':
            other++;
            break;
          default:
            break;
        }
        if (r.ownVehicle) {
          vehicleDays++;
          km += r.km;
        }
        if (TimeCalc.problems(r, d < today).length > 0) incomplete++;
      }
      return {
        month,
        workedMinutes: worked,
        workdays,
        expectedMonthMinutes: workdays * s.dailyMinutes,
        expectedToDateMinutes: expectedToDate,
        coveredMinutes: covered,
        balanceMinutes: balanceWorked + covered - expectedToDate,
        daysWorked,
        vacationDays: vacation,
        sickDays: sick,
        timeOffDays: timeOff,
        otherDays: other,
        ownVehicleDays: vehicleDays,
        km,
        offDayMinutes: offDay,
        incompleteDays: incomplete,
      };
    },

    weekStart(iso) {
      return Day.add(iso, -(Day.dayOfWeek(iso) - 1));
    },

    weekMinutes(monday, records, s, today, now) {
      const out = [];
      for (let i = 0; i < 7; i++) {
        const d = Day.add(monday, i);
        const r = getRec(records, d);
        out.push(r ? TimeCalc.totals(r, s, d === today ? now : null).worked : 0);
      }
      return out;
    },

    weekExpected(monday, s) {
      let n = 0;
      for (let i = 0; i < 7; i++) if (Holidays.isWorkday(Day.add(monday, i))) n++;
      return n * s.dailyMinutes;
    },
  };

  // ---------------------------------------------------------------------------
  // CSV za Excel (podpičje, decimalna vejica, UTF-8 z BOM)
  // ---------------------------------------------------------------------------

  const CSV_HEADER = ['Datum', 'Dan', 'Vrsta dneva', 'Dela prost dan', 'Prihod', 'Začetek malice', 'Konec malice', 'Odhod',
    'Malica (min)', 'Delovni čas (h:mm)', 'Delovni čas (ure)', 'Opis dneva / lokacija', 'Lastno vozilo',
    'Prevoženi km', 'Opombe', 'Opozorila'];

  const Csv = {
    HEADER: CSV_HEADER,

    escape(v) {
      const needs = v.includes(';') || v.includes('"') || v.includes('\n') || v.includes('\r');
      const clean = v.split('\r\n').join('\n');
      return needs ? '"' + clean.split('"').join('""') + '"' : clean;
    },

    row(cells) {
      return cells.map(Csv.escape).join(';') + '\r\n';
    },

    build(days, s, today) {
      let out = '﻿' + Csv.row(CSV_HEADER);
      for (const [d, r] of days) {
        const holiday = Holidays.name(d) || '';
        if (!r) {
          out += Csv.row([Fmt.dateNumeric(d), Fmt.dayName(d), '', holiday, '', '', '', '', '', '', '', '', '', '', '', '']);
          continue;
        }
        const t = TimeCalc.totals(r, s, null);
        const problems = TimeCalc.problems(r, d < today);
        const hasWork = r.arrival != null && r.departure != null;
        out += Csv.row([
          Fmt.dateNumeric(d),
          Fmt.dayName(d),
          DayType.label(r.dayType),
          holiday,
          r.arrival != null ? Fmt.clock(r.arrival) : '',
          r.lunchStart != null ? Fmt.clock(r.lunchStart) : '',
          r.lunchEnd != null ? Fmt.clock(r.lunchEnd) : '',
          r.departure != null ? Fmt.clock(r.departure) : '',
          hasWork && r.lunchStart != null && r.lunchEnd != null ? String(t.lunch) : '',
          hasWork ? Fmt.hm(t.worked) : '',
          hasWork ? Fmt.hoursDecimal(t.worked) : '',
          r.location,
          r.ownVehicle ? 'da' : '',
          r.ownVehicle && r.km > 0 ? String(r.km) : '',
          r.notes,
          problems.join(', '),
        ]);
      }
      return out;
    },

    month(month, records, s, today) {
      return Csv.build(YM.days(month).map((d) => [d, getRec(records, d) || null]), s, today);
    },

    all(records, s, today) {
      const list = records.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return Csv.build(list.map((r) => [r.date, r]), s, today);
    },
  };

  // ---------------------------------------------------------------------------
  // Opomniki
  // ---------------------------------------------------------------------------

  const Schedule = {
    /** Dnevi naslednjih opomnikov strogo po trenutku (afterDay, afterMinute). */
    upcoming(afterDay, afterMinute, minuteOfDay, days, skipHolidays, count) {
      const set = days instanceof Set ? days : new Set(days || []);
      if (set.size === 0 || count <= 0) return [];
      const m = Math.min(Math.max(minuteOfDay, 0), 1439);
      const out = [];
      let d = afterDay;
      for (let i = 0; i < 400; i++) {
        const isAfter = d > afterDay || m > afterMinute;
        if (isAfter && set.has(Day.dayOfWeek(d)) && !(skipHolidays && Holidays.isHoliday(d))) {
          out.push(d);
          if (out.length === count) break;
        }
        d = Day.add(d, 1);
      }
      return out;
    },
  };

  /** Besedilo obvestila v service workerju (odloči se po stanju na telefonu). */
  const ReminderText = {
    /**
     * @param r današnji zapis (ali null)
     * @param settings nastavitve (morningEnabled, departureEnabled, departureMinutes, dailyMinutes, paidBreakMinutes)
     * @param now trenutni čas v minutah
     * @param test ali gre za preizkusno obvestilo
     */
    make(r, settings, now, test) {
      if (test) {
        return {
          title: 'Dobro jutro! ☀️',
          body: 'Preizkus uspel: obvestila delujejo. Tako bo videti jutranji opomnik.',
          tag: 'preizkus',
        };
      }
      const rec = r || null;
      const departureTime = settings.departureEnabled && now >= settings.departureMinutes;
      if (!departureTime) {
        if (rec && rec.arrival != null) {
          return { title: 'Rešeno Evidenca', body: '✓ Prihod je zabeležen ob ' + Fmt.clock(rec.arrival) + '.', tag: 'jutro' };
        }
        if (rec && Rec.isAbsence(rec)) {
          return { title: 'Rešeno Evidenca', body: 'Danes: ' + DayType.label(rec.dayType) + '.', tag: 'jutro' };
        }
        return { title: 'Dobro jutro! ☀️', body: 'Ne pozabi zabeležiti prihoda na delo.', tag: 'jutro' };
      }
      if (rec && rec.departure != null) {
        return {
          title: 'Rešeno Evidenca',
          body: '✓ Odhod je zabeležen ob ' + Fmt.clock(rec.departure) + '. Lep večer!',
          tag: 'odhod',
        };
      }
      if (rec && rec.arrival != null) {
        const t = TimeCalc.totals(rec, settings, now);
        return {
          title: 'Konec delovnega dne?',
          body: 'Na delu od ' + Fmt.clock(rec.arrival) + ' (' + Fmt.duration(t.worked) + '). Ne pozabi zabeležiti odhoda.',
          tag: 'odhod',
        };
      }
      return { title: 'Rešeno Evidenca', body: 'Ne pozabi zabeležiti delovnega časa za danes.', tag: 'odhod' };
    },
  };

  // ---------------------------------------------------------------------------
  // Podatki za Google Preglednico (enaka oblika kot Android in iPhone)
  // ---------------------------------------------------------------------------

  class SyncError extends Error {
    constructor(message, transient) {
      super(message);
      this.name = 'SyncError';
      this.transient = !!transient;
    }
  }

  function jStr(o, k) {
    const v = o == null ? null : o[k];
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return '';
    return String(v);
  }

  function jInt(o, k) {
    const v = o == null ? null : o[k];
    return typeof v === 'number' && isFinite(v) ? Math.trunc(v) : null;
  }

  function jBool(o, k) {
    const v = o == null ? null : o[k];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Math.trunc(v) !== 0;
    if (typeof v === 'string') return v === 'true' || v === 'da';
    return false;
  }

  function jObj(o, k) {
    const v = o == null ? null : o[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  function jObjects(o, k) {
    const v = o == null ? null : o[k];
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [];
  }

  const MAX_TEXT = 2000;

  function take(s, n) {
    // Kot String.take v Kotlinu (enote UTF-16).
    return s.length > n ? s.substring(0, n) : s;
  }

  const SyncPayload = {
    VERSION: 1,

    recordJson(r, s, today) {
      const complete = r.arrival != null && r.departure != null;
      const t = TimeCalc.totals(r, s, null);
      return {
        date: r.date,
        arrival: r.arrival,
        lunchStart: r.lunchStart,
        lunchEnd: r.lunchEnd,
        departure: r.departure,
        location: take(r.location, MAX_TEXT),
        notes: take(r.notes, MAX_TEXT),
        ownVehicle: r.ownVehicle,
        km: r.km,
        dayType: r.dayType,
        dayTypeLabel: DayType.label(r.dayType),
        worked: complete ? t.worked : 0,
        lunch: complete && r.lunchStart != null && r.lunchEnd != null ? t.lunch : 0,
        holiday: Holidays.name(r.date) || '',
        problems: TimeCalc.problems(r, r.date < today).join(', '),
      };
    },

    summaryJson(m) {
      return {
        month: m.month,
        worked: m.workedMinutes,
        expected: m.expectedMonthMinutes,
        expectedToDate: m.expectedToDateMinutes,
        covered: m.coveredMinutes,
        balance: m.balanceMinutes,
        workdays: m.workdays,
        daysWorked: m.daysWorked,
        vacation: m.vacationDays,
        sick: m.sickDays,
        timeOff: m.timeOffDays,
        other: m.otherDays,
        vehicleDays: m.ownVehicleDays,
        km: m.km,
        offDay: m.offDayMinutes,
        incomplete: m.incompleteDays,
      };
    },

    employeeJson(e) {
      return {
        id: e.id,
        name: e.name,
        app: e.app,
        device: e.device,
        dailyMinutes: e.dailyMinutes,
        paidBreakMinutes: e.paidBreakMinutes,
      };
    },

    push(employee, records, deleted, summaries, s, today) {
      return JSON.stringify({
        v: SyncPayload.VERSION,
        employee: SyncPayload.employeeJson(employee),
        records: records.map((r) => SyncPayload.recordJson(r, s, today)),
        deleted: deleted.slice(),
        summaries: summaries.map(SyncPayload.summaryJson),
      });
    },

    checkOk(text) {
      let m;
      try {
        m = JSON.parse(text);
      } catch (e) {
        m = null;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        throw new SyncError('Strežnik ni vrnil pravilnega odgovora. Preveri povezavo in ali je spletna aplikacija ' +
          'objavljena z dostopom »Kdor koli« (Anyone).', true);
      }
      if (m.ok !== true) {
        const err = jStr(m, 'error');
        throw new SyncError(isBlank(err) ? 'Neznana napaka strežnika.' : err, m.retry === true);
      }
      return m;
    },

    parsePing(text) {
      const m = SyncPayload.checkOk(text);
      return {
        role: jStr(m, 'role'),
        spreadsheetUrl: jStr(m, 'spreadsheetUrl'),
        name: jStr(m, 'name'),
        vapidPublicKey: jStr(m, 'vapidPublicKey'),
        push: jBool(m, 'push'),
        isManager: jStr(m, 'role') === 'manager',
      };
    },

    parsePush(text) {
      const m = SyncPayload.checkOk(text);
      return { saved: jInt(m, 'saved') || 0, deleted: jInt(m, 'deleted') || 0 };
    },

    parseRecord(m) {
      const date = jStr(m, 'date');
      if (!Day.valid(date)) return null;
      const time = (k) => {
        const t = jInt(m, k);
        return t != null && t >= 0 && t < 1440 ? t : null;
      };
      return {
        date,
        arrival: time('arrival'),
        lunchStart: time('lunchStart'),
        lunchEnd: time('lunchEnd'),
        departure: time('departure'),
        location: jStr(m, 'location'),
        notes: jStr(m, 'notes'),
        ownVehicle: jBool(m, 'ownVehicle'),
        km: jInt(m, 'km') || 0,
        dayType: DayType.fromCode(jStr(m, 'dayType')),
      };
    },

    parseSummary(m) {
      const n = (k) => jInt(m, k) || 0;
      return {
        month: n('month'),
        worked: n('worked'),
        expected: n('expected'),
        expectedToDate: n('expectedToDate'),
        balance: n('balance'),
        workdays: n('workdays'),
        daysWorked: n('daysWorked'),
        vacation: n('vacation'),
        sick: n('sick'),
        timeOff: n('timeOff'),
        other: n('other'),
        vehicleDays: n('vehicleDays'),
        km: n('km'),
        offDay: n('offDay'),
        incomplete: n('incomplete'),
      };
    },

    parseTeam(text) {
      const m = SyncPayload.checkOk(text);
      const code = jInt(m, 'month');
      const month = YM.valid(code) ? code : YM.current();
      const todayIso = jStr(m, 'today');
      const members = jObjects(m, 'employees').map((e) => {
        const daily = jInt(e, 'dailyMinutes');
        const paid = jInt(e, 'paidBreakMinutes');
        const name = jStr(e, 'name');
        const summary = jObj(e, 'summary');
        const today = jObj(e, 'today');
        return {
          id: jStr(e, 'id'),
          name: isBlank(name) ? 'Brez imena' : name,
          lastSync: jInt(e, 'lastSync'),
          app: jStr(e, 'app'),
          settings: {
            dailyMinutes: daily != null && daily > 0 ? daily : 480,
            paidBreakMinutes: paid != null && paid >= 0 ? paid : 30,
          },
          summary: summary ? SyncPayload.parseSummary(summary) : null,
          days: jObjects(e, 'days').map(SyncPayload.parseRecord).filter((r) => r)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
          today: today ? SyncPayload.parseRecord(today) : null,
        };
      });
      return {
        month,
        today: Day.valid(todayIso) ? todayIso : null,
        members,
        spreadsheetUrl: jStr(m, 'spreadsheetUrl'),
        generatedAt: jInt(m, 'generated'),
      };
    },

    /** Hitro preverjanje oblike povezave; vrne opis napake ali null. */
    validateLink(link) {
      const l = String(link || '').trim();
      if (!l) return 'Prilepi povezavo, ki si jo dobil od vodje.';
      if (!l.startsWith('https://')) return 'Povezava se mora začeti s https://';
      if (/\s/.test(l)) return 'Povezava ne sme vsebovati presledkov.';
      if (!/[?&]k=[^&]+/.test(l)) return 'V povezavi manjka koda (…?k=…). Kopiraj celotno povezavo.';
      return null;
    },
  };

  // ---------------------------------------------------------------------------
  // Besedila zaslonov (enako kot Android in iPhone)
  // ---------------------------------------------------------------------------

  const TodayStatus = {
    make(r, s, now) {
      const t = TimeCalc.totals(r, s, now);
      const holiday = Holidays.name(r.date);
      const absent = Rec.isAbsence(r) && !Rec.hasTimes(r);
      const date = Fmt.cap(Fmt.dateLong(r.date));
      let status;
      let dot;
      if (absent) {
        status = 'Danes: ' + DayType.label(r.dayType);
        dot = 'absent';
      } else {
        switch (Rec.state(r)) {
          case 'notStarted':
            if (holiday) status = 'Dela prost dan: ' + holiday;
            else if (Holidays.isWeekend(r.date)) status = 'Vikend';
            else status = 'Prihod še ni zabeležen';
            dot = 'off';
            break;
          case 'working':
            status = 'Na delu od ' + Fmt.clock(r.arrival);
            dot = 'working';
            break;
          case 'onLunch': {
            const start = r.lunchStart != null ? r.lunchStart : now;
            status = 'Na malici od ' + Fmt.clock(start) + ' (' + Fmt.duration(Math.max(now - start, 0)) + ')';
            dot = 'lunch';
            break;
          }
          default:
            status = 'Odhod ob ' + Fmt.clock(r.departure);
            dot = 'done';
        }
      }
      if (absent) {
        let sub;
        if (r.dayType === 'VACATION') sub = 'Uživaj v prostem dnevu!';
        else if (r.dayType === 'SICK') sub = 'Hitro okrevanje!';
        else sub = 'Danes ni beleženja delovnega časa.';
        return { date, status, dot, worked: DayType.label(r.dayType), sub, showProgress: false, progress: 0, target: '' };
      }
      const state = Rec.state(r);
      let sub;
      if (state === 'notStarted') sub = 'Tapni »Prihod«, ko začneš z delom.';
      else if (state === 'done') sub = 'Delovni dan je zaključen. Lep večer!';
      else sub = 'opravljenega dela danes';
      const target = s.dailyMinutes;
      const permille = target > 0 ? Math.min(Math.max(Math.trunc(t.worked * 1000 / target), 0), 1000) : 0;
      let targetText;
      if (target <= 0) {
        targetText = '';
      } else if (t.worked >= target) {
        const over = t.worked - target;
        targetText = 'Dnevni fond ' + Fmt.hoursSetting(target) + ' dosežen' + (over > 0 ? ' · +' + Fmt.duration(over) : '');
      } else if (state === 'working' || state === 'onLunch') {
        const end = now + (target - t.worked);
        const endText = end < 1440 ? ' · predviden konec ob ' + Fmt.clock(end) : '';
        targetText = Math.trunc(t.worked * 100 / target) + ' % od ' + Fmt.hoursSetting(target) + endText;
      } else {
        targetText = Math.trunc(t.worked * 100 / target) + ' % od ' + Fmt.hoursSetting(target);
      }
      return { date, status, dot, worked: Fmt.duration(t.worked), sub, showProgress: true, progress: permille / 1000, target: targetText };
    },

    /** @param lastSyncOk ms od 1970 (0 = nikoli) */
    saveNote(connected, pending, lastSyncOk, lastSyncError, today) {
      if (!connected) return 'Vsi vnosi se shranijo samodejno.';
      if (pending === 0 && lastSyncOk > 0) return 'Shranjeno · vodji poslano ' + Fmt.momentMs(lastSyncOk, today);
      if (!isBlank(lastSyncError)) return 'Shranjeno na telefonu · pošiljanje vodji še ni uspelo (glej Nastavitve)';
      return 'Shranjeno · pošiljanje vodji …';
    },

    confirmDeparture(worked, s) {
      return worked < Math.trunc(s.dailyMinutes / 2);
    },

    departureQuestion(worked, now) {
      return 'Danes si na delu šele ' + Fmt.duration(worked) + '. Ali res želiš zabeležiti odhod ob ' + Fmt.clock(now) + '?';
    },
  };

  const DayRowText = {
    make(d, r, today, now, s) {
      const holiday = Holidays.name(d);
      const weekend = Holidays.isWeekend(d);
      const isToday = d === today;
      const isPast = d < today;
      const totals = r ? TimeCalc.totals(r, s, isToday ? now : null) : null;
      let tone = 'normal';
      let main;
      if (r && Rec.hasTimes(r)) {
        let end;
        if (r.departure != null) end = Fmt.clock(r.departure);
        else if (isToday) end = 'zdaj';
        else end = '--:--';
        const start = r.arrival != null ? Fmt.clock(r.arrival) : '--:--';
        const lunch = totals ? totals.lunch : 0;
        main = start + ' – ' + end + (lunch > 0 ? ' · malica ' + lunch + ' min' : '');
      } else if (r && Rec.isAbsence(r)) {
        main = DayType.label(r.dayType);
      } else if (holiday) {
        tone = 'muted';
        main = holiday;
      } else if (weekend) {
        tone = 'muted';
        main = 'Vikend';
      } else if (isPast) {
        tone = 'warning';
        main = 'Ni vnosa';
      } else if (isToday) {
        tone = 'muted';
        main = 'Danes še ni vnosa';
      } else {
        tone = 'muted';
        main = '—';
      }
      const descParts = [];
      if (r && (Rec.hasTimes(r) || Rec.isAbsence(r)) && holiday) descParts.push(holiday);
      if (r && Rec.hasTimes(r) && r.dayType !== 'WORK') descParts.push(DayType.label(r.dayType));
      if (r && !isBlank(r.location)) descParts.push(r.location);
      const problems = r ? TimeCalc.problems(r, isPast) : [];
      const flags = [];
      if (r && r.ownVehicle) flags.push('🚗 ' + (r.km > 0 ? r.km + ' km' : 'lastno vozilo'));
      if (r && !isBlank(r.notes)) flags.push('📝 opomba');
      for (const p of problems) flags.push('⚠️ ' + p);
      const total = totals && totals.worked > 0 ? Fmt.hm(totals.worked) : '';
      const background = isToday ? 'today' : (weekend || holiday ? 'muted' : 'normal');
      return {
        main,
        mainTone: tone,
        desc: descParts.join(' · '),
        flags: flags.join('   '),
        flagsWarn: problems.length > 0,
        total,
        background,
        accessibility: Fmt.dateLong(d) + ': ' + main,
      };
    },

    details(r, s, today, now) {
      const t = TimeCalc.totals(r, s, r.date === today ? now : null);
      const lines = [];
      if (r.dayType !== 'WORK') lines.push('Vrsta dneva: ' + DayType.label(r.dayType));
      const h = Holidays.name(r.date);
      if (h) lines.push('Dela prost dan: ' + h);
      if (Rec.hasTimes(r)) {
        lines.push('Prihod: ' + Fmt.clock(r.arrival));
        if (Rec.lunchTaken(r)) lines.push('Malica: ' + Fmt.clock(r.lunchStart) + ' – ' + Fmt.clock(r.lunchEnd));
        lines.push('Odhod: ' + Fmt.clock(r.departure));
        lines.push('Delovni čas: ' + Fmt.duration(t.worked) + (t.running ? ' (še na delu)' : ''));
      }
      if (!isBlank(r.location)) lines.push('\nOpis dneva / lokacija:\n' + r.location);
      if (r.ownVehicle) lines.push('\nLastno vozilo' + (r.km > 0 ? ': ' + r.km + ' km' : ''));
      if (!isBlank(r.notes)) lines.push('\nOpombe:\n' + r.notes);
      const problems = TimeCalc.problems(r, r.date < today);
      if (problems.length) lines.push('\n⚠️ ' + problems.join(', '));
      return lines.join('\n');
    },
  };

  const DayHeader = {
    make(d, r, today, now, s) {
      const title = Fmt.cap(Fmt.dayName(d)) + (d === today ? ' (danes)' : '');
      const t = TimeCalc.totals(r, s, d === today ? now : null);
      const sub = Fmt.dateMedium(d) + (t.worked > 0 ? ' · ' + Fmt.duration(t.worked) : '');
      let info = null;
      const h = Holidays.name(d);
      if (h) info = 'Dela prost dan: ' + h;
      else if (Holidays.isWeekend(d)) info = 'Vikend – vnesi samo, če si delal.';
      else if (d > today) info = 'Prihodnji dan – vnaprej lahko označiš npr. dopust.';
      return { title, sub, info };
    },

    suggestTime(p, r, today, now, dailyMinutes) {
      if (r.date === today) return now;
      const a = r.arrival != null ? r.arrival : 420;
      let m;
      switch (p) {
        case 'arrival':
          m = 420;
          break;
        case 'lunchStart':
          m = a + 240;
          break;
        case 'lunchEnd':
          m = (r.lunchStart != null ? r.lunchStart : a + 240) + 30;
          break;
        default:
          m = a + dailyMinutes;
      }
      return Math.min(Math.max(m, 0), 1439);
    },

    mergeLocation(current, address) {
      const c = String(current || '').trim();
      if (!c) return address;
      if (c.includes(address)) return c;
      return c + ', ' + address;
    },
  };

  function absences(vacation, sick, timeOff, other) {
    if (vacation + sick + timeOff + other <= 0) return null;
    const parts = [];
    if (vacation > 0) parts.push('dopust ' + vacation);
    if (sick > 0) parts.push('bolniška ' + sick);
    if (timeOff > 0) parts.push('prosto ' + timeOff);
    if (other > 0) parts.push('drugo ' + other);
    return parts.join(' · ');
  }

  const SummaryTexts = {
    signed(min) {
      return min > 0 ? '+' + Fmt.duration(min) : Fmt.duration(min);
    },

    monthHero(sum, month, today) {
      const thisMonth = Day.ym(today);
      if (month === thisMonth) {
        return { expectedLabel: 'Fond ur do danes', expected: Fmt.duration(sum.expectedToDateMinutes), balance: SummaryTexts.signed(sum.balanceMinutes) };
      }
      if (month < thisMonth) {
        return { expectedLabel: 'Fond ur', expected: Fmt.duration(sum.expectedMonthMinutes), balance: SummaryTexts.signed(sum.balanceMinutes) };
      }
      return { expectedLabel: 'Fond ur', expected: Fmt.duration(sum.expectedMonthMinutes), balance: '—' };
    },

    monthExtras(sum) {
      const out = [{ icon: 'month', label: 'Fond ur v mesecu', value: Fmt.duration(sum.expectedMonthMinutes) + ' · ' + Fmt.days(sum.workdays) }];
      const a = absences(sum.vacationDays, sum.sickDays, sum.timeOffDays, sum.otherDays);
      if (a) out.push({ icon: 'sun', label: 'Odsotnosti (dni)', value: a });
      if (sum.ownVehicleDays > 0) out.push({ icon: 'car', label: 'Lastno vozilo', value: Fmt.days(sum.ownVehicleDays) + ' · ' + sum.km + ' km' });
      if (sum.offDayMinutes > 0) out.push({ icon: 'clock', label: 'Delo ob vikendih in praznikih', value: Fmt.duration(sum.offDayMinutes) });
      if (sum.incompleteDays > 0) out.push({ icon: 'warning', label: 'Nepopolni vnosi', value: Fmt.days(sum.incompleteDays), warn: true });
      return out;
    },

    memberExtras(sum, month, today, settings) {
      const out = [{ icon: 'month', label: 'Fond ur v mesecu', value: Fmt.hoursSetting(sum.expected) + ' · ' + Fmt.days(sum.workdays) }];
      if (month === Day.ym(today)) out.push({ icon: 'clock', label: 'Fond ur do danes', value: Fmt.duration(sum.expectedToDate) });
      const a = absences(sum.vacation, sum.sick, sum.timeOff, sum.other);
      if (a) out.push({ icon: 'sun', label: 'Odsotnosti (dni)', value: a });
      if (sum.vehicleDays > 0) out.push({ icon: 'car', label: 'Lastno vozilo', value: Fmt.days(sum.vehicleDays) + ' · ' + sum.km + ' km' });
      if (sum.offDay > 0) out.push({ icon: 'clock', label: 'Delo ob vikendih in praznikih', value: Fmt.duration(sum.offDay) });
      if (sum.incomplete > 0) out.push({ icon: 'warning', label: 'Nepopolni vnosi', value: Fmt.days(sum.incomplete), warn: true });
      out.push({ icon: 'settings', label: 'Nastavitve zaposlenega', value: Fmt.hoursSetting(settings.dailyMinutes) + ' na dan · odmor ' + settings.paidBreakMinutes + ' min' });
      return out;
    },

    memberBalance(sum, month, today) {
      return month > Day.ym(today) ? '—' : SummaryTexts.signed(sum.balance);
    },

    reportMail(month, employee) {
      const who = String(employee || '').trim();
      return {
        subject: 'Evidenca delovnega časa – ' + Fmt.monthTitle(month) + (who ? ' – ' + who : ''),
        body: 'V prilogi je evidenca delovnega časa za ' + Fmt.monthName(month) + ' ' + YM.year(month) + (who ? ' (' + who + ').' : '.'),
      };
    },

    allDataMail: {
      subject: 'Evidenca delovnega časa – vsi podatki',
      body: 'V prilogi so vsi vnosi iz aplikacije Rešeno Evidenca.',
    },
  };

  const TeamTexts = {
    synced(ms, today) {
      return Fmt.momentMs(ms, today);
    },

    todayRow(m, today, now, workday) {
      const r = m.today;
      const t = r ? TimeCalc.totals(r, m.settings, now) : null;
      let status;
      let dot;
      let hours = '';
      if (r && (Rec.hasTimes(r) || Rec.isAbsence(r))) {
        if (Rec.isAbsence(r) && !Rec.hasTimes(r)) {
          status = DayType.label(r.dayType);
          dot = 'absent';
        } else {
          switch (Rec.state(r)) {
            case 'working':
              status = 'Na delu od ' + Fmt.clock(r.arrival);
              dot = 'working';
              hours = Fmt.hm(t ? t.worked : 0);
              break;
            case 'onLunch':
              status = 'Na malici od ' + Fmt.clock(r.lunchStart);
              dot = 'lunch';
              hours = Fmt.hm(t ? t.worked : 0);
              break;
            case 'done':
              status = 'Odhod ob ' + Fmt.clock(r.departure);
              dot = 'done';
              hours = Fmt.hm(t ? t.worked : 0);
              break;
            default:
              status = 'Prihod še ni zabeležen';
              dot = 'off';
          }
        }
      } else {
        status = workday ? 'Prihod še ni zabeležen' : 'Prost dan';
        dot = 'off';
      }
      const place = [];
      if (r && !isBlank(r.location)) place.push(r.location);
      if (r && r.ownVehicle) place.push('lastno vozilo');
      if (m.lastSync != null) place.push('poslano ' + TeamTexts.synced(m.lastSync, today));
      return { status, dot, hours, place: place.join(' · ') };
    },

    memberRow(m, month, today) {
      const sync = m.lastSync != null ? 'Poslano ' + TeamTexts.synced(m.lastSync, today) : 'Še ni poslal podatkov';
      const sum = m.summary;
      if (!sum) return { hours: 'Za ta mesec ni podatkov', hoursMuted: true, details: '', balance: '—', balanceTone: 'muted', sync };
      const parts = [];
      if (sum.vacation > 0) parts.push('dopust ' + sum.vacation);
      if (sum.sick > 0) parts.push('bolniška ' + sum.sick);
      if (sum.timeOff > 0) parts.push('prosto ' + sum.timeOff);
      if (sum.vehicleDays > 0) parts.push(sum.km + ' km');
      if (sum.incomplete > 0) parts.push('⚠️ nepopolni: ' + sum.incomplete);
      const future = month > Day.ym(today);
      return {
        hours: Fmt.duration(sum.worked) + ' od ' + Fmt.hoursSetting(sum.expected) + ' · ' + Fmt.days(sum.daysWorked) + ' dela',
        hoursMuted: false,
        details: parts.join(' · '),
        balance: future ? '—' : SummaryTexts.signed(sum.balance),
        balanceTone: sum.balance < 0 ? 'warning' : 'normal',
        sync,
      };
    },

    summary(m, month, today, now) {
      if (m.summary) return m.summary;
      const records = {};
      for (const r of m.days) records[r.date] = r;
      const s = Stats.summarize(month, records, m.settings, today, now);
      return {
        month: s.month,
        worked: s.workedMinutes,
        expected: s.expectedMonthMinutes,
        expectedToDate: s.expectedToDateMinutes,
        balance: s.balanceMinutes,
        workdays: s.workdays,
        daysWorked: s.daysWorked,
        vacation: s.vacationDays,
        sick: s.sickDays,
        timeOff: s.timeOffDays,
        other: s.otherDays,
        vehicleDays: s.ownVehicleDays,
        km: s.km,
        offDay: s.offDayMinutes,
        incomplete: s.incompleteDays,
      };
    },

    status(loading, error, data, today) {
      if (loading) return 'Nalagam podatke …';
      if (error && data) return 'Ni bilo mogoče osvežiti: ' + error;
      if (data && data.generatedAt != null) return 'Posodobljeno ' + TeamTexts.synced(data.generatedAt, today);
      return '';
    },
  };

  const SettingsTexts = {
    whenText(d, minute, today) {
      let day;
      if (d === today) day = 'danes';
      else if (d === Day.add(today, 1)) day = 'jutri';
      else day = Fmt.dayName(d) + ', ' + Fmt.dateShort(d);
      return day + ' ob ' + Fmt.clock(minute);
    },

    nextReminder(next, minute, morningEnabled, workdaysEmpty, today) {
      let s;
      if (morningEnabled && next) s = 'Naslednji jutranji opomnik: ' + SettingsTexts.whenText(next, minute, today) + '.';
      else s = 'Jutranji opomnik je izklopljen.';
      if (morningEnabled && workdaysEmpty) s += ' Izberi vsaj en dan.';
      return s;
    },

    sync(connected, manager, pending, lastSyncOk, lastSyncError, connectError, today) {
      if (!connected) {
        if (connectError) {
          return { title: 'Ni povezano', detail: 'Povezava ni uspela: ' + connectError, tone: 'warning', danger: true, ok: false };
        }
        return {
          title: 'Ni povezano',
          detail: 'Povezavo dobiš od vodje. Prilepi jo spodaj in tapni Poveži – tvoje ure se bodo nato samodejno pošiljale vodji.',
          tone: 'muted',
          danger: false,
          ok: false,
        };
      }
      const lines = [];
      lines.push(lastSyncOk > 0 ? 'Zadnje pošiljanje: ' + Fmt.momentMs(lastSyncOk, today) : 'Podatki še niso bili poslani.');
      if (pending > 0) lines.push('Čaka na pošiljanje: ' + pending + ' (pošlje se samodejno).');
      if (!isBlank(lastSyncError)) lines.push('Zadnja napaka: ' + lastSyncError);
      if (manager) lines.push('Ure vseh zaposlenih so v zavihku Ekipa.');
      const error = !isBlank(lastSyncError);
      return {
        title: manager ? 'Povezano kot vodja' : 'Povezano z vodjo',
        detail: lines.join('\n'),
        tone: error ? 'warning' : 'muted',
        danger: false,
        ok: !error,
      };
    },

    deleteAllMessage(connected) {
      return 'Izbrisani bodo vsi zabeleženi dnevi na tem telefonu. Tega ni mogoče razveljaviti. Priporočamo, da prej izvoziš podatke.' +
        (connected ? ' Podatki, ki so že poslani vodji, v preglednici ostanejo.' : '');
    },

    dailyChoices: Array.from({ length: 17 }, (_, i) => (i + 8) * 30),
    breakChoices: Array.from({ length: 13 }, (_, i) => i * 5),

    welcomeText(morningMinutes) {
      return 'Z aplikacijo beležiš prihod, malico in odhod ter opis dneva.\n\n' +
        'Vsak delovni dan ob ' + Fmt.clock(morningMinutes) + ' te lahko opomnik spomni na prihod ' +
        '(vklopiš ga v Nastavitvah, ko je aplikacija povezana z vodjo).\n\nZa mesečna poročila vpiši svoje ime:';
    },
  };

  /** Dnevi za seznam meseca (najnovejši zgoraj): v tekočem mesecu do danes, sicer cel mesec. */
  function listDays(month, records, today) {
    let last;
    if (month === Day.ym(today)) {
      let maxRec = 0;
      const keys = records ? (typeof records.keys === 'function' ? Array.from(records.keys()) : Object.keys(records)) : [];
      for (const k of keys) if (Day.ym(k) === month) maxRec = Math.max(maxRec, Day.dom(k));
      last = Math.max(Day.dom(today), maxRec);
    } else {
      last = YM.length(month);
    }
    const out = [];
    for (let d = Math.max(last, 1); d >= 1; d--) out.push(YM.day(month, d));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Mesečno poročilo PDF – postavitev (A4 pokončno, 595 × 842 pt)
  // ---------------------------------------------------------------------------

  const C = {
    NAVY: 0xFF0A1170,
    BLUE: 0xFF0278C8,
    CYAN: 0xFF19C3F0,
    SUN: 0xFFF9C313,
    TEXT: 0xFF121826,
    GREY: 0xFF5C677A,
    LINE: 0xFFDDE3EA,
    WEEKEND_BG: 0xFFF1F4F8,
    ABSENCE_BG: 0xFFFFF6D8,
    SUMMARY_BG: 0xFFF3F7FB,
    DANGER: 0xFFC62828,
    WHITE: 0xFFFFFFFF,
  };

  const WS = /[ \t\n\x0B\f\r]+/;

  class MonthReport {
    constructor(month, records, s, employee, today, now) {
      this.month = month;
      this.records = records;
      this.s = s;
      this.employee = employee || '';
      this.today = today;
      this.summary = Stats.summarize(month, records, s, today, now);
      this.pageW = MonthReport.PAGE_W;
      this.pageH = MonthReport.PAGE_H;
      this.ml = 32;
      this.mr = 32;
      this.mt = 30;
      this.mb = 26;
      this.contentW = this.pageW - this.ml - this.mr;
      this.headers = ['Datum', 'Dan', 'Prihod', 'Malica', 'Odhod', 'Ure', 'Opis dneva / lokacija', 'Opombe'];
      this.widths = [36, 24, 34, 60, 34, 34, 176, 133];
      this.centered = [false, false, true, true, true, true, false, false];
      this.maxLines = [1, 1, 1, 1, 1, 1, 3, 3];
      this.cellSize = 7.5;
      this.lineH = 9.0;
      this.padV = 2.6;
      this.padH = 3.5;
      this.headerRowH = 20;
      this.footerH = 16;
      this.summaryBoxH = 88;
      this.summaryGap = 12;
      this.summaryTotalH = this.summaryBoxH + 46;
      this.firstTop = this.mt + 76;
      this.nextTop = this.mt + 28;
    }

    render(m, sink) {
      const rows = this.buildRows(m);
      const limit = this.pageH - this.mb - this.footerH;
      const pages = [];
      let y = this.firstTop + this.headerRowH;
      let start = 0;
      for (let i = 0; i < rows.length; i++) {
        if (y + rows[i].height > limit && i > start) {
          pages.push([start, i]);
          start = i;
          y = this.nextTop + this.headerRowH;
        }
        y += rows[i].height;
      }
      pages.push([start, rows.length]);
      const summaryOnNewPage = y + this.summaryGap + this.summaryTotalH > limit;
      const total = pages.length + (summaryOnNewPage ? 1 : 0);
      pages.forEach(([from, to], index) => {
        const g = sink.begin(index + 1);
        let top;
        if (index === 0) {
          this.drawMainHeader(g);
          top = this.firstTop;
        } else {
          this.drawSmallHeader(g);
          top = this.nextTop;
        }
        let yy = this.drawTableHeader(g, top);
        for (let i = from; i < to; i++) {
          this.drawRow(g, rows[i], yy);
          yy += rows[i].height;
        }
        if (index === pages.length - 1 && !summaryOnNewPage) this.drawSummary(g, yy + this.summaryGap);
        this.drawFooter(g, index + 1, total);
        sink.end();
      });
      if (summaryOnNewPage) {
        const g = sink.begin(total);
        this.drawSmallHeader(g);
        this.drawSummary(g, this.nextTop);
        this.drawFooter(g, total, total);
        sink.end();
      }
    }

    buildRows(m) {
      const out = [];
      for (const d of YM.days(this.month)) {
        const r = getRec(this.records, d);
        const holiday = Holidays.name(d);
        const offDay = Holidays.isWeekend(d) || holiday != null;
        const complete = !!r && r.arrival != null && r.departure != null;
        const worked = r && complete ? TimeCalc.totals(r, this.s, null).worked : 0;
        const descParts = [];
        if (holiday) descParts.push(holiday);
        if (r && r.dayType !== 'WORK') descParts.push(DayType.label(r.dayType).toUpperCase());
        if (r && !isBlank(r.location)) descParts.push(r.location);
        const desc = descParts.join(' · ');
        const problems = r ? TimeCalc.problems(r, d < this.today) : [];
        const notes = [];
        if (r && r.ownVehicle) notes.push(r.km > 0 ? 'Lastno vozilo, ' + r.km + ' km' : 'Lastno vozilo');
        if (r && !isBlank(r.notes)) notes.push(r.notes.split('\n').join(' '));
        const texts = [
          Day.dom(d) + '. ' + Day.month(d) + '.',
          Fmt.dayShort(d),
          r && r.arrival != null ? Fmt.clock(r.arrival) : '',
          this.lunchText(r),
          r && r.departure != null ? Fmt.clock(r.departure) : '',
          complete ? Fmt.hm(worked) : '',
          desc,
        ];
        const cells = texts.map((t, i) => this.wrap(m, t, i === 5, this.widths[i] - 2 * this.padH, this.maxLines[i]));
        const noteW = this.widths[7] - 2 * this.padH;
        const warn = problems.length ? this.wrap(m, problems.join(', '), false, noteW, 2) : [];
        cells.push(warn.concat(this.wrap(m, notes.join('; '), false, noteW, this.maxLines[7] - warn.length)));
        const lines = Math.max(Math.max(...cells.map((c) => c.length)), 1);
        let bg = null;
        if (r && Rec.isAbsence(r)) bg = C.ABSENCE_BG;
        else if (offDay) bg = C.WEEKEND_BG;
        out.push({ cells, height: lines * this.lineH + 2 * this.padV, bg, warnLines: warn.length });
      }
      return out;
    }

    lunchText(r) {
      if (!r) return '';
      const a = r.lunchStart;
      const b = r.lunchEnd;
      if (a != null && b != null) return Fmt.clock(a) + '–' + Fmt.clock(b);
      if (a != null) return Fmt.clock(a) + '–';
      if (b != null) return '–' + Fmt.clock(b);
      return '';
    }

    /** Prelom v vrstice znotraj širine; preostanek skrajša s tropičjem (enako kot Kotlin). */
    wrap(m, text, bold, width, max) {
      if (isBlank(text) || max <= 0) return [];
      const w = (t) => m.measure(t, this.cellSize, bold);
      const lines = [];
      let current = '';
      for (const word of text.trim().split(WS)) {
        const candidate = current === '' ? word : current + ' ' + word;
        if (w(candidate) <= width) {
          current = candidate;
          continue;
        }
        if (current !== '') lines.push(current);
        current = word;
        while (w(current) > width && current.length > 1) {
          let n = current.length - 1;
          while (n > 1 && w(current.substring(0, n)) > width) n--;
          lines.push(current.substring(0, n));
          current = current.substring(n);
        }
      }
      if (current !== '') lines.push(current);
      if (lines.length <= max) return lines;
      const kept = lines.slice(0, max);
      let last = kept[max - 1];
      while (last.length > 0 && w(last + '…') > width) last = last.substring(0, last.length - 1);
      kept[max - 1] = last.replace(/\s+$/, '') + '…';
      return kept;
    }

    right(g, text, rightX, baseline, size, color, bold) {
      g.text(text, rightX - g.measure(text, size, bold), baseline, size, color, bold);
    }

    drawMainHeader(g) {
      g.logo(this.ml, this.mt, 54);
      const r = this.pageW - this.mr;
      this.right(g, 'EVIDENCA DELOVNEGA ČASA', r, this.mt + 15, 15, C.NAVY, true);
      this.right(g, Fmt.monthTitle(this.month), r, this.mt + 32, 11.5, C.TEXT, true);
      const who = isBlank(this.employee) ? '______________________________' : this.employee;
      this.right(g, 'Delavec: ' + who, r, this.mt + 47, 9, C.GREY, false);
      g.gradient(this.ml, this.mt + 62, this.pageW - this.mr, this.mt + 65, [C.CYAN, C.BLUE, C.NAVY]);
    }

    drawSmallHeader(g) {
      const text = 'Evidenca delovnega časa · ' + Fmt.monthTitle(this.month) + (isBlank(this.employee) ? '' : ' · ' + this.employee);
      g.text(text, this.ml, this.mt + 10, 9, C.GREY, true);
      g.gradient(this.ml, this.mt + 16, this.pageW - this.mr, this.mt + 17.5, [C.CYAN, C.BLUE, C.NAVY]);
    }

    drawTableHeader(g, top) {
      g.rect(this.ml, top, this.ml + this.contentW, top + this.headerRowH, C.NAVY);
      let x = this.ml;
      const baseline = top + this.headerRowH / 2 + 2.7;
      for (let i = 0; i < this.headers.length; i++) {
        const w = this.widths[i];
        const t = this.headers[i];
        const tw = g.measure(t, this.cellSize, true);
        const tx = this.centered[i] ? x + (w - tw) / 2 : x + this.padH;
        g.text(t, tx, baseline, this.cellSize, C.WHITE, true);
        x += w;
      }
      return top + this.headerRowH;
    }

    drawRow(g, row, top) {
      const bottom = top + row.height;
      if (row.bg != null) g.rect(this.ml, top, this.ml + this.contentW, bottom, row.bg);
      let x = this.ml;
      for (let i = 0; i < row.cells.length; i++) {
        const w = this.widths[i];
        const bold = i === 5;
        row.cells[i].forEach((line, li) => {
          const color = i === 7 && li < row.warnLines ? C.DANGER : C.TEXT;
          const baseline = top + this.padV + 6.8 + li * this.lineH;
          const tx = this.centered[i] ? x + (w - g.measure(line, this.cellSize, bold)) / 2 : x + this.padH;
          g.text(line, tx, baseline, this.cellSize, color, bold);
        });
        x += w;
        if (i < row.cells.length - 1) g.line(x, top, x, bottom, C.LINE, 0.6);
      }
      g.line(this.ml, bottom, this.ml + this.contentW, bottom, C.LINE, 0.6);
      g.line(this.ml, top, this.ml, bottom, C.LINE, 0.6);
      g.line(this.ml + this.contentW, top, this.ml + this.contentW, bottom, C.LINE, 0.6);
    }

    drawSummary(g, top) {
      const ml = this.ml;
      const contentW = this.contentW;
      const boxB = top + this.summaryBoxH;
      g.roundRect(ml, top, ml + contentW, boxB, 6, C.SUMMARY_BG, C.LINE);
      g.rect(ml + 12, top + 11, ml + 15, top + 22, C.SUN);
      g.text('POVZETEK', ml + 20, top + 20, 9.5, C.NAVY, true);
      const sum = this.summary;
      const current = Day.ym(this.today);
      let balanceLabel;
      if (this.month < current) balanceLabel = 'Razlika (nadure / manjko)';
      else if (this.month === current) balanceLabel = 'Razlika do danes';
      else balanceLabel = 'Razlika';
      const left = [
        ['Opravljene ure', Fmt.duration(sum.workedMinutes) + ' (' + Fmt.hoursDecimal(sum.workedMinutes) + ' h)'],
        ['Fond ur (' + Fmt.days(sum.workdays) + ')', Fmt.duration(sum.expectedMonthMinutes)],
        [balanceLabel, this.month > current ? '—' : SummaryTexts.signed(sum.balanceMinutes)],
      ];
      const absencesText = sum.vacationDays + ' / ' + sum.sickDays + ' / ' + sum.timeOffDays;
      const rightCol = [
        ['Dopust / bolniška / prosto (dni)', absencesText],
        ['Delo ob vikendih in praznikih', sum.offDayMinutes > 0 ? Fmt.duration(sum.offDayMinutes) : '—'],
        ['Lastno vozilo', sum.ownVehicleDays > 0 ? Fmt.days(sum.ownVehicleDays) + ', ' + sum.km + ' km' : '—'],
      ];
      const colW = contentW / 2;
      left.forEach((pair, i) => {
        const yy = top + 37 + i * 14;
        g.text(pair[0], ml + 12, yy, 8.5, C.GREY, false);
        this.right(g, pair[1], ml + colW - 16, yy, 8.5, C.TEXT, true);
      });
      g.line(ml + colW, top + 28, ml + colW, top + 68, C.LINE, 0.6);
      rightCol.forEach((pair, i) => {
        const yy = top + 37 + i * 14;
        g.text(pair[0], ml + colW + 14, yy, 8.5, C.GREY, false);
        this.right(g, pair[1], ml + contentW - 12, yy, 8.5, C.TEXT, true);
      });
      const breakNote = this.s.paidBreakMinutes > 0
        ? 'Ure vključujejo plačan odmor do ' + this.s.paidBreakMinutes + ' min.'
        : 'Malica se ne šteje v delovni čas.';
      const note = breakNote + ' Dnevni fond: ' + Fmt.hoursSetting(this.s.dailyMinutes) + '. ' +
        'Upoštevani so dela prosti dnevi v RS. Ustvarjeno: ' + Fmt.dateNumeric(this.today) + '.';
      g.text(note, ml + 12, boxB - 8, 7, C.GREY, false);
      const sy = boxB + 34;
      const third = contentW / 3;
      const labels = ['Datum', 'Podpis delavca', 'Podpis odgovorne osebe'];
      for (let i = 0; i < 3; i++) {
        const x0 = ml + i * third;
        g.line(x0 + 4, sy, x0 + third - 18, sy, C.GREY, 0.7);
        g.text(labels[i], x0 + 4, sy + 11, 8.5, C.TEXT, false);
      }
    }

    drawFooter(g, page, pages) {
      const y = this.pageH - this.mb + 8;
      g.line(this.ml, y - 9, this.pageW - this.mr, y - 9, C.LINE, 0.5);
      g.text('Rešeno – rešitve energetske oskrbe · Evidenca delovnega časa', this.ml, y, 7, C.GREY, false);
      this.right(g, 'Stran ' + page + ' od ' + pages, this.pageW - this.mr, y, 7, C.GREY, false);
    }
  }
  MonthReport.PAGE_W = 595;
  MonthReport.PAGE_H = 842;

  return {
    pad,
    Day,
    YM,
    nowMinutes,
    isBlank,
    DayType,
    Punch,
    record,
    Rec,
    TimeCalc,
    Fmt,
    Holidays,
    Stats,
    Csv,
    Schedule,
    ReminderText,
    SyncError,
    SyncPayload,
    TodayStatus,
    DayRowText,
    DayHeader,
    SummaryTexts,
    TeamTexts,
    SettingsTexts,
    listDays,
    MonthReport,
    COLORS: C,
  };
});

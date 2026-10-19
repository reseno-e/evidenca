/*
 * Rešeno Evidenca – mesečno poročilo PDF v brskalniku.
 * Majhen zapisovalnik PDF brez zunanjih knjižnic: vdelana pisava Roboto (podnabor TrueType, Identity-H,
 * zato se šumniki pravilno prikažejo v vseh pregledovalnikih), logotip JPEG in barvni prehod.
 * Postavitev strani je v core.js (MonthReport) in je enaka kot v Androidni različici.
 */
(function (root, factory) {
  'use strict';
  const core = root.EvidencaCore || (typeof require === 'function' ? require('./core.js') : null);
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EvidencaPdf = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  const PAGE_W = core.MonthReport.PAGE_W;
  const PAGE_H = core.MonthReport.PAGE_H;

  /** Vedno navaden Uint8Array (tudi za Node Buffer, katerega slice ne kopira podatkov). */
  function toBytes(data) {
    if (data instanceof Uint8Array) {
      return data.constructor === Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Pričakovani so binarni podatki.');
  }

  // ---------------------------------------------------------------------------
  // Pisava TrueType: branje, merjenje in podnabor za vdelavo
  // ---------------------------------------------------------------------------

  // Znaki, ki jih v poročilu izpustimo (emoji, izbirniki različic, združevalniki).
  function isDropped(cp) {
    return cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x1F000 && cp <= 0x1FAFF) ||
      (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2B00 && cp <= 0x2BFF) || (cp >= 0xE0000 && cp <= 0xE007F);
  }

  class TtfFont {
    constructor(data, name) {
      const u8 = toBytes(data);
      this.u8 = u8;
      this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.name = name;
      const dv = this.dv;
      const version = dv.getUint32(0);
      if (version !== 0x00010000 && version !== 0x74727565) throw new Error('Pisava ni v obliki TrueType.');
      const numTables = dv.getUint16(4);
      this.tables = {};
      for (let i = 0; i < numTables; i++) {
        const p = 12 + 16 * i;
        const tag = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
        this.tables[tag] = { offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) };
      }
      for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) {
        if (!this.tables[t]) throw new Error('Pisavi manjka tabela ' + t + '.');
      }
      const head = this.tables.head.offset;
      this.upm = dv.getUint16(head + 18);
      this.bbox = [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)];
      this.locFormat = dv.getInt16(head + 50);
      const hhea = this.tables.hhea.offset;
      this.ascent = dv.getInt16(hhea + 4);
      this.descent = dv.getInt16(hhea + 6);
      this.numHMetrics = dv.getUint16(hhea + 34);
      this.numGlyphs = dv.getUint16(this.tables.maxp.offset + 4);
      const os2 = this.tables['OS/2'];
      this.capHeight = os2 && dv.getUint16(os2.offset) >= 2 ? dv.getInt16(os2.offset + 88) : Math.round(this.ascent * 0.7);
      this.weight = os2 ? dv.getUint16(os2.offset + 4) : 400;
      this.loca = new Array(this.numGlyphs + 1);
      const loca = this.tables.loca.offset;
      for (let i = 0; i <= this.numGlyphs; i++) {
        this.loca[i] = this.locFormat === 0 ? dv.getUint16(loca + 2 * i) * 2 : dv.getUint32(loca + 4 * i);
      }
      this.cmap = this.readCmap();
      this.question = this.cmap.get(0x3F) || 0;
      this.space = this.cmap.get(0x20) || 0;
    }

    readCmap() {
      const dv = this.dv;
      const base = this.tables.cmap.offset;
      const n = dv.getUint16(base + 2);
      let f4 = -1;
      let f12 = -1;
      for (let i = 0; i < n; i++) {
        const pid = dv.getUint16(base + 4 + 8 * i);
        const eid = dv.getUint16(base + 6 + 8 * i);
        const off = base + dv.getUint32(base + 8 + 8 * i);
        const format = dv.getUint16(off);
        const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
        if (!unicode) continue;
        if (format === 4 && (f4 < 0 || pid === 3)) f4 = off;
        if (format === 12) f12 = off;
      }
      const map = new Map();
      if (f4 >= 0) {
        const segX2 = dv.getUint16(f4 + 6);
        const ends = f4 + 14;
        const starts = ends + segX2 + 2;
        const deltas = starts + segX2;
        const ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
          const end = dv.getUint16(ends + 2 * s);
          const start = dv.getUint16(starts + 2 * s);
          const delta = dv.getInt16(deltas + 2 * s);
          const ro = dv.getUint16(ranges + 2 * s);
          for (let c = start; c <= end && c !== 0xFFFF; c++) {
            let g;
            if (ro === 0) {
              g = (c + delta) & 0xFFFF;
            } else {
              g = dv.getUint16(ranges + 2 * s + ro + 2 * (c - start));
              if (g !== 0) g = (g + delta) & 0xFFFF;
            }
            if (g !== 0 && g < this.numGlyphs) map.set(c, g);
          }
        }
      }
      if (f12 >= 0) {
        const groups = dv.getUint32(f12 + 12);
        for (let i = 0; i < groups; i++) {
          const p = f12 + 16 + 12 * i;
          const s = dv.getUint32(p);
          const e = dv.getUint32(p + 4);
          const g0 = dv.getUint32(p + 8);
          for (let c = s; c <= e && c - s < 65536; c++) if (!map.has(c) && g0 + c - s < this.numGlyphs) map.set(c, g0 + c - s);
        }
      }
      return map;
    }

    advance(gid) {
      const i = gid < this.numHMetrics ? gid : this.numHMetrics - 1;
      return this.dv.getUint16(this.tables.hmtx.offset + 4 * i);
    }

    /** Besedilo → zaporedje [glyph, unicode]; manjkajoči znaki dobijo osnovno črko ali »?«. */
    shape(text) {
      const out = [];
      for (const ch of String(text == null ? '' : text)) {
        let cp = ch.codePointAt(0);
        if (isDropped(cp)) continue;
        if (cp < 0x20 || cp === 0x7F || (cp >= 0x80 && cp < 0xA0)) cp = 0x20;
        let uni = String.fromCodePoint(cp);
        let g = this.cmap.get(cp);
        if (!g) {
          const base = uni.normalize('NFD').replace(/[̀-ͯ]/g, '');
          const b = base ? base.codePointAt(0) : 0;
          if (base.length === 1 && this.cmap.get(b)) {
            g = this.cmap.get(b);
            uni = base;
          } else {
            g = this.question;
            uni = '?';
          }
        }
        out.push([g, uni]);
      }
      return out;
    }

    measure(text, size) {
      let w = 0;
      for (const [g] of this.shape(text)) w += this.advance(g);
      return w * size / this.upm;
    }

    /** Podnabor z ohranjenimi številkami znakov (CIDToGIDMap /Identity). */
    subset(used) {
      const dv = this.dv;
      const glyf = this.tables.glyf.offset;
      const keep = new Set([0]);
      const stack = Array.from(used);
      while (stack.length) {
        const g = stack.pop();
        if (g >= this.numGlyphs || (keep.has(g) && g !== 0)) continue;
        keep.add(g);
        const start = this.loca[g];
        const end = this.loca[g + 1];
        if (end - start < 10) continue;
        if (dv.getInt16(glyf + start) >= 0) continue;
        let q = glyf + start + 10;
        for (;;) {
          const flags = dv.getUint16(q);
          const comp = dv.getUint16(q + 2);
          if (!keep.has(comp)) stack.push(comp);
          q += 4 + (flags & 0x0001 ? 4 : 2);
          if (flags & 0x0008) q += 2;
          else if (flags & 0x0040) q += 4;
          else if (flags & 0x0080) q += 8;
          if (!(flags & 0x0020)) break;
        }
      }
      const parts = [];
      const locaOut = new Uint8Array((this.numGlyphs + 1) * 4);
      const locaDv = new DataView(locaOut.buffer);
      let off = 0;
      for (let g = 0; g < this.numGlyphs; g++) {
        locaDv.setUint32(4 * g, off);
        if (!keep.has(g)) continue;
        const len = this.loca[g + 1] - this.loca[g];
        if (len <= 0) continue;
        parts.push(this.u8.subarray(glyf + this.loca[g], glyf + this.loca[g + 1]));
        off += len;
        const padLen = (4 - (len % 4)) % 4;
        if (padLen) {
          parts.push(new Uint8Array(padLen));
          off += padLen;
        }
      }
      locaDv.setUint32(4 * this.numGlyphs, off);
      const glyfOut = concat(parts);
      const table = (tag) => {
        const t = this.tables[tag];
        return new Uint8Array(this.u8.subarray(t.offset, t.offset + t.length));
      };
      const head = table('head');
      const headDv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      headDv.setUint32(8, 0);
      headDv.setInt16(50, 1);
      const tables = { head, hhea: table('hhea'), maxp: table('maxp'), hmtx: table('hmtx'), loca: locaOut, glyf: glyfOut };
      for (const t of ['cvt ', 'fpgm', 'prep']) if (this.tables[t]) tables[t] = table(t);
      return buildSfnt(tables);
    }
  }

  function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const word = ((bytes[i] << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  }

  function buildSfnt(tables) {
    const tags = Object.keys(tables).sort();
    const n = tags.length;
    let pow = 1;
    let entrySelector = 0;
    while (pow * 2 <= n) {
      pow *= 2;
      entrySelector++;
    }
    const searchRange = pow * 16;
    let total = 12 + 16 * n;
    const offsets = tags.map((t) => {
      const o = total;
      total += (tables[t].length + 3) & ~3;
      return o;
    });
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, n);
    dv.setUint16(6, searchRange);
    dv.setUint16(8, entrySelector);
    dv.setUint16(10, n * 16 - searchRange);
    tags.forEach((t, i) => {
      const p = 12 + 16 * i;
      for (let k = 0; k < 4; k++) out[p + k] = t.charCodeAt(k);
      dv.setUint32(p + 4, checksum(tables[t]));
      dv.setUint32(p + 8, offsets[i]);
      dv.setUint32(p + 12, tables[t].length);
      out.set(tables[t], offsets[i]);
    });
    const headAt = offsets[tags.indexOf('head')];
    dv.setUint32(headAt + 8, (0xB1B0AFBA - checksum(out)) >>> 0);
    return out;
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Pomožne funkcije za zapis PDF
  // ---------------------------------------------------------------------------

  const enc = new TextEncoder();

  function num(v) {
    if (Number.isInteger(v)) return String(v);
    const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  function rgb(c) {
    const r = ((c >>> 16) & 255) / 255;
    const g = ((c >>> 8) & 255) / 255;
    const b = (c & 255) / 255;
    return num(r) + ' ' + num(g) + ' ' + num(b);
  }

  function hex4(n) {
    return ('000' + n.toString(16).toUpperCase()).slice(-4);
  }

  /** Besedilni niz PDF v UTF-16BE (za naslov, avtorja …). */
  function pdfText(s) {
    let out = '<FEFF';
    const str = String(s);
    for (let i = 0; i < str.length; i++) out += hex4(str.charCodeAt(i));
    return out + '>';
  }

  function pdfDate(d) {
    const p = (n) => (n < 10 ? '0' : '') + n;
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return '(D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) +
      p(d.getSeconds()) + sign + p(Math.floor(a / 60)) + "'" + p(a % 60) + "')";
  }

  function jpegInfo(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) throw new Error('Logotip ni v obliki JPEG.');
    let p = 2;
    while (p + 9 < u8.length) {
      if (u8[p] !== 0xFF) {
        p++;
        continue;
      }
      const marker = u8[p + 1];
      if (marker === 0xFF) {
        p++;
        continue;
      }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        p += 2;
        continue;
      }
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { height: (u8[p + 5] << 8) | u8[p + 6], width: (u8[p + 7] << 8) | u8[p + 8], components: u8[p + 9] };
      }
      p += 2 + len;
    }
    throw new Error('Velikosti logotipa ni bilo mogoče prebrati.');
  }

  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Dokument
  // ---------------------------------------------------------------------------

  class PdfDocument {
    /**
     * @param fonts {regular, bold} – TtfFont ali binarni podatki pisave
     * @param logo binarni podatki JPEG (ali null)
     */
    constructor(fonts, logo) {
      this.regular = fonts.regular instanceof TtfFont ? fonts.regular : new TtfFont(fonts.regular, 'Roboto-Regular');
      this.bold = fonts.bold instanceof TtfFont ? fonts.bold : new TtfFont(fonts.bold, 'Roboto-Bold');
      this.used = { F1: new Map(), F2: new Map() };
      this.pages = [];
      this.shadings = new Map();
      this.logo = null;
      if (logo) {
        const bytes = toBytes(logo);
        this.logo = Object.assign({ bytes }, jpegInfo(bytes));
      }
    }

    font(bold) {
      return bold ? this.bold : this.regular;
    }

    measure(text, size, bold) {
      return this.font(bold).measure(text, size);
    }

    shadingName(colors) {
      const key = colors.map((c) => c >>> 0).join(',');
      if (!this.shadings.has(key)) this.shadings.set(key, { name: 'Sh' + this.shadings.size, colors: colors.slice() });
      return this.shadings.get(key).name;
    }

    /** Vir strani za MonthReport.render (PageSink). */
    sink() {
      const doc = this;
      let current = null;
      return {
        begin() {
          current = new PageGfx(doc);
          return current;
        },
        end() {
          if (current) doc.pages.push(current.ops.join('\n'));
          current = null;
        },
      };
    }

    async build(info) {
      const objects = [null];
      const add = (dict, stream) => {
        objects.push({ dict, stream });
        return objects.length - 1;
      };
      const reserve = () => {
        objects.push(null);
        return objects.length - 1;
      };
      const catalog = reserve();
      const pagesId = reserve();
      const compress = async (bytes) => {
        const z = await deflate(bytes);
        return z && z.length < bytes.length ? { bytes: z, filter: ' /Filter /FlateDecode' } : { bytes, filter: '' };
      };

      const fontRefs = {};
      for (const key of ['F1', 'F2']) {
        const font = key === 'F2' ? this.bold : this.regular;
        const used = this.used[key];
        if (!used.size) continue;
        const scale = 1000 / font.upm;
        const raw = font.subset(used.keys());
        const program = await compress(raw);
        const fontFile = add('<< /Length ' + program.bytes.length + ' /Length1 ' + raw.length + program.filter + ' >>', program.bytes);
        const psName = (key === 'F2' ? 'RSNEVB+' : 'RSNEVA+') + font.name;
        const descriptor = add('<< /Type /FontDescriptor /FontName /' + psName + ' /Flags 32 /FontBBox [' +
          font.bbox.map((v) => num(v * scale)).join(' ') + '] /ItalicAngle 0 /Ascent ' + num(font.ascent * scale) +
          ' /Descent ' + num(font.descent * scale) + ' /CapHeight ' + num(font.capHeight * scale) + ' /StemV ' +
          (font.weight >= 600 ? 120 : 80) + ' /FontFile2 ' + fontFile + ' 0 R >>');
        const gids = Array.from(used.keys()).sort((a, b) => a - b);
        const widths = gids.map((g) => g + ' [' + num(font.advance(g) * scale) + ']').join(' ');
        const cid = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + psName +
          ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + descriptor +
          ' 0 R /W [' + widths + '] /DW ' + num(font.advance(0) * scale) + ' /CIDToGIDMap /Identity >>');
        const toUnicode = await compress(enc.encode(toUnicodeCMap(gids, used)));
        const tu = add('<< /Length ' + toUnicode.bytes.length + toUnicode.filter + ' >>', toUnicode.bytes);
        fontRefs[key] = add('<< /Type /Font /Subtype /Type0 /BaseFont /' + psName + ' /Encoding /Identity-H /DescendantFonts [' +
          cid + ' 0 R] /ToUnicode ' + tu + ' 0 R >>');
      }

      let xobjects = '';
      if (this.logo && this.logoUsed) {
        const l = this.logo;
        const cs = l.components === 1 ? '/DeviceGray' : l.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        const img = add('<< /Type /XObject /Subtype /Image /Width ' + l.width + ' /Height ' + l.height + ' /ColorSpace ' + cs +
          ' /BitsPerComponent 8 /Filter /DCTDecode' + (l.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '') +
          ' /Length ' + l.bytes.length + ' >>', l.bytes);
        xobjects = ' /XObject << /Im1 ' + img + ' 0 R >>';
      }

      let shadings = '';
      for (const sh of this.shadings.values()) {
        const cols = sh.colors.map(rgb);
        let fn;
        if (cols.length === 1) cols.push(cols[0]);
        if (cols.length === 2) {
          fn = '<< /FunctionType 2 /Domain [0 1] /C0 [' + cols[0] + '] /C1 [' + cols[1] + '] /N 1 >>';
        } else {
          const parts = [];
          const bounds = [];
          const encode = [];
          for (let i = 0; i < cols.length - 1; i++) {
            parts.push('<< /FunctionType 2 /Domain [0 1] /C0 [' + cols[i] + '] /C1 [' + cols[i + 1] + '] /N 1 >>');
            if (i > 0) bounds.push(num(i / (cols.length - 1)));
            encode.push('0 1');
          }
          fn = '<< /FunctionType 3 /Domain [0 1] /Functions [' + parts.join(' ') + '] /Bounds [' + bounds.join(' ') +
            '] /Encode [' + encode.join(' ') + '] >>';
        }
        const id = add('<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function ' + fn + ' /Extend [true true] >>');
        shadings += ' /' + sh.name + ' ' + id + ' 0 R';
      }

      const fontDict = Object.keys(fontRefs).map((k) => '/' + k + ' ' + fontRefs[k] + ' 0 R').join(' ');
      const resources = add('<< /ProcSet [/PDF /Text /ImageC]' + (fontDict ? ' /Font << ' + fontDict + ' >>' : '') + xobjects +
        (shadings ? ' /Shading <<' + shadings + ' >>' : '') + ' >>');

      const kids = [];
      for (const ops of this.pages) {
        const content = await compress(enc.encode(ops));
        const c = add('<< /Length ' + content.bytes.length + content.filter + ' >>', content.bytes);
        kids.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources ' +
          resources + ' 0 R /Contents ' + c + ' 0 R >>'));
      }
      objects[pagesId] = { dict: '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>' };
      objects[catalog] = { dict: '<< /Type /Catalog /Pages ' + pagesId + ' 0 R /Lang (sl-SI) /ViewerPreferences << /DisplayDocTitle true >> >>' };

      const meta = info || {};
      const now = meta.date || new Date();
      let infoDict = '<< /Producer ' + pdfText('Rešeno Evidenca (spletna različica)') + ' /Creator ' + pdfText('Rešeno Evidenca') +
        ' /CreationDate ' + pdfDate(now) + ' /ModDate ' + pdfDate(now);
      if (meta.title) infoDict += ' /Title ' + pdfText(meta.title);
      if (meta.author) infoDict += ' /Author ' + pdfText(meta.author);
      if (meta.subject) infoDict += ' /Subject ' + pdfText(meta.subject);
      const infoId = add(infoDict + ' >>');

      // Zapis datoteke
      const chunks = [];
      let length = 0;
      const write = (data) => {
        const b = typeof data === 'string' ? enc.encode(data) : data;
        chunks.push(b);
        length += b.length;
      };
      write('%PDF-1.7\n');
      write(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
      const offsets = [0];
      for (let i = 1; i < objects.length; i++) {
        offsets[i] = length;
        const o = objects[i];
        if (o.stream) {
          write(i + ' 0 obj\n' + o.dict + '\nstream\n');
          write(o.stream);
          write('\nendstream\nendobj\n');
        } else {
          write(i + ' 0 obj\n' + o.dict + '\nendobj\n');
        }
      }
      const xref = length;
      let table = 'xref\n0 ' + objects.length + '\n0000000000 65535 f\r\n';
      for (let i = 1; i < objects.length; i++) table += ('000000000' + offsets[i]).slice(-10) + ' 00000 n\r\n';
      write(table);
      const id = randomId();
      write('trailer\n<< /Size ' + objects.length + ' /Root ' + catalog + ' 0 R /Info ' + infoId + ' 0 R /ID [<' + id + '> <' + id +
        '>] >>\nstartxref\n' + xref + '\n%%EOF\n');
      return concat(chunks);
    }
  }

  function randomId() {
    const b = new Uint8Array(16);
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, (x) => ('0' + x.toString(16)).slice(-2)).join('').toUpperCase();
  }

  function toUnicodeCMap(gids, used) {
    const lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'];
    for (let i = 0; i < gids.length; i += 100) {
      const block = gids.slice(i, i + 100);
      lines.push(block.length + ' beginbfchar');
      for (const g of block) {
        const u = used.get(g);
        let hex = '';
        for (let k = 0; k < u.length; k++) hex += hex4(u.charCodeAt(k));
        lines.push('<' + hex4(g) + '> <' + hex + '>');
      }
      lines.push('endbfchar');
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    return lines.join('\n');
  }

  /** Risanje ene strani (vmesnik Gfx iz core.js). Koordinate: izhodišče zgoraj levo, y navzdol. */
  class PageGfx {
    constructor(doc) {
      this.doc = doc;
      this.ops = [];
    }

    measure(text, size, bold) {
      return this.doc.measure(text, size, bold);
    }

    text(text, x, baseline, size, color, bold) {
      const key = bold ? 'F2' : 'F1';
      const glyphs = this.doc.font(bold).shape(text);
      if (!glyphs.length) return;
      const used = this.doc.used[key];
      let hex = '';
      for (const [g, u] of glyphs) {
        if (!used.has(g)) used.set(g, u);
        hex += hex4(g);
      }
      this.ops.push('BT /' + key + ' ' + num(size) + ' Tf ' + rgb(color) + ' rg ' + num(x) + ' ' + num(PAGE_H - baseline) +
        ' Td <' + hex + '> Tj ET');
    }

    rect(l, t, r, b, color) {
      this.ops.push(rgb(color) + ' rg ' + num(l) + ' ' + num(PAGE_H - b) + ' ' + num(r - l) + ' ' + num(b - t) + ' re f');
    }

    roundRect(l, t, r, b, radius, fill, stroke) {
      const k = 0.5523 * radius;
      const x0 = l;
      const x1 = r;
      const y0 = PAGE_H - b;
      const y1 = PAGE_H - t;
      const p = (x, y) => num(x) + ' ' + num(y);
      const path = [
        p(x0 + radius, y0) + ' m',
        p(x1 - radius, y0) + ' l',
        p(x1 - radius + k, y0) + ' ' + p(x1, y0 + radius - k) + ' ' + p(x1, y0 + radius) + ' c',
        p(x1, y1 - radius) + ' l',
        p(x1, y1 - radius + k) + ' ' + p(x1 - radius + k, y1) + ' ' + p(x1 - radius, y1) + ' c',
        p(x0 + radius, y1) + ' l',
        p(x0 + radius - k, y1) + ' ' + p(x0, y1 - radius + k) + ' ' + p(x0, y1 - radius) + ' c',
        p(x0, y0 + radius) + ' l',
        p(x0, y0 + radius - k) + ' ' + p(x0 + radius - k, y0) + ' ' + p(x0 + radius, y0) + ' c',
        'h',
      ];
      this.ops.push(rgb(fill) + ' rg ' + rgb(stroke) + ' RG 0.8 w ' + path.join(' ') + ' B');
    }

    line(x1, y1, x2, y2, color, width) {
      this.ops.push(rgb(color) + ' RG ' + num(width) + ' w ' + num(x1) + ' ' + num(PAGE_H - y1) + ' m ' + num(x2) + ' ' +
        num(PAGE_H - y2) + ' l S');
    }

    gradient(l, t, r, b, colors) {
      const name = this.doc.shadingName(colors);
      const x = num(l);
      const y = num(PAGE_H - b);
      const w = num(r - l);
      const h = num(b - t);
      this.ops.push('q ' + x + ' ' + y + ' ' + w + ' ' + h + ' re W n ' + w + ' 0 0 ' + h + ' ' + x + ' ' + y + ' cm /' + name + ' sh Q');
    }

    logo(l, t, height) {
      const logo = this.doc.logo;
      if (!logo || logo.height <= 0) return 0;
      const w = height * logo.width / logo.height;
      this.doc.logoUsed = true;
      this.ops.push('q ' + num(w) + ' 0 0 ' + num(height) + ' ' + num(l) + ' ' + num(PAGE_H - t - height) + ' cm /Im1 Do Q');
      return w;
    }
  }

  // ---------------------------------------------------------------------------
  // Mesečno poročilo
  // ---------------------------------------------------------------------------

  /**
   * Ustvari PDF poročilo za mesec.
   * @param o {month, records, settings, employee, today, now, fonts: {regular, bold}, logo}
   * @returns Promise<Uint8Array>
   */
  async function monthReport(o) {
    const doc = new PdfDocument(o.fonts, o.logo || null);
    const report = new core.MonthReport(o.month, o.records, o.settings, o.employee || '', o.today, o.now);
    report.render({ measure: (t, size, bold) => doc.measure(t, size, bold) }, doc.sink());
    const who = String(o.employee || '').trim();
    return doc.build({
      title: 'Evidenca delovnega časa – ' + core.Fmt.monthTitle(o.month) + (who ? ' – ' + who : ''),
      author: who || undefined,
      subject: 'Mesečna evidenca delovnega časa',
      date: o.date,
    });
  }

  return { TtfFont, PdfDocument, monthReport, jpegInfo };
});

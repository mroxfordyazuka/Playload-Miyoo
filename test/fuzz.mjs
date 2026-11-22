// Random API calls against Playload's untouched engine and the patched one; every result, every
// error and every frame must match.   node test/fuzz.mjs <playload repo> [rounds]
const [repo, roundsArg] = process.argv.slice(2);
const { createEngine: createRef } = await import(`${repo}/src/engine/engine.js`);
const { createEngine: createFast } = await import('../build/engine-fast.mjs');
const { glyphs } = await import(`${repo}/src/engine/glyphs.js`);

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}
const realRandom = Math.random;
function make(create, seed) {
  Math.random = prng(seed);          // each engine captures its own noise source
  const engine = create(glyphs, (s) => ({ code: [], fixedVolume: false, s }));
  Math.random = realRandom;
  return engine;
}
const CHARS = ['A', 'z', ' ', '#', '0', 'あ', 'が', 'が', 'ｶﾞ', '👾', '💎', '❤️', '❤', '⬆️', '⬆', '🇯🇵', '👍🏽', '👨‍👩‍👧', '1️⃣', 'é', 'é', '漢', '́', '█', '▀', 'Ω', 'ß', '\t', '‍', '🏳️‍🌈', '️', '', 'AB', '\n', '\r', '\r\n', '\u0000', '\ud83d', 'か゚'];
const BAD = [undefined, null, 1.5, -1, 8, '3', NaN, Infinity, {}, [], true, 7.0, -0, 0, 3];

let failures = 0;
function same(a, b, what, log) {
  if (a === b || (a !== a && b !== b)) return;
  failures++;
  if (failures < 15) console.log('MISMATCH', what, JSON.stringify(a).slice(0, 200), JSON.stringify(b).slice(0, 200), '\n   after:', log.slice(-6).join(' | '));
}
function show(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return 'fn';
  if (ArrayBuffer.isView(v)) return v.constructor.name + ':' + Array.from(v).join(',');
  if (v instanceof ArrayBuffer) return 'AB:' + Array.from(new Uint8Array(v)).join(',');
  try { return JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)) ?? String(v); } catch (e) { return 'unserializable'; }
}
const rounds = Number(roundsArg ?? 300);
for (let round = Number(process.env.ROUND ?? 0); round < rounds; round++) {
  const rnd = prng(round * 7919 + 1);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const col = () => (rnd() < 0.9 ? int(0, 7) : pick(BAD));
  const str = () => {
    if (rnd() < 0.05) return pick([undefined, 5, null, {}]);
    let s = ''; const n = rnd() < 0.5 ? 1 : int(0, 24);
    for (let i = 0; i < n; i++) s += rnd() < 0.8 ? pick(CHARS.slice(0, 24)) : pick(CHARS);
    return s;
  };
  const coord = (max) => (rnd() < 0.95 ? int(-12, max) : pick([1.7, -3.2, NaN, Infinity, 1e300, '4', null, undefined, -1e300]));
  const engines = [make(createRef, round + 1), make(createFast, round + 1)];
  const saved = [[], []];         // references a game might keep: color pairs, patterns, cells
  const log = [];
  const both = (what, fn) => {
    log.push(what);
    const out = engines.map((engine, which) => {
      try { return 'ok ' + show(fn(engine.api, saved[which], engine)); } catch (e) { return 'throw ' + e.constructor.name + ': ' + e.message; }
    });
    same(out[0], out[1], what, log);
    if (process.env.KEYS && !globalThis.kshown) { const k = engines.map((e) => new Set(Object.keys(e.api.pcg))); const d = [...k[1]].filter((x) => !k[0].has(x)).concat([...k[0]].filter((x) => !k[1].has(x))); if (d.length) { globalThis.kshown = 1; console.log('KEYS differ after', what, d.map((x) => [...x].map((c) => c.codePointAt(0).toString(16)).join('+')), k[0].size, k[1].size); } }
  };
  const steps = int(20, 200);
  for (let step = 0; step < steps; step++) {
    const op = int(0, 31);
    if (op === 0) { const c = col(); both(`cls(${show(c)})`, (a) => a.cls(c)); }
    else if (op <= 4) { const x = coord(22), y = coord(20), s = str(), c1 = rnd() < 0.3 ? undefined : col(), c2 = rnd() < 0.5 ? undefined : col(); both(`put(${show(x)},${show(y)},${show(s)},${show(c1)},${show(c2)})`, (a) => a.put(x, y, s, c1, c2)); }
    else if (op <= 8) { const x = coord(170), y = coord(150), s = str(), c = col(); const n = rnd() < 0.03 ? 140 : 1; both(`spr x${n}(${show(x)},${show(y)},${show(s)},${show(c)})`, (a) => { for (let i = 0; i < n; i++) a.spr(x, y, s, c); }); }
    else if (op === 9) { const y = int(0, 17), x = int(0, 19), s = rnd() < 0.8 ? pick(CHARS) : pick([1, null, undefined]); both(`scr[${y}][${x}].chr=${show(s)}`, (a) => { a.scr[y][x].chr = s; return a.scr[y][x].chr; }); }
    else if (op === 10) { const y = int(0, 17), x = int(0, 19), v = pick([[1, 2], [null, 3], [undefined, null], [8, 1], [1], [1, 2, 3], 'ab', null, [0, 0], [7, 7], new Array(2), [-0, 5]]); both(`scr[${y}][${x}].col=${show(v)}`, (a) => { a.scr[y][x].col = v; return [...a.scr[y][x].col]; }); }
    else if (op === 11) { const y = int(0, 17), x = int(0, 19), i = pick([0, 1, 2, 'length', -1, 'x']), v = pick([0, 5, 7, null, undefined, 9, 'a']); both(`scr[${y}][${x}].col[${i}]=${show(v)}`, (a) => { a.scr[y][x].col[i] = v; return [...a.scr[y][x].col]; }); }
    else if (op === 12) { const y = int(0, 17), x = int(0, 19); both(`read scr[${y}][${x}]`, (a, keep) => { const e = a.scr[y][x]; const c = e.col; keep.push(c); return [e.chr, c[0], c[1], c.length, Array.isArray(c), Object.keys(c), JSON.stringify(c), Object.keys(e), 0 in c, c.map((v) => v), Object.getOwnPropertyDescriptor(c, '1')]; }); }
    else if (op === 13) { both('read saved', (a, keep) => keep.map((k) => (ArrayBuffer.isView(k) || Array.isArray(k) ? Array.from(k) : String(k)))); }
    else if (op === 14) { const i = int(0, 40), k = pick([0, 1]), v = pick([0, 3, 7, null, 8]); both(`saved[${i}][${k}]=${show(v)}`, (a, keep) => { const t = keep[i % (keep.length || 1)]; if (!t) return 'none'; t[k] = v; return Array.from(t); }); }
    else if (op === 15) { const c = pick(CHARS), v = pick(['0123456789abcdef', 'FFFFFFFFFFFFFFFF', 'zz', '00', [1, 2, 3, 4, 5, 6, 7, 8], [255, 0, 255, 0, 255, 0, 255, 0], [1, 2, 3], [256, 0, 0, 0, 0, 0, 0, 0], new Uint8Array(8).fill(170), null, 5, [1.5, 0, 0, 0, 0, 0, 0, 0]]); both(`pcg[${show(c)}].pat=${show(v)}`, (a) => { a.pcg[c].pat = v; return Array.from(a.pcg[c].pat); }); }
    else if (op === 16) { const c = pick(CHARS), i = pick([0, 3, 7, 8, -1, 'length', 'foo']), v = pick([0, 255, 129, 256, -1, 1.5, 'a', null]); both(`pcg[${show(c)}].pat[${i}]=${show(v)}`, (a) => { a.pcg[c].pat[i] = v; return Array.from(a.pcg[c].pat); }); }
    else if (op === 17) { const c = pick(CHARS), v = pick([[1, 2], [7, 0], [null, 1], [8, 8], [3], 'xy', [0, 0]]); both(`pcg[${show(c)}].col=${show(v)}`, (a) => { a.pcg[c].col = v; return [...a.pcg[c].col]; }); }
    else if (op === 18) { const c = pick(CHARS), i = pick([0, 1, 2]), v = pick([0, 4, 7, 8, null, undefined]); both(`pcg[${show(c)}].col[${i}]=${show(v)}`, (a) => { a.pcg[c].col[i] = v; return [...a.pcg[c].col]; }); }
    else if (op === 19) {
      const c = pick(CHARS), m = int(0, 13), n1 = int(-3, 10), n2 = int(-3, 10), v = int(0, 300);
      both(`pcg[${show(c)}].pat method ${m} ${n1} ${n2} ${v}`, (a, keep) => {
        const p = a.pcg[c].pat; keep.push(p);
        switch (m) {
          case 0: p.fill(v, n1, n2); break;
          case 1: p.set([v, v + 1, v + 2], n1); break;
          case 2: p.reverse(); break;
          case 3: p.copyWithin(n1, n2); break;
          case 4: p.sort(); break;
          case 5: { const sub = p.subarray(n1, n2); keep.push(sub); sub.fill(v); return [sub.length, sub.byteOffset, Array.from(sub)]; }
          case 6: return [p.length, p.byteLength, p.byteOffset, p.buffer.byteLength, p.BYTES_PER_ELEMENT, Object.keys(p).join()];
          case 7: return [p.map((x) => x ^ 255).join(), p.slice(n1, n2).join(), p.indexOf(v & 255), p.includes(0), p.join('-')];
          case 8: p.forEach((x, i, arr) => { if (i === 2) arr[i] = v & 255; }); break;
          case 9: new Uint8Array(p.buffer).fill(9); break;
          case 10: p.set(new Uint8Array(8).fill(v & 255)); break;
          case 11: p[n1 & 7] |= 1 << (v & 7); p[n2 & 7] ^= 255; break;
          case 12: for (let i = 0; i < 300; i++) p[i & 7] = i; break;      // blows the 256-byte budget
          case 13: return [Array.from(p), [...p].length, Object.getOwnPropertyDescriptor(p, '0')?.value, Reflect.ownKeys(p).length];
        }
        return Array.from(p);
      });
    }
    else if (op === 20) { const c = pick(CHARS); both(`read pcg[${show(c)}]`, (a, keep) => { const e = a.pcg[c]; keep.push(e.col); return [Array.from(e.pat), [...e.col], Object.keys(e), Array.isArray(e.col), e === a.pcg[c]]; }); }
    else if (op === 21) { both('many pcg', (a) => { for (let i = 0; i < 300; i++) a.pcg[String.fromCharCode(0x4e00 + i)].pat = 'ff00ff00ff00ff00'; return Object.keys(a.pcg).length; }); }
    else if (op === 22) { const c = pick(CHARS); both(`bad pcg ops ${show(c)}`, (a) => { const r = []; try { a.pcg[c] = 1; } catch (e) { r.push(e.message); } try { delete a.pcg[c]; } catch (e) { r.push(e.message); } try { a.scr[0][0] = 1; } catch (e) { r.push(e.constructor.name); } try { delete a.scr[0][0].col[0]; } catch (e) { r.push(e.message); } try { a.scr[0][0].foo = 1; } catch (e) { r.push(e.constructor.name); } return r; }); }
    else if (op === 23) { const m = int(0, 63); both(`input ${m}`, (a, keep, e) => { e.input(m); return [0, 1, 2, 3, 4, 5].map((i) => [a.btn(i), a.btnp(i)]); }); }
    else if (op === 24) { both('btn bad', (a) => { const r = []; for (const v of [6, -1, 1.5, '1', null]) { try { r.push(a.btn(v)); } catch (e) { r.push(e.message); } } return r; }); }
    else if (op === 25) { const ch = pick([0, 1, 2, 3, '0']), s = pick(['cde', 5, '']); both('play', (a, keep, e) => { a.play(ch, s); return e.sounds().length; }); }
    else {
      // a tick, then compare the picture
      const n = int(0, 6);
      const calls = Array.from({ length: n }, () => [coord(170), coord(150), str(), col()]);
      const outs = engines.map((engine) => {
        let r;
        try { r = 'ok ' + engine.step(() => { for (const c of calls) engine.api.spr(...c); }); } catch (e) { r = 'throw ' + e.message; }
        return r + ' ' + Array.from(engine.pixels).join('');
      });
      log.push('step');
      if (outs[0] !== outs[1] && !globalThis.shown) {
        globalThis.shown = 1;
        const a = outs[0].split(' ').pop(), b = outs[1].split(' ').pop();
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { const cx = (i % 160) >> 3, cy = Math.floor(i / 160) >> 3; console.log('round', round, 'first differing pixel', i % 160, Math.floor(i / 160), 'cell', cx, cy, 'chr', JSON.stringify(engines[0].api.scr[cy][cx].chr), JSON.stringify(engines[1].api.scr[cy][cx].chr), [...engines[0].api.scr[cy][cx].col], [...engines[1].api.scr[cy][cx].col], 'ref', a[i], 'fast', b[i]); break; }
        console.log(log.join('\n'));
      }
      same(outs[0].slice(0, 60), outs[1].slice(0, 60), 'frame-status', log);
      same(outs[0], outs[1], 'frame', log);
    }
  }
}
console.log(failures ? `FAILED: ${failures} mismatches` : `fuzz ok: ${rounds} rounds, engines agree`);
process.exit(failures ? 1 : 0);

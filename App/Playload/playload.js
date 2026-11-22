// Playload for Miyoo Mini - runtime glue.
// Everything above the marker lines is Playload's own engine (github.com/kitao/playload, MIT),
// pasted in unchanged by build.mjs. This file only adds what a browser would normally provide,
// and connects the engine to the native screen, buttons and sound.
(function (host) {
  // ---- Intl.Segmenter stand-in (QuickJS has no Intl). Splits text into user-perceived characters:
  // emoji with modifiers and joiners, flags, keycaps, letters with combining marks.
  const CLUSTER =
    /\r\n|[\p{Cc}\p{Zl}\p{Zp}]|\p{RI}\p{RI}|[^](?:[\p{M}\p{EMod}‌︎️\u{E0020}-\u{E007F}]|‍\p{ExtPict}?)*/gu;
  const segmentCache = new Map();
  function segmentText(text) {
    text = String(text);
    let cached = segmentCache.get(text);
    if (cached) return cached;
    const out = [];
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 127 || code === 13) {
        ascii = false;
        break;
      }
    }
    if (ascii) for (let i = 0; i < text.length; i++) out.push({ segment: text[i], index: i });
    else {
      CLUSTER.lastIndex = 0;
      let match;
      while ((match = CLUSTER.exec(text))) out.push({ segment: match[0], index: match.index });
    }
    if (text.length <= 96) {
      if (segmentCache.size >= 1024) segmentCache.delete(segmentCache.keys().next().value);
      segmentCache.set(text, out);
    }
    return out;
  }
  class Segmenter {
    segment(text) {
      return segmentText(text);
    }
  }
  const Intl = { Segmenter };
  globalThis.performance ??= { now: host.now };
  globalThis.console ??= { log: host.log, info: host.log, warn: host.log, error: host.log, debug() {} };

  const hostRender = host.render,
    hostBind = host.bind;

  const palette = [
  '#000000',
  '#55415f',
  '#646964',
  '#d77355',
  '#508cd7',
  '#64b964',
  '#e6c86e',
  '#dcf5ff',
];

// The red, green and blue values, 0–255, of a #rrggbb color.
const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

// This factory is also serialized into the game worker. Keep dependencies inside it.
function createEngine(presets = [], compileScore = (s) => s) {
  const width = 160,
    height = 144,
    columns = 20,
    lines = 18;
  const pixels = new Uint8Array(width * height),
    glitches = new Uint8Array(width * height);
  const characters = Object.create(null),
    cache = new Map(),
    patterns = new WeakMap(),
    modifiedPcg = new Set();
  const MAX_SPRITES = 128,
    SLOTS = 65536,
    cells = columns * lines;
  // one slot per character ever looked up: 8 pattern bytes and its two standard colors
  const glyphBytes = new Uint8Array(SLOTS * 8),
    glyphCols = new Uint8Array(SLOTS * 2),
    slotOfChr = new Map(),
    slotChr = [],
    presetData = new Map(),
    unmade = new Uint8Array(SLOTS),
    keyCache = new Map(),
    textCache = new Map();
  let slotCount = 0,
    unmadeCount = 0,
    bound = false;
  // the text screen: character, its slot, and two colors (-1 = use the character's own)
  const cellChr = new Array(cells).fill(' '),
    cellSlot = new Int32Array(cells),
    cellCol1 = new Int8Array(cells).fill(-1),
    cellCol2 = new Int8Array(cells).fill(-1);
  // this frame's sprites: x, y, slot, color
  const sprData = new Int32Array(MAX_SPRITES * 4);
  let sprCount = 0;
  const far = (value) => (value < -100000 ? -100000 : value > 100000 ? 100000 : value);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  // Capture before game code can replace Math.random().
  const random = Math.random;
  let held = 0,
    pressed = 0,
    pcgBytes = 0,
    firstFrame = true,
    spriteOverflow = false,
    pcgOverflow = false,
    sounds = [];
  const color = (col) => {
    if (!Number.isInteger(col) || col < 0 || col > 7) throw new RangeError('Color must be 0–7');
    return col;
  };
  const coordinate = (value) => {
    if (!Number.isFinite(value)) throw new TypeError('Coordinates must be finite numbers');
    return Math.trunc(value);
  };

  const characterKey = (chr) => {
    if (typeof chr !== 'string') throw new TypeError('Character must be a string');
    // cls() writes 360 spaces per tick. ASCII needs no Unicode normalization
    // or grapheme segmentation; keep the same newline rejection as below.
    if (chr.length === 1 && chr.charCodeAt(0) < 128 && chr !== '\r' && chr !== '\n') return chr;
    const known = keyCache.get(chr);
    if (known !== undefined) return known;
    const normalized = chr.normalize('NFC').replace(/[\ufe0e\ufe0f]/g, '');
    if (
      !normalized ||
      /[\r\n]/.test(normalized) ||
      [...segmenter.segment(normalized)].length !== 1
    ) {
      throw new TypeError('Character must contain one grapheme');
    }
    if (chr.length <= 16) {
      if (keyCache.size >= 8192) keyCache.clear();
      keyCache.set(chr, normalized);
    }
    return normalized;
  };

  const button = (id) => {
    if (!Number.isInteger(id) || id < 0 || id > 5)
      throw new RangeError('Button must be 0–5 (UDLRAB)');
    return 1 << id;
  };

  function randomNoise(range) {
    return (random() * range) | 0;
  }

  function glitch(x, y, w, h) {
    const mask = [3, 4, 6, 7][randomNoise(4)];
    for (let row = 0; row < h; row++) {
      const py = y + row;
      for (let col = 0; col < w; col++) {
        const px = x + col;
        if (randomNoise(4) && px >= 0 && px < width && py >= 0 && py < height)
          glitches[py * width + px] ^= mask;
      }
    }
  }

  function glitchSprite(x, y) {
    spriteOverflow = true;
    glitch(x + randomNoise(33) - 16, y + randomNoise(33) - 16, 8, 8);
  }

  // Character data

  function colorPair(initial, inherit = false, owner = null, mirror = null) {
    const validate = (value) => (inherit && value == null ? null : color(value));
    const values = initial.map(validate);
    const pair = new Proxy(values, {
      set(target, index, value) {
        if (index !== '0' && index !== '1') throw new RangeError('Colors have two entries');
        const next = target.slice();
        next[index] = validate(value);
        if (owner) writePcg(owner, target, next, Number(index), Number(index) + 1);
        else target[index] = next[index];
        if (mirror) mirror(target);
        return true;
      },
      deleteProperty() {
        throw new TypeError('Colors have two entries');
      },
      defineProperty() {
        throw new TypeError('Set col[0] or col[1]');
      },
    });
    return {
      enumerable: true,
      get: () => pair,
      set(value) {
        if (!Array.isArray(value) || value.length !== 2)
          throw new TypeError('Colors need [col1, col2]');
        const next = Array.from(value, validate);
        if (next.length !== 2) throw new TypeError('Colors need [col1, col2]');
        if (owner) writePcg(owner, values, next);
        else {
          values[0] = next[0];
          values[1] = next[1];
        }
        if (mirror) mirror(values);
      },
    };
  }

  // The two colors of one screen cell. Same behaviour as colorPair(..., true), but the
  // values live in cellCol so that cls() and put() need not go through 360 setters.
  function cellPair(index) {
    const validate = (value) => (value == null ? null : color(value));
    const values = [null, null];
    const sync = () => {
      const a = cellCol1[index],
        b = cellCol2[index];
      values[0] = a < 0 ? null : a;
      values[1] = b < 0 ? null : b;
    };
    const store = (i, value) => {
      values[i] = value;
      (i ? cellCol2 : cellCol1)[index] = value == null ? -1 : value;
    };
    const pair = new Proxy(values, {
      get(target, key, receiver) {
        sync();
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        sync();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, index, value) {
        if (index !== '0' && index !== '1') throw new RangeError('Colors have two entries');
        store(Number(index), validate(value));
        return true;
      },
      deleteProperty() {
        throw new TypeError('Colors have two entries');
      },
      defineProperty() {
        throw new TypeError('Set col[0] or col[1]');
      },
    });
    return {
      enumerable: true,
      get: () => pair,
      set(value) {
        if (!Array.isArray(value) || value.length !== 2)
          throw new TypeError('Colors need [col1, col2]');
        const next = Array.from(value, validate);
        if (next.length !== 2) throw new TypeError('Colors need [col1, col2]');
        store(0, next[0]);
        store(1, next[1]);
      },
    };
  }

  // Count writes, including unchanged bytes. A bulk edit uses the remaining
  // budget before dropping its excess bytes. Patterns and colors share both limits.
  // The first accepted write reserves a character for the rest of this run.
  function writePcg(owner, target, next, start = 0, end = next.length) {
    const length = Math.max(0, end - start),
      count =
        modifiedPcg.has(owner) || modifiedPcg.size < 256 ? Math.min(length, 256 - pcgBytes) : 0;
    if (count) modifiedPcg.add(owner);
    for (let i = start; i < start + count; i++) target[i] = next[i];
    pcgBytes += count;
    if (count < length) pcgOverflow = true;
    for (let i = count; i < length; i++) glitch(0, randomNoise(height), width, 1);
  }

  const integer = (value) => Math.trunc(+value) || 0;

  const arrayIndex = (value, length) => {
    const index = integer(value);
    return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
  };

  // Saved references and subarrays share the byte budget. Rendering reads the
  // private bytes directly; only the range written by each method is copied back.
  function patternView(pattern, owner, base = pattern.byteOffset) {
    const mutators = ['set', 'fill', 'copyWithin', 'reverse', 'sort'];
    const view = new Proxy(pattern, {
      get(target, key) {
        // Exposing the backing buffer would allow writes outside the budget.
        if (key === 'buffer') return target.slice().buffer;
        if (key === 'byteOffset') return target.byteOffset - base;
        if (key === 'subarray') return (...args) => patternView(target.subarray(...args), owner, base);
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function' || key === 'constructor') return value;
        return (...args) => {
          if (mutators.includes(key)) {
            const next = target.slice();
            let start = 0,
              end = target.length;
            if (key === 'set') {
              start = integer(args[1]);
              args[1] = start;
              // Let the native method validate the source and offset. Capture
              // its length once, including array-like sources with getters.
              if (args[0] != null) {
                const source = Object(args[0]);
                args[0] = new Proxy(
                  {},
                  {
                    get(_, name) {
                      const value = Reflect.get(source, name, source);
                      if (name !== 'length') return value;
                      const length = Math.min(Math.max(integer(value), 0), Number.MAX_SAFE_INTEGER);
                      end = start + length;
                      return length;
                    },
                  },
                );
              }
            } else if (key === 'fill') {
              args[0] = +args[0];
              start = arrayIndex(args[1], target.length);
              end = args[2] === undefined ? target.length : arrayIndex(args[2], target.length);
              args[1] = start;
              args[2] = end;
            } else if (key === 'copyWithin') {
              start = arrayIndex(args[0], target.length);
              const from = arrayIndex(args[1], target.length),
                to = args[2] === undefined ? target.length : arrayIndex(args[2], target.length);
              end = start + Math.max(0, Math.min(to - from, target.length - start));
              args = [start, from, to];
            }
            const result = value.apply(next, args);
            if (key === 'reverse') {
              // Reverse writes both ends of each pair, but not an odd middle byte.
              for (let i = 0; i < Math.floor(target.length / 2); i++) {
                writePcg(owner, target, next, i, i + 1);
                writePcg(owner, target, next, target.length - i - 1, target.length - i);
              }
            } else writePcg(owner, target, next, start, end);
            return result === next ? view : result;
          }
          // Array callbacks must receive the guarded view as their array argument.
          if (typeof args[0] === 'function') {
            const callback = args[0];
            args[0] = function (...values) {
              return callback.apply(
                this,
                values.map((item) => (item === target ? view : item)),
              );
            };
          }
          const result = value.apply(target, args);
          return result === target ? view : result;
        };
      },
      set(target, key, value) {
        const next = target.slice();
        const result = Reflect.set(next, key, value);
        if (result && Object.hasOwn(target, key))
          writePcg(owner, target, next, Number(key), Number(key) + 1);
        return result;
      },
      defineProperty(target, key, descriptor) {
        const next = target.slice();
        const result = Reflect.defineProperty(next, key, descriptor);
        if (result && Object.hasOwn(target, key) && Object.hasOwn(descriptor, 'value'))
          writePcg(owner, target, next, Number(key), Number(key) + 1);
        return result;
      },
    });
    return view;
  }

  class PcgElem {
    constructor(rows = new Uint8Array(8), col = [7, 0], chr) {
      const slot = slotFor(chr),
        pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8),
        owner = this;
      pattern.set(new Uint8Array(rows));
      if (unmade[slot]) {
        unmade[slot] = 0;
        unmadeCount--;
      }
      patterns.set(this, pattern);
      const view = patternView(pattern, owner);
      Object.defineProperties(this, {
        pat: {
          enumerable: true,
          get: () => view,
          set(value) {
            if (typeof value === 'string') {
              if (!/^[0-9a-f]{16}$/i.test(value))
                throw new TypeError('Pattern needs 16 hex digits');
              value = Array.from({ length: 8 }, (_, i) =>
                parseInt(value.slice(i * 2, i * 2 + 2), 16),
              );
            }
            if (!value || value.length !== 8) throw new TypeError('Pattern needs 8 row bytes');
            const next = Array.from(value);
            if (
              next.length !== 8 ||
              !next.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
            ) {
              throw new TypeError('Pattern needs 8 row bytes');
            }
            writePcg(owner, pattern, next);
          },
        },
        col: colorPair(col, false, owner, (values) => {
          glyphCols[slot * 2] = values[0];
          glyphCols[slot * 2 + 1] = values[1];
        }),
      });
      glyphCols[slot * 2] = color(col[0]);
      glyphCols[slot * 2 + 1] = color(col[1]);
      Object.preventExtensions(this);
    }
  }

  class ScrElem {
    constructor(index) {
      Object.defineProperties(this, {
        chr: {
          enumerable: true,
          get: () => cellChr[index],
          set(value) {
            const key = characterKey(value);
            cellChr[index] = key;
            cellSlot[index] = slotFor(key);
          },
        },
        col: cellPair(index),
      });
      Object.preventExtensions(this);
    }
  }

  function lookup(chr) {
    return (characters[chr] ??= new PcgElem(undefined, undefined, chr));
  }

  // The slot of a character. This does not create its PCG element: as in the original,
  // that happens when the game reads pcg[chr] or when the character is first drawn.
  function slotFor(chr) {
    let slot = slotOfChr.get(chr);
    if (slot === undefined) {
      if (slotCount >= SLOTS) throw new RangeError('Too many characters');
      slot = slotCount++;
      slotOfChr.set(chr, slot);
      slotChr[slot] = chr;
      const preset = presetData.get(chr);
      if (preset) glyphBytes.set(preset.rows, slot * 8);
      glyphCols[slot * 2] = preset ? preset.col[0] : 7;
      glyphCols[slot * 2 + 1] = preset ? preset.col[1] : 0;
      if (!(chr in characters)) {
        unmade[slot] = 1;
        unmadeCount++;
      }
    }
    return slot;
  }

  // A string as put() and spr() see it: its characters (null = new line) and their slots.
  // Only strings whose every character is valid are kept, so errors still come from the original loops.
  function textOf(str) {
    let text = textCache.get(str);
    if (text !== undefined) return text;
    const keys = [],
      at = [],
      cellKeys = [],
      cellAt = [];
    try {
      for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
        if (segment === '\n') {
          keys.push(null);
          at.push(0);
          cellKeys.push(null);
          cellAt.push(0);
        } else {
          const key = characterKey(segment);
          keys.push(key);
          at.push(slotFor(key));
          // put() hands the character to the cell's own setter, which normalizes it once more
          const cellKey = characterKey(key);
          cellKeys.push(cellKey);
          cellAt.push(slotFor(cellKey));
        }
      }
    } catch {
      return null;
    }
    text = { keys, at, cellKeys, cellAt };
    if (str.length <= 64) {
      if (textCache.size >= 2048) textCache.clear();
      textCache.set(str, text);
    }
    return text;
  }

  for (const preset of presets) {
    // Copy source data; create editable patterns lazily for each game.
    const rows = Uint8Array.from(preset.rows),
      col = [preset.ink ?? 7, preset.paper ?? 0];
    const chr = characterKey(preset.ch);
    presetData.set(chr, { rows, col });
    Object.defineProperty(characters, chr, {
      configurable: true,
      enumerable: true,
      get() {
        const element = new PcgElem(rows, col, chr);
        Object.defineProperty(characters, chr, {
          value: element,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        return element;
      },
    });
  }
  const pcg = new Proxy(characters, {
    get: (target, chr) =>
      typeof chr === 'string' ? lookup(characterKey(chr)) : Reflect.get(target, chr),
    set() {
      throw new TypeError('Set pcg[chr].pat or pcg[chr].col');
    },
    deleteProperty() {
      throw new TypeError('PCG elements cannot be deleted');
    },
    defineProperty() {
      throw new TypeError('Set pcg[chr].pat or pcg[chr].col');
    },
  });
  cellSlot.fill(slotFor(' '));
  const scr = Object.freeze(
    Array.from({ length: lines }, (_, cy) =>
      Object.freeze(Array.from({ length: columns }, (_, cx) => new ScrElem(cy * columns + cx))),
    ),
  );

  // Game API

  function cls(col) {
    col = color(col);
    cellChr.fill(' ');
    cellSlot.fill(slotFor(' '));
    cellCol1.fill(-1);
    cellCol2.fill(col);
  }

  function put(cx, cy, str, col1, col2) {
    const origin = coordinate(cx);
    cx = origin;
    cy = coordinate(cy);
    if (typeof str !== 'string') throw new TypeError('Text must be a string');
    const pair = [col1 == null ? null : color(col1), col2 == null ? null : color(col2)];

    const text = textOf(str);
    if (text) {
      const keys = text.cellKeys,
        at = text.cellAt,
        c1 = pair[0] == null ? -1 : pair[0],
        c2 = pair[1] == null ? -1 : pair[1];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === null) {
          cx = origin;
          cy++;
          continue;
        }
        if (cx >= 0 && cx < columns && cy >= 0 && cy < lines) {
          const index = cy * columns + cx;
          cellChr[index] = keys[i];
          cellSlot[index] = at[i];
          cellCol1[index] = c1;
          cellCol2[index] = c2;
        }
        cx++;
      }
      return;
    }

    // Check every character before writing, so an invalid one leaves the screen intact.
    const writes = [];
    for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
      if (segment === '\n') {
        cx = origin;
        cy++;
        continue;
      }
      const chr = characterKey(segment);
      if (cx >= 0 && cx < columns && cy >= 0 && cy < lines) writes.push(scr[cy][cx], chr);
      cx++;
    }

    for (let i = 0; i < writes.length; i += 2) {
      writes[i].chr = writes[i + 1];
      writes[i].col = pair;
    }
  }

  function spr(x, y, str, col) {
    const origin = coordinate(x);
    x = origin;
    y = coordinate(y);
    if (typeof str !== 'string') throw new TypeError('Text must be a string');
    col = color(col);

    // Keep individual ASCII, kana and emoji sprites on the existing fast path.
    if (
      (str.length === 1 || (str.length === 2 && str.codePointAt(0) > 0xffff)) &&
      str !== '\r' &&
      str !== '\n'
    ) {
      if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(str), col);
      else glitchSprite(x, y);
      return;
    }

    const text = textOf(str);
    if (text) {
      const keys = text.keys,
        at = text.at;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === null) {
          x = origin;
          y += 8;
          continue;
        }
        if (sprCount < MAX_SPRITES) {
          const base = sprCount++ * 4;
          sprData[base] = far(x);
          sprData[base + 1] = far(y);
          sprData[base + 2] = at[i];
          sprData[base + 3] = col;
        } else glitchSprite(x, y);
        x += 8;
      }
      return;
    }

    const start = sprCount;
    try {
      for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
        if (segment === '\n') {
          x = origin;
          y += 8;
          continue;
        }
        if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(segment), col);
        else glitchSprite(x, y);
        x += 8;
      }
    } catch (error) {
      sprCount = start;
      throw error;
    }
  }

  function pushSprite(x, y, chr, col) {
    const slot = slotFor(chr),
      base = sprCount++ * 4;
    sprData[base] = far(x);
    sprData[base + 1] = far(y);
    sprData[base + 2] = slot;
    sprData[base + 3] = col;
  }

  function play(ch, str) {
    if (!Number.isInteger(ch) || ch < 0 || ch > 2)
      throw new RangeError('Sound channel must be 0–2');
    if (typeof str !== 'string') throw new TypeError('Sound must be a string');
    // The player accepts 256 sounds per tick; top-level code counts with the first tick.
    if (sounds.length >= 256) throw new RangeError('A tick can play at most 256 sounds');
    if (!cache.has(str)) {
      const compiled = compileScore(str);
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(str, compiled);
    }
    sounds.push({ ch, score: cache.get(str) });
  }

  // Rasterization

  function draw(slot, x, y, col1, col2) {
    const pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8);
    for (let row = 0; row < 8; row++) {
      const py = y + row;
      if (py < 0 || py >= height) continue;
      for (let bit = 0; bit < 8; bit++) {
        const px = x + bit;
        if (px < 0 || px >= width) continue;
        if (pattern[row] & (128 >> bit)) pixels[py * width + px] = col1;
        else if (col2 >= 0) pixels[py * width + px] = col2;
      }
    }
  }

  function render() {
    if (unmadeCount) {
      for (let index = 0; index < cells && unmadeCount; index++)
        if (unmade[cellSlot[index]]) lookup(cellChr[index]);
      for (let i = 0; i < sprCount && unmadeCount; i++)
        if (unmade[sprData[i * 4 + 2]]) lookup(slotChr[sprData[i * 4 + 2]]);
    }
    if (hostRender) {
      // the arrays never move: hand them over once, then only say how many sprites there are
      if (!bound) {
        hostBind(pixels, glyphBytes, glyphCols, cellSlot, cellCol1, cellCol2, sprData, columns);
        bound = true;
      }
      hostRender(sprCount);
    } else {
      for (let index = 0; index < cells; index++) {
        const slot = cellSlot[index],
          c1 = cellCol1[index],
          c2 = cellCol2[index];
        draw(
          slot,
          (index % columns) * 8,
          Math.floor(index / columns) * 8,
          c1 < 0 ? glyphCols[slot * 2] : c1,
          c2 < 0 ? glyphCols[slot * 2 + 1] : c2,
        );
      }
      for (let i = 0; i < sprCount; i++)
        draw(sprData[i * 4 + 2], sprData[i * 4], sprData[i * 4 + 1], sprData[i * 4 + 3], -1);
    }
    if (spriteOverflow || pcgOverflow)
      for (let i = 0; i < pixels.length; i++) pixels[i] ^= glitches[i];
    return pixels;
  }

  const api = {
    cls,
    put,
    spr,
    btn: (id) => !!(held & button(id)),
    btnp: (id) => !!(pressed & button(id)),
    play,
    scr,
    pcg,
  };
  return {
    api,
    get pixels() {
      return render();
    },
    input(mask) {
      mask &= 63;
      pressed |= mask & ~held;
      held = mask;
    },
    step(tick) {
      // Setup and the first tick are drawn together and share the same budgets.
      if (!firstFrame) {
        sprCount = 0;
        if (spriteOverflow || pcgOverflow) {
          glitches.fill(0);
          spriteOverflow = pcgOverflow = false;
        }
      }
      firstFrame = false;
      try {
        tick();
      } finally {
        pressed = 0;
        // Top-level setup shares the first frame's budget, as sound commands do.
        pcgBytes = 0;
      }
      return Number(spriteOverflow) + Number(pcgOverflow);
    },
    sounds() {
      const result = sounds;
      sounds = [];
      return result;
    },
  };
}


  // ZX 128 PLAY notation. Channel selection is supplied by play(ch, str).
function compileScore(source) {
  if (source.length > 65536) throw new RangeError('Score is too long');
  const code = [],
    openings = [];
  const beats = [0, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 1 / 6, 1 / 3, 2 / 3];
  let i = 0,
    duration = 5,
    tie = 0,
    triplet = 0,
    previous = 5,
    octave = 5,
    accidental = 0;
  let lastNote = -1,
    unmatched = -1,
    unmatchedClosing = 0;

  const number = (minimum, maximum) => {
    const start = i;
    while (/\d/.test(source[i] ?? '')) i++;
    const n = Number(source.slice(start, i));
    if (i === start || n < minimum || n > maximum)
      throw new SyntaxError(`Invalid score number at ${start + 1}`);
    return n;
  };

  const repeat = (start, count) => {
    if (lastNote < start) {
      if (count === 0) throw new SyntaxError('A loop needs a note or rest');
      return -1;
    }
    return code.push({ op: 'repeat', start, count }) - 1;
  };

  while (i < source.length) {
    const c = source[i++];
    if (/\s/.test(c) || c === 'N') continue;
    if (c === '!') {
      const end = source.indexOf('!', i);
      if (end === -1) throw new SyntaxError('Unclosed score comment');
      i = end + 1;
      continue;
    }

    if (/\d/.test(c)) {
      i--;
      const n = number(1, 12);
      // A triplet length lasts three notes, then the length before it returns.
      // Another triplet keeps that length; an ordinary length ends the triplet.
      if (n >= 10) {
        if (!triplet) previous = duration;
        triplet = 3;
      } else triplet = 0;
      duration = n;
      continue;
    }
    if (c === '_') {
      tie += beats[duration];
      continue;
    }
    if (c === '#') {
      accidental++;
      continue;
    }
    if (c === '$') {
      accidental--;
      continue;
    }

    if (c === '(') {
      openings.push(code.length);
      continue;
    }
    if (c === ')') {
      if (openings.length) repeat(openings.pop(), 2);
      else if (++unmatchedClosing >= 2) {
        if (unmatched < 0) throw new SyntaxError('A loop needs a note or rest');
        code[unmatched].count = 0;
      } else unmatched = repeat(0, 2);
      continue;
    }

    if (c === 'O') {
      octave = number(0, 8);
      continue;
    }
    if ('VWXTM'.includes(c)) {
      const ranges = { V: [0, 15], W: [0, 7], X: [0, 65535], T: [60, 240], M: [1, 63] };
      code.push({ op: c, value: number(...ranges[c]) });
      continue;
    }
    if (c === 'U' || c === 'H') {
      code.push({ op: c });
      continue;
    }

    if (c === '&' || /[a-g]/i.test(c)) {
      const semitone = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[c.toLowerCase()];
      // Spectrum O5 puts lower-case c at middle C (MIDI 60).
      const midi = octave * 12 + semitone + (c !== c.toLowerCase() ? 12 : 0) + accidental;
      lastNote =
        code.push({
          op: 'note',
          frequency: c === '&' ? 0 : 440 * 2 ** ((midi - 69) / 12),
          beats: beats[duration] + tie,
        }) - 1;
      accidental = tie = 0;
      if (triplet && --triplet === 0) duration = previous;
      continue;
    }
    throw new SyntaxError(`Unknown score command ${c} at ${i}`);
  }

  while (openings.length) repeat(openings.pop(), 2);
  if (tie || accidental) throw new SyntaxError('Incomplete score note');
  if (code.length > 16384) throw new RangeError('Score has too many commands');
  return { code, fixedVolume: code.some((event) => event.op === 'V') };
}



  const glyphs = [{"ch":"©️","rows":[126,129,157,177,177,157,129,126],"ink":7,"paper":0},{"ch":"®️","rows":[126,129,185,165,185,165,129,126],"ink":7,"paper":0},{"ch":"‼️","rows":[102,102,102,102,102,0,102,0],"ink":3,"paper":0},{"ch":"⁉️","rows":[220,198,198,204,216,0,216,0],"ink":3,"paper":0},{"ch":"™️","rows":[234,78,78,74,74,0,0,0],"ink":7,"paper":0},{"ch":"ℹ️","rows":[0,0,16,0,48,16,56,0],"ink":4,"paper":0},{"ch":"↔️","rows":[0,36,102,255,255,102,36,0],"ink":7,"paper":0},{"ch":"↕️","rows":[24,60,126,24,24,126,60,24],"ink":7,"paper":0},{"ch":"↖️","rows":[240,224,240,184,28,14,4,0],"ink":7,"paper":0},{"ch":"↗️","rows":[15,7,15,29,56,112,32,0],"ink":7,"paper":0},{"ch":"↘️","rows":[0,32,112,56,29,15,7,15],"ink":7,"paper":0},{"ch":"↙️","rows":[0,4,14,28,184,240,224,240],"ink":7,"paper":0},{"ch":"⌚","rows":[126,195,211,211,219,195,195,126],"ink":7,"paper":0},{"ch":"⌛","rows":[254,68,40,16,16,40,84,254],"ink":6,"paper":0},{"ch":"⏏️","rows":[0,16,56,124,254,0,254,254],"ink":7,"paper":0},{"ch":"⏩","rows":[0,0,136,204,238,204,136,0],"ink":7,"paper":0},{"ch":"⏪","rows":[0,0,34,102,238,102,34,0],"ink":7,"paper":0},{"ch":"⏫","rows":[16,56,124,0,16,56,124,0],"ink":7,"paper":0},{"ch":"⏬","rows":[124,56,16,0,124,56,16,0],"ink":7,"paper":0},{"ch":"⏯️","rows":[0,138,202,234,250,234,202,138],"ink":7,"paper":0},{"ch":"⏸️","rows":[0,108,108,108,108,108,108,108],"ink":7,"paper":0},{"ch":"⏹️","rows":[0,254,254,254,254,254,254,254],"ink":7,"paper":0},{"ch":"⏺️","rows":[0,56,124,254,254,254,124,56],"ink":7,"paper":0},{"ch":"▪️","rows":[0,0,56,56,56,0,0,0],"ink":7,"paper":0},{"ch":"▫️","rows":[0,0,56,40,56,0,0,0],"ink":7,"paper":0},{"ch":"▶️","rows":[192,240,252,255,255,252,240,192],"ink":7,"paper":0},{"ch":"◀️","rows":[3,15,63,255,255,63,15,3],"ink":7,"paper":0},{"ch":"◻️","rows":[0,0,60,36,36,60,0,0],"ink":7,"paper":0},{"ch":"◼️","rows":[0,0,60,60,60,60,0,0],"ink":7,"paper":0},{"ch":"◽","rows":[0,0,63,49,49,63,0,0],"ink":7,"paper":0},{"ch":"◾","rows":[0,0,63,63,63,63,0,0],"ink":7,"paper":0},{"ch":"☁️","rows":[0,0,32,84,138,130,124,0],"ink":7,"paper":0},{"ch":"☂️","rows":[60,66,171,213,16,16,20,8],"ink":4,"paper":0},{"ch":"☄️","rows":[0,18,36,8,98,244,240,96],"ink":4,"paper":0},{"ch":"☎️","rows":[126,195,219,60,102,102,126,0],"ink":3,"paper":0},{"ch":"☑️","rows":[254,134,138,170,146,130,254,0],"ink":7,"paper":0},{"ch":"☕","rows":[0,188,191,189,189,191,188,120],"ink":7,"paper":0},{"ch":"☮️","rows":[0,56,84,146,186,214,84,56],"ink":7,"paper":0},{"ch":"☯️","rows":[0,126,129,177,243,255,126,0],"ink":7,"paper":0},{"ch":"☹️","rows":[126,129,165,129,153,165,129,126],"ink":6,"paper":0},{"ch":"☺️","rows":[126,129,165,129,189,153,129,126],"ink":6,"paper":0},{"ch":"♀️","rows":[60,102,102,102,60,24,126,24],"ink":7,"paper":0},{"ch":"♂️","rows":[15,7,15,125,204,204,204,120],"ink":7,"paper":0},{"ch":"♠️","rows":[16,56,124,254,254,56,124,0],"ink":7,"paper":0},{"ch":"♣️","rows":[24,24,102,102,24,24,60,0],"ink":7,"paper":0},{"ch":"♥️","rows":[108,254,254,254,124,56,16,0],"ink":3,"paper":0},{"ch":"♦️","rows":[16,56,124,254,124,56,16,0],"ink":3,"paper":0},{"ch":"⚪","rows":[0,60,102,195,195,102,60,0],"ink":7,"paper":0},{"ch":"⚫","rows":[0,60,126,255,255,126,60,0],"ink":7,"paper":0},{"ch":"⛈️","rows":[60,255,255,24,12,24,48,24],"ink":7,"paper":0},{"ch":"⛔","rows":[0,56,124,254,130,254,124,56],"ink":3,"paper":0},{"ch":"⛵","rows":[32,48,32,32,255,126,60,0],"ink":4,"paper":0},{"ch":"⛽","rows":[0,244,150,242,250,250,246,240],"ink":6,"paper":0},{"ch":"✈️","rows":[48,56,156,255,255,156,56,48],"ink":4,"paper":0},{"ch":"✴️","rows":[146,84,56,254,56,84,146,0],"ink":7,"paper":0},{"ch":"❌","rows":[0,0,68,40,16,40,68,0],"ink":3,"paper":0},{"ch":"❤️","rows":[0,102,255,255,126,60,24,0],"ink":3,"paper":0},{"ch":"⭕","rows":[60,126,231,195,195,231,126,60],"ink":3,"paper":0},{"ch":"🌍","rows":[0,56,92,190,186,146,68,56],"ink":4,"paper":0},{"ch":"🌲","rows":[16,16,56,56,124,124,254,56],"ink":5,"paper":0},{"ch":"🌳","rows":[56,122,254,254,108,24,24,60],"ink":5,"paper":0},{"ch":"🌴","rows":[0,112,252,158,54,100,96,96],"ink":5,"paper":0},{"ch":"🍄","rows":[60,110,251,191,255,60,60,60],"ink":3,"paper":0},{"ch":"🍅","rows":[108,56,124,158,190,254,124,0],"ink":3,"paper":0},{"ch":"🍎","rows":[8,16,108,254,252,252,126,108],"ink":3,"paper":0},{"ch":"🍏","rows":[8,16,108,130,132,132,82,108],"ink":5,"paper":0},{"ch":"🍵","rows":[0,0,246,246,234,226,124,56],"ink":5,"paper":0},{"ch":"🍺","rows":[84,252,215,173,253,215,172,120],"ink":6,"paper":0},{"ch":"🍾","rows":[56,24,24,24,60,124,56,0],"ink":5,"paper":0},{"ch":"🎧","rows":[0,56,68,130,130,238,108,108],"ink":4,"paper":0},{"ch":"🏆","rows":[0,254,186,124,56,16,56,124],"ink":6,"paper":0},{"ch":"🏎️","rows":[186,238,170,56,56,186,254,186],"ink":6,"paper":0},{"ch":"🏐","rows":[60,114,122,126,126,94,60,0],"ink":7,"paper":0},{"ch":"🏠","rows":[0,16,56,124,254,68,68,124],"ink":6,"paper":0},{"ch":"🏰","rows":[12,8,170,254,124,108,108,16],"ink":7,"paper":0},{"ch":"🐇","rows":[76,48,60,54,60,127,249,252],"ink":7,"paper":0},{"ch":"🐈","rows":[18,30,30,12,30,63,191,94],"ink":6,"paper":0},{"ch":"🐍","rows":[0,192,200,84,84,85,34,0],"ink":5,"paper":0},{"ch":"🐙","rows":[24,60,60,24,124,146,164,0],"ink":4,"paper":0},{"ch":"🐟","rows":[0,48,88,253,255,121,48,0],"ink":4,"paper":0},{"ch":"🐪","rows":[2,51,122,254,184,136,136,204],"ink":3,"paper":0},{"ch":"👻","rows":[60,66,165,129,153,129,213,170],"ink":7,"paper":0},{"ch":"👽","rows":[0,56,124,84,84,124,56,16],"ink":7,"paper":0},{"ch":"👾","rows":[24,60,126,219,255,90,129,66],"ink":4,"paper":0},{"ch":"💀","rows":[124,254,254,146,238,124,40,56],"ink":7,"paper":0},{"ch":"💍","rows":[0,124,130,130,186,108,56,0],"ink":7,"paper":0},{"ch":"💎","rows":[16,56,124,130,124,56,16,0],"ink":4,"paper":0},{"ch":"💧","rows":[16,16,56,56,124,124,116,56],"ink":4,"paper":0},{"ch":"💭","rows":[0,82,52,6,96,44,74,0],"ink":7,"paper":0},{"ch":"💰","rows":[124,56,100,222,142,222,130,124],"ink":6,"paper":0},{"ch":"💾","rows":[254,236,198,238,254,238,238,254],"ink":2,"paper":0},{"ch":"📁","rows":[112,252,130,130,130,130,254,0],"ink":4,"paper":0},{"ch":"📂","rows":[0,28,0,254,192,190,126,252],"ink":4,"paper":0},{"ch":"📄","rows":[248,140,142,130,130,130,254,0],"ink":7,"paper":0},{"ch":"📊","rows":[0,254,250,186,186,170,170,170],"ink":7,"paper":0},{"ch":"📜","rows":[248,204,124,108,124,102,62,0],"ink":6,"paper":0},{"ch":"📞","rows":[0,96,224,192,96,54,30,12],"ink":7,"paper":0},{"ch":"📤","rows":[0,16,56,84,16,146,130,254],"ink":3,"paper":0},{"ch":"📥","rows":[0,16,16,84,56,146,130,254],"ink":3,"paper":0},{"ch":"📧","rows":[0,0,254,198,170,146,130,254],"ink":7,"paper":0},{"ch":"📻","rows":[64,64,72,254,250,246,254,0],"ink":7,"paper":0},{"ch":"🔔","rows":[24,60,60,60,126,16,56,16],"ink":6,"paper":0},{"ch":"🔗","rows":[0,14,230,138,144,164,132,252],"ink":2,"paper":0},{"ch":"🔫","rows":[0,132,254,254,46,22,6,0],"ink":5,"paper":0},{"ch":"🔮","rows":[60,66,74,66,66,60,66,195],"ink":4,"paper":0},{"ch":"🔰","rows":[0,68,174,158,158,158,92,56],"ink":5,"paper":0},{"ch":"🕴️","rows":[56,56,124,40,124,124,40,238],"ink":2,"paper":0},{"ch":"🕷️","rows":[16,214,56,214,56,68,198,40],"ink":7,"paper":0},{"ch":"🖤","rows":[0,68,238,254,254,124,56,16],"ink":7,"paper":0},{"ch":"🖨️","rows":[120,68,68,68,254,131,254,0],"ink":4,"paper":0},{"ch":"🗑️","rows":[124,254,130,170,170,170,130,254],"ink":7,"paper":0},{"ch":"🗨️","rows":[0,124,130,130,130,116,10,6],"ink":4,"paper":0},{"ch":"🚍","rows":[192,192,192,255,62,28,124,220],"ink":2,"paper":0},{"ch":"🚗","rows":[0,56,68,130,254,186,254,68],"ink":3,"paper":0},{"ch":"🚩","rows":[0,176,188,190,188,176,128,128],"ink":3,"paper":0},{"ch":"🚬","rows":[0,12,24,12,6,0,250,250],"ink":7,"paper":0},{"ch":"🚹","rows":[0,56,56,0,124,124,56,16],"ink":7,"paper":0},{"ch":"🚺","rows":[0,56,56,0,16,56,124,124],"ink":7,"paper":0},{"ch":"🛖","rows":[0,0,56,124,254,108,108,0],"ink":6,"paper":0},{"ch":"🛸","rows":[0,0,56,84,254,0,0,0],"ink":6,"paper":0},{"ch":"🤖","rows":[0,40,16,124,214,254,68,124],"ink":4,"paper":0},{"ch":"🥥","rows":[0,56,124,246,254,234,124,56],"ink":3,"paper":0},{"ch":"🦆","rows":[129,126,201,118,255,255,189,102],"ink":3,"paper":0},{"ch":"🦋","rows":[129,195,255,24,255,231,195,129],"ink":4,"paper":0},{"ch":"🧲","rows":[60,126,195,195,195,102,102,0],"ink":3,"paper":0},{"ch":"🪐","rows":[0,24,124,189,126,24,0,0],"ink":6,"paper":0},{"ch":"🪓","rows":[90,126,126,90,24,24,24,0],"ink":6,"paper":0},{"ch":"🪙","rows":[56,108,206,238,238,108,56,0],"ink":6,"paper":0},{"ch":"🪜","rows":[255,66,126,66,126,66,126,66],"ink":3,"paper":0},{"ch":"🪦","rows":[56,124,254,254,254,254,250,0],"ink":7,"paper":0},{"ch":"🪧","rows":[24,126,102,126,24,24,60,0],"ink":7,"paper":0},{"ch":"🪨","rows":[56,124,254,254,246,250,84,56],"ink":7,"paper":0},{"ch":"⬆","rows":[0,16,56,124,254,56,56,56],"ink":null,"paper":null},{"ch":"⬇","rows":[0,56,56,56,254,124,56,16],"ink":null,"paper":null},{"ch":"⬅","rows":[0,16,48,126,254,126,48,16],"ink":null,"paper":null},{"ch":"➡","rows":[0,16,24,252,254,252,24,16],"ink":null,"paper":null},{"ch":"Ⓐ","rows":[0,56,108,214,198,214,84,56],"ink":null,"paper":null},{"ch":"Ⓑ","rows":[0,56,76,214,206,214,76,56],"ink":null,"paper":null},{"ch":" ","rows":[0,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"!","rows":[0,48,120,120,120,48,0,48],"ink":null,"paper":null},{"ch":"\"","rows":[0,108,108,36,72,0,0,0],"ink":null,"paper":null},{"ch":"#","rows":[0,108,254,108,108,108,254,108],"ink":null,"paper":null},{"ch":"$","rows":[0,16,126,208,124,22,252,16],"ink":null,"paper":null},{"ch":"%","rows":[0,66,166,76,24,52,106,196],"ink":null,"paper":null},{"ch":"&","rows":[0,112,216,112,218,206,198,124],"ink":null,"paper":null},{"ch":"'","rows":[0,48,48,16,32,0,0,0],"ink":null,"paper":null},{"ch":"(","rows":[0,28,48,96,96,96,48,28],"ink":null,"paper":null},{"ch":")","rows":[0,112,24,12,12,12,24,112],"ink":null,"paper":null},{"ch":"*","rows":[0,108,56,108,0,0,0,0],"ink":null,"paper":null},{"ch":"+","rows":[0,0,0,16,16,124,16,16],"ink":null,"paper":null},{"ch":",","rows":[0,0,0,0,48,48,16,32],"ink":null,"paper":null},{"ch":"-","rows":[0,0,0,0,0,124,0,0],"ink":null,"paper":null},{"ch":".","rows":[0,0,0,0,0,0,48,48],"ink":null,"paper":null},{"ch":"/","rows":[0,4,12,24,48,96,192,128],"ink":null,"paper":null},{"ch":":","rows":[0,0,0,48,48,0,48,48],"ink":null,"paper":null},{"ch":";","rows":[0,0,0,48,48,0,48,16],"ink":null,"paper":null},{"ch":"<","rows":[0,0,0,28,56,112,56,28],"ink":null,"paper":null},{"ch":"=","rows":[0,0,0,0,124,0,124,0],"ink":null,"paper":null},{"ch":">","rows":[0,0,0,112,56,28,56,112],"ink":null,"paper":null},{"ch":"?","rows":[0,124,198,6,60,48,0,48],"ink":null,"paper":null},{"ch":"@","rows":[0,124,198,214,214,220,192,124],"ink":null,"paper":null},{"ch":"[","rows":[0,124,96,96,96,96,96,124],"ink":null,"paper":null},{"ch":"\\","rows":[0,64,96,48,24,12,6,2],"ink":null,"paper":null},{"ch":"]","rows":[0,124,12,12,12,12,12,124],"ink":null,"paper":null},{"ch":"^","rows":[0,16,56,108,198,0,0,0],"ink":null,"paper":null},{"ch":"_","rows":[0,0,0,0,0,0,0,254],"ink":null,"paper":null},{"ch":"`","rows":[0,32,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"{","rows":[0,28,48,48,112,48,48,28],"ink":null,"paper":null},{"ch":"|","rows":[0,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"}","rows":[0,112,24,24,28,24,24,112],"ink":null,"paper":null},{"ch":"~","rows":[0,0,0,0,118,214,220,0],"ink":null,"paper":null},{"ch":" ","rows":[0,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"¡","rows":[0,48,0,48,120,120,120,48],"ink":null,"paper":null},{"ch":"¢","rows":[0,24,126,216,216,126,24,0],"ink":null,"paper":null},{"ch":"£","rows":[56,108,96,240,96,102,252,0],"ink":null,"paper":null},{"ch":"¤","rows":[102,60,102,60,102,0,0,0],"ink":null,"paper":null},{"ch":"¥","rows":[195,102,60,24,60,24,24,0],"ink":null,"paper":null},{"ch":"¦","rows":[24,24,24,0,24,24,24,0],"ink":null,"paper":null},{"ch":"§","rows":[0,120,192,252,198,126,6,60],"ink":null,"paper":null},{"ch":"¨","rows":[102,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"«","rows":[0,0,0,54,108,216,108,54],"ink":null,"paper":null},{"ch":"¬","rows":[0,126,6,6,0,0,0,0],"ink":null,"paper":null},{"ch":"­","rows":[0,0,0,60,0,0,0,0],"ink":null,"paper":null},{"ch":"¯","rows":[126,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"°","rows":[60,102,60,0,0,0,0,0],"ink":null,"paper":null},{"ch":"±","rows":[24,24,126,24,24,0,126,0],"ink":null,"paper":null},{"ch":"²","rows":[0,124,198,28,48,126,0,0],"ink":null,"paper":null},{"ch":"³","rows":[0,124,198,28,198,124,0,0],"ink":null,"paper":null},{"ch":"´","rows":[12,24,48,0,0,0,0,0],"ink":null,"paper":null},{"ch":"¶","rows":[0,62,116,244,116,52,20,20],"ink":null,"paper":null},{"ch":"·","rows":[0,0,0,0,16,0,0,0],"ink":null,"paper":null},{"ch":"¸","rows":[0,0,0,0,0,0,8,24],"ink":null,"paper":null},{"ch":"¹","rows":[0,120,24,24,24,126,0,0],"ink":null,"paper":null},{"ch":"»","rows":[0,0,0,216,108,54,108,216],"ink":null,"paper":null},{"ch":"¼","rows":[0,64,192,74,74,238,2,2],"ink":null,"paper":null},{"ch":"½","rows":[0,64,192,76,66,228,8,14],"ink":null,"paper":null},{"ch":"¾","rows":[0,192,32,74,42,206,2,2],"ink":null,"paper":null},{"ch":"¿","rows":[0,24,0,24,120,192,198,124],"ink":null,"paper":null},{"ch":"×","rows":[0,198,108,56,108,198,0,0],"ink":null,"paper":null},{"ch":"÷","rows":[24,24,0,126,0,24,24,0],"ink":null,"paper":null},{"ch":"˂","rows":[0,12,24,48,96,48,24,12],"ink":null,"paper":null},{"ch":"˃","rows":[0,96,48,24,12,24,48,96],"ink":null,"paper":null},{"ch":"˄","rows":[0,0,16,56,108,198,130,0],"ink":null,"paper":null},{"ch":"˅","rows":[0,0,130,198,108,56,16,0],"ink":null,"paper":null},{"ch":"˘","rows":[0,40,56,0,0,0,0,0],"ink":null,"paper":null},{"ch":"˙","rows":[0,16,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"˚","rows":[0,56,40,56,0,0,0,0],"ink":null,"paper":null},{"ch":"˛","rows":[0,0,0,0,0,0,4,2],"ink":null,"paper":null},{"ch":"˜","rows":[254,100,152,0,0,0,0,0],"ink":null,"paper":null},{"ch":"˝","rows":[0,54,108,0,0,0,0,0],"ink":null,"paper":null},{"ch":"˭","rows":[0,124,0,124,0,0,0,0],"ink":null,"paper":null},{"ch":"˽","rows":[0,0,0,0,0,0,68,124],"ink":null,"paper":null},{"ch":"͵","rows":[0,0,0,0,0,0,8,16],"ink":null,"paper":null},{"ch":"΄","rows":[0,8,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"΅","rows":[0,16,84,0,0,0,0,0],"ink":null,"paper":null},{"ch":"϶","rows":[0,0,0,252,6,62,6,252],"ink":null,"paper":null},{"ch":"҂","rows":[0,2,22,12,90,48,104,64],"ink":null,"paper":null},{"ch":"֏","rows":[0,120,204,204,30,12,30,12],"ink":null,"paper":null},{"ch":"฿","rows":[0,16,252,214,252,214,252,16],"ink":null,"paper":null},{"ch":"៛","rows":[0,12,24,126,24,88,152,112],"ink":null,"paper":null},{"ch":"–","rows":[0,0,0,0,0,124,0,0],"ink":null,"paper":null},{"ch":"—","rows":[0,0,0,0,0,254,0,0],"ink":null,"paper":null},{"ch":"―","rows":[0,0,0,0,0,254,0,0],"ink":null,"paper":null},{"ch":"‗","rows":[0,0,0,0,0,0,0,254],"ink":null,"paper":null},{"ch":"‘","rows":[0,16,32,48,48,0,0,0],"ink":null,"paper":null},{"ch":"’","rows":[0,48,48,16,32,0,0,0],"ink":null,"paper":null},{"ch":"‚","rows":[0,0,0,0,48,48,16,32],"ink":null,"paper":null},{"ch":"‛","rows":[0,48,48,32,16,0,0,0],"ink":null,"paper":null},{"ch":"“","rows":[0,36,72,108,108,0,0,0],"ink":null,"paper":null},{"ch":"”","rows":[0,108,108,36,72,0,0,0],"ink":null,"paper":null},{"ch":"„","rows":[0,0,0,0,108,108,36,72],"ink":null,"paper":null},{"ch":"†","rows":[0,16,16,254,16,16,16,16],"ink":null,"paper":null},{"ch":"‡","rows":[0,16,16,254,16,254,16,16],"ink":null,"paper":null},{"ch":"•","rows":[0,0,0,0,56,56,56,0],"ink":null,"paper":null},{"ch":"…","rows":[0,0,0,0,0,0,0,84],"ink":null,"paper":null},{"ch":"‰","rows":[0,70,172,88,48,106,202,138],"ink":null,"paper":null},{"ch":"′","rows":[0,48,48,16,32,0,0,0],"ink":null,"paper":null},{"ch":"″","rows":[0,108,108,36,72,0,0,0],"ink":null,"paper":null},{"ch":"‹","rows":[0,0,0,28,48,96,48,28],"ink":null,"paper":null},{"ch":"›","rows":[0,0,0,112,24,12,24,112],"ink":null,"paper":null},{"ch":"‾","rows":[0,254,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⁄","rows":[0,6,12,24,48,96,192,0],"ink":null,"paper":null},{"ch":"⁒","rows":[0,0,68,76,24,48,100,68],"ink":null,"paper":null},{"ch":"⁺","rows":[24,24,126,24,24,0,0,0],"ink":null,"paper":null},{"ch":"⁻","rows":[0,126,126,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⁼","rows":[126,126,0,126,126,0,0,0],"ink":null,"paper":null},{"ch":"₠","rows":[0,112,192,222,216,124,24,30],"ink":null,"paper":null},{"ch":"₢","rows":[0,124,198,192,220,208,214,124],"ink":null,"paper":null},{"ch":"₣","rows":[0,126,96,96,124,96,240,96],"ink":null,"paper":null},{"ch":"₤","rows":[0,60,102,250,96,248,96,254],"ink":null,"paper":null},{"ch":"₧","rows":[248,204,204,250,198,207,198,199],"ink":null,"paper":null},{"ch":"₨","rows":[0,224,144,150,232,164,146,148],"ink":null,"paper":null},{"ch":"₩","rows":[0,68,254,68,84,124,108,68],"ink":null,"paper":null},{"ch":"₪","rows":[0,242,138,170,170,170,162,188],"ink":null,"paper":null},{"ch":"₫","rows":[0,14,4,124,196,124,0,126],"ink":null,"paper":null},{"ch":"€","rows":[62,96,252,96,248,96,62,0],"ink":null,"paper":null},{"ch":"₭","rows":[0,102,108,120,254,120,108,102],"ink":null,"paper":null},{"ch":"₮","rows":[0,126,24,60,24,60,24,24],"ink":null,"paper":null},{"ch":"₱","rows":[0,120,254,108,254,120,96,96],"ink":null,"paper":null},{"ch":"₲","rows":[0,16,126,208,222,214,126,16],"ink":null,"paper":null},{"ch":"₳","rows":[0,16,56,108,254,108,254,108],"ink":null,"paper":null},{"ch":"₴","rows":[0,56,76,4,254,64,100,56],"ink":null,"paper":null},{"ch":"₵","rows":[0,16,124,214,208,214,124,16],"ink":null,"paper":null},{"ch":"₸","rows":[0,126,0,126,24,24,24,24],"ink":null,"paper":null},{"ch":"₹","rows":[0,126,24,126,24,112,56,28],"ink":null,"paper":null},{"ch":"₺","rows":[0,96,240,96,246,102,102,60],"ink":null,"paper":null},{"ch":"₼","rows":[0,16,56,84,146,146,146,146],"ink":null,"paper":null},{"ch":"₽","rows":[0,124,102,102,252,96,252,96],"ink":null,"paper":null},{"ch":"₾","rows":[0,40,124,170,130,128,64,254],"ink":null,"paper":null},{"ch":"₿","rows":[0,40,252,102,124,102,252,40],"ink":null,"paper":null},{"ch":"⃀","rows":[0,124,198,192,198,124,0,254],"ink":null,"paper":null},{"ch":"℃","rows":[0,68,170,72,8,8,10,4],"ink":null,"paper":null},{"ch":"℅","rows":[0,66,134,76,24,52,106,196],"ink":null,"paper":null},{"ch":"℉","rows":[0,78,168,72,14,8,8,8],"ink":null,"paper":null},{"ch":"№","rows":[0,144,144,208,182,150,144,150],"ink":null,"paper":null},{"ch":"℗","rows":[126,129,185,165,185,161,129,126],"ink":null,"paper":null},{"ch":"℠","rows":[106,142,78,42,202,0,0,0],"ink":null,"paper":null},{"ch":"℮","rows":[0,124,198,198,254,192,192,124],"ink":null,"paper":null},{"ch":"⅍","rows":[0,64,160,230,168,174,2,12],"ink":null,"paper":null},{"ch":"⅛","rows":[0,64,192,68,74,228,10,4],"ink":null,"paper":null},{"ch":"⅜","rows":[0,192,32,68,42,196,10,4],"ink":null,"paper":null},{"ch":"⅝","rows":[0,224,128,228,42,196,10,4],"ink":null,"paper":null},{"ch":"⅞","rows":[0,224,32,68,74,68,10,4],"ink":null,"paper":null},{"ch":"←","rows":[0,16,48,127,127,48,16,0],"ink":null,"paper":null},{"ch":"↑","rows":[24,60,126,24,24,24,24,24],"ink":null,"paper":null},{"ch":"→","rows":[0,8,12,254,254,12,8,0],"ink":null,"paper":null},{"ch":"↓","rows":[24,24,24,24,24,126,60,24],"ink":null,"paper":null},{"ch":"↥","rows":[24,60,126,24,24,24,24,255],"ink":null,"paper":null},{"ch":"↨","rows":[24,60,126,24,126,60,24,255],"ink":null,"paper":null},{"ch":"↲","rows":[6,6,38,102,254,96,32,0],"ink":null,"paper":null},{"ch":"↼","rows":[0,16,48,127,127,0,0,0],"ink":null,"paper":null},{"ch":"↽","rows":[0,0,0,127,127,48,16,0],"ink":null,"paper":null},{"ch":"↾","rows":[24,28,30,24,24,24,24,24],"ink":null,"paper":null},{"ch":"↿","rows":[24,56,120,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⇀","rows":[0,8,12,254,254,0,0,0],"ink":null,"paper":null},{"ch":"⇁","rows":[0,0,0,254,254,12,8,0],"ink":null,"paper":null},{"ch":"⇂","rows":[24,24,24,24,24,30,28,24],"ink":null,"paper":null},{"ch":"⇃","rows":[24,24,24,24,24,120,56,24],"ink":null,"paper":null},{"ch":"⇦","rows":[24,56,111,193,193,111,56,24],"ink":null,"paper":null},{"ch":"⇧","rows":[24,60,102,195,231,36,36,60],"ink":null,"paper":null},{"ch":"⇨","rows":[24,28,246,131,131,246,28,24],"ink":null,"paper":null},{"ch":"⇩","rows":[60,36,36,231,195,102,60,24],"ink":null,"paper":null},{"ch":"∂","rows":[0,56,108,6,118,204,156,120],"ink":null,"paper":null},{"ch":"∅","rows":[6,12,126,219,219,126,96,192],"ink":null,"paper":null},{"ch":"∆","rows":[0,16,56,76,76,134,134,254],"ink":null,"paper":null},{"ch":"∏","rows":[0,254,198,198,198,198,198,198],"ink":null,"paper":null},{"ch":"∑","rows":[0,254,96,48,24,48,96,254],"ink":null,"paper":null},{"ch":"−","rows":[0,0,0,126,0,0,0,0],"ink":null,"paper":null},{"ch":"∓","rows":[126,0,24,24,126,24,24,0],"ink":null,"paper":null},{"ch":"∔","rows":[24,0,24,24,126,24,24,0],"ink":null,"paper":null},{"ch":"∕","rows":[0,6,12,24,48,96,192,0],"ink":null,"paper":null},{"ch":"∘","rows":[0,0,60,102,102,60,0,0],"ink":null,"paper":null},{"ch":"∙","rows":[0,0,0,0,0,16,0,0],"ink":null,"paper":null},{"ch":"√","rows":[1,3,6,140,216,112,32,0],"ink":null,"paper":null},{"ch":"∛","rows":[96,17,35,22,108,216,112,32],"ink":null,"paper":null},{"ch":"∜","rows":[32,97,163,246,44,216,112,32],"ink":null,"paper":null},{"ch":"∞","rows":[0,0,118,219,219,110,0,0],"ink":null,"paper":null},{"ch":"∟","rows":[0,0,192,192,192,254,0,0],"ink":null,"paper":null},{"ch":"∠","rows":[0,0,0,12,24,48,96,254],"ink":null,"paper":null},{"ch":"∩","rows":[60,102,102,102,102,102,102,0],"ink":null,"paper":null},{"ch":"∫","rows":[0,14,22,16,16,16,208,224],"ink":null,"paper":null},{"ch":"≈","rows":[0,118,220,0,118,220,0,0],"ink":null,"paper":null},{"ch":"≠","rows":[0,0,0,8,124,16,124,32],"ink":null,"paper":null},{"ch":"≡","rows":[0,126,0,126,0,126,0,0],"ink":null,"paper":null},{"ch":"≣","rows":[0,124,0,124,0,124,0,124],"ink":null,"paper":null},{"ch":"≤","rows":[12,24,48,24,12,0,126,0],"ink":null,"paper":null},{"ch":"≥","rows":[48,24,12,24,48,0,126,0],"ink":null,"paper":null},{"ch":"⋅","rows":[0,0,24,24,0,0,0,0],"ink":null,"paper":null},{"ch":"⌁","rows":[0,0,32,80,136,5,2,0],"ink":null,"paper":null},{"ch":"⌂","rows":[0,16,40,68,68,68,68,124],"ink":null,"paper":null},{"ch":"⌐","rows":[0,0,0,0,124,96,96,0],"ink":null,"paper":null},{"ch":"⌖","rows":[0,16,56,84,254,84,56,16],"ink":null,"paper":null},{"ch":"⌗","rows":[0,0,40,124,40,124,40,0],"ink":null,"paper":null},{"ch":"⌘","rows":[68,170,124,40,124,170,68,0],"ink":null,"paper":null},{"ch":"⌙","rows":[0,0,0,0,96,96,124,0],"ink":null,"paper":null},{"ch":"⌠","rows":[14,27,27,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⌡","rows":[24,24,24,24,24,216,216,112],"ink":null,"paper":null},{"ch":"⌦","rows":[0,0,252,170,146,170,252,0],"ink":null,"paper":null},{"ch":"⌧","rows":[0,0,254,170,146,170,254,0],"ink":null,"paper":null},{"ch":"⌫","rows":[0,0,126,170,146,170,126,0],"ink":null,"paper":null},{"ch":"⎛","rows":[12,24,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"⎜","rows":[48,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"⎝","rows":[48,48,48,48,48,24,12,0],"ink":null,"paper":null},{"ch":"⎞","rows":[48,24,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"⎟","rows":[12,12,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"⎠","rows":[12,12,12,12,12,24,48,0],"ink":null,"paper":null},{"ch":"⎡","rows":[60,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"⎢","rows":[48,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"⎣","rows":[48,48,48,48,48,48,60,0],"ink":null,"paper":null},{"ch":"⎤","rows":[60,12,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"⎥","rows":[12,12,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"⎦","rows":[12,12,12,12,12,12,60,0],"ink":null,"paper":null},{"ch":"⎧","rows":[14,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⎨","rows":[24,24,48,224,224,48,24,24],"ink":null,"paper":null},{"ch":"⎩","rows":[24,24,24,24,24,24,14,0],"ink":null,"paper":null},{"ch":"⎪","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⎫","rows":[112,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⎬","rows":[24,24,12,7,7,12,24,24],"ink":null,"paper":null},{"ch":"⎭","rows":[24,24,24,24,24,24,112,0],"ink":null,"paper":null},{"ch":"⎮","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⎯","rows":[0,0,0,255,255,0,0,0],"ink":null,"paper":null},{"ch":"⎲","rows":[254,192,192,96,48,24,12,6],"ink":null,"paper":null},{"ch":"⎳","rows":[6,12,24,48,96,192,255,0],"ink":null,"paper":null},{"ch":"⎷","rows":[3,3,3,6,54,30,12,0],"ink":null,"paper":null},{"ch":"⎸","rows":[192,192,192,192,192,192,192,192],"ink":null,"paper":null},{"ch":"⎹","rows":[3,3,3,3,3,3,3,3],"ink":null,"paper":null},{"ch":"⎺","rows":[255,255,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⎻","rows":[0,0,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"⎼","rows":[0,0,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"⎽","rows":[0,0,0,0,0,255,255,0],"ink":null,"paper":null},{"ch":"⏐","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"⏚","rows":[0,255,0,126,0,60,0,24],"ink":null,"paper":null},{"ch":"⏴","rows":[0,12,28,60,124,60,28,12],"ink":null,"paper":null},{"ch":"⏵","rows":[0,96,112,120,124,120,112,96],"ink":null,"paper":null},{"ch":"⏶","rows":[0,0,16,56,124,254,254,0],"ink":null,"paper":null},{"ch":"⏷","rows":[0,0,254,254,124,56,16,0],"ink":null,"paper":null},{"ch":"⏻","rows":[0,16,84,214,146,130,198,124],"ink":null,"paper":null},{"ch":"⏼","rows":[0,124,198,146,146,146,198,124],"ink":null,"paper":null},{"ch":"─","rows":[0,0,0,255,255,0,0,0],"ink":null,"paper":null},{"ch":"━","rows":[0,0,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"│","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"┃","rows":[60,60,60,60,60,60,60,60],"ink":null,"paper":null},{"ch":"┄","rows":[0,0,0,221,221,0,0,0],"ink":null,"paper":null},{"ch":"┅","rows":[0,0,221,221,221,221,0,0],"ink":null,"paper":null},{"ch":"┆","rows":[24,24,0,24,24,24,0,24],"ink":null,"paper":null},{"ch":"┇","rows":[60,60,0,60,60,60,0,60],"ink":null,"paper":null},{"ch":"┈","rows":[0,0,0,170,170,0,0,0],"ink":null,"paper":null},{"ch":"┉","rows":[0,0,0,170,170,0,0,0],"ink":null,"paper":null},{"ch":"┊","rows":[24,0,24,0,24,0,24,0],"ink":null,"paper":null},{"ch":"┋","rows":[60,0,60,0,60,0,60,0],"ink":null,"paper":null},{"ch":"┌","rows":[0,0,0,31,31,24,24,24],"ink":null,"paper":null},{"ch":"┍","rows":[0,0,31,31,31,31,24,24],"ink":null,"paper":null},{"ch":"┎","rows":[0,0,0,63,63,60,60,60],"ink":null,"paper":null},{"ch":"┏","rows":[0,0,63,63,63,63,60,60],"ink":null,"paper":null},{"ch":"┐","rows":[0,0,0,248,248,24,24,24],"ink":null,"paper":null},{"ch":"┑","rows":[0,0,248,248,248,248,24,24],"ink":null,"paper":null},{"ch":"┒","rows":[0,0,0,252,252,60,60,60],"ink":null,"paper":null},{"ch":"┓","rows":[0,0,252,252,252,252,60,60],"ink":null,"paper":null},{"ch":"└","rows":[24,24,24,31,31,0,0,0],"ink":null,"paper":null},{"ch":"┕","rows":[24,24,31,31,31,31,0,0],"ink":null,"paper":null},{"ch":"┖","rows":[60,60,60,63,63,0,0,0],"ink":null,"paper":null},{"ch":"┗","rows":[60,60,63,63,63,63,0,0],"ink":null,"paper":null},{"ch":"┘","rows":[24,24,24,248,248,0,0,0],"ink":null,"paper":null},{"ch":"┙","rows":[24,24,248,248,248,248,0,0],"ink":null,"paper":null},{"ch":"┚","rows":[60,60,60,252,252,0,0,0],"ink":null,"paper":null},{"ch":"┛","rows":[60,60,252,252,252,252,0,0],"ink":null,"paper":null},{"ch":"├","rows":[24,24,24,31,31,24,24,24],"ink":null,"paper":null},{"ch":"┝","rows":[24,24,31,31,31,31,24,24],"ink":null,"paper":null},{"ch":"┞","rows":[60,60,60,63,31,24,24,24],"ink":null,"paper":null},{"ch":"┟","rows":[24,24,31,31,63,63,60,60],"ink":null,"paper":null},{"ch":"┠","rows":[60,60,60,63,63,60,60,60],"ink":null,"paper":null},{"ch":"┡","rows":[60,60,63,63,31,31,24,24],"ink":null,"paper":null},{"ch":"┢","rows":[24,24,24,31,63,60,60,60],"ink":null,"paper":null},{"ch":"┣","rows":[60,60,63,63,63,63,60,60],"ink":null,"paper":null},{"ch":"┤","rows":[24,24,24,248,248,24,24,24],"ink":null,"paper":null},{"ch":"┥","rows":[24,24,248,248,248,248,24,24],"ink":null,"paper":null},{"ch":"┦","rows":[60,60,60,252,248,24,24,24],"ink":null,"paper":null},{"ch":"┧","rows":[24,24,248,248,252,252,60,60],"ink":null,"paper":null},{"ch":"┨","rows":[60,60,60,252,252,60,60,60],"ink":null,"paper":null},{"ch":"┩","rows":[60,60,252,252,248,248,24,24],"ink":null,"paper":null},{"ch":"┪","rows":[24,24,24,248,252,60,60,60],"ink":null,"paper":null},{"ch":"┫","rows":[60,60,252,252,252,252,60,60],"ink":null,"paper":null},{"ch":"┬","rows":[0,0,0,255,255,24,24,24],"ink":null,"paper":null},{"ch":"┭","rows":[0,0,240,255,255,248,24,24],"ink":null,"paper":null},{"ch":"┮","rows":[0,0,15,255,255,31,24,24],"ink":null,"paper":null},{"ch":"┯","rows":[0,0,255,255,255,255,24,24],"ink":null,"paper":null},{"ch":"┰","rows":[0,0,0,255,255,60,60,60],"ink":null,"paper":null},{"ch":"┱","rows":[0,0,240,255,255,252,60,60],"ink":null,"paper":null},{"ch":"┲","rows":[0,0,15,255,255,63,60,60],"ink":null,"paper":null},{"ch":"┳","rows":[0,0,255,255,255,255,60,60],"ink":null,"paper":null},{"ch":"┴","rows":[24,24,24,255,255,0,0,0],"ink":null,"paper":null},{"ch":"┵","rows":[24,24,248,255,255,240,0,0],"ink":null,"paper":null},{"ch":"┶","rows":[24,24,31,255,255,15,0,0],"ink":null,"paper":null},{"ch":"┷","rows":[24,24,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"┸","rows":[60,60,60,255,255,0,0,0],"ink":null,"paper":null},{"ch":"┹","rows":[60,60,252,255,255,240,0,0],"ink":null,"paper":null},{"ch":"┺","rows":[60,60,63,255,255,15,0,0],"ink":null,"paper":null},{"ch":"┻","rows":[60,60,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"┼","rows":[24,24,24,255,255,24,24,24],"ink":null,"paper":null},{"ch":"┽","rows":[24,24,248,255,255,248,24,24],"ink":null,"paper":null},{"ch":"┾","rows":[24,24,31,255,255,31,24,24],"ink":null,"paper":null},{"ch":"┿","rows":[24,24,255,255,255,255,24,24],"ink":null,"paper":null},{"ch":"╀","rows":[60,60,60,255,255,24,24,24],"ink":null,"paper":null},{"ch":"╁","rows":[24,24,24,255,255,60,60,60],"ink":null,"paper":null},{"ch":"╂","rows":[60,60,60,255,255,60,60,60],"ink":null,"paper":null},{"ch":"╃","rows":[60,60,252,255,255,248,24,24],"ink":null,"paper":null},{"ch":"╄","rows":[60,60,63,255,255,31,24,24],"ink":null,"paper":null},{"ch":"╅","rows":[24,24,248,255,255,252,60,60],"ink":null,"paper":null},{"ch":"╆","rows":[24,24,31,255,255,63,60,60],"ink":null,"paper":null},{"ch":"╇","rows":[60,60,255,255,255,255,24,24],"ink":null,"paper":null},{"ch":"╈","rows":[24,24,255,255,255,255,60,60],"ink":null,"paper":null},{"ch":"╉","rows":[60,60,252,255,255,252,60,60],"ink":null,"paper":null},{"ch":"╊","rows":[60,60,63,255,255,63,60,60],"ink":null,"paper":null},{"ch":"╋","rows":[60,60,255,255,255,255,60,60],"ink":null,"paper":null},{"ch":"╌","rows":[0,0,0,153,153,0,0,0],"ink":null,"paper":null},{"ch":"╍","rows":[0,0,153,153,153,153,0,0],"ink":null,"paper":null},{"ch":"╎","rows":[24,0,0,24,24,0,0,24],"ink":null,"paper":null},{"ch":"╏","rows":[60,0,0,60,60,0,0,60],"ink":null,"paper":null},{"ch":"═","rows":[0,0,255,0,255,0,0,0],"ink":null,"paper":null},{"ch":"║","rows":[108,108,108,108,108,108,108,108],"ink":null,"paper":null},{"ch":"╒","rows":[0,0,31,24,31,24,24,24],"ink":null,"paper":null},{"ch":"╓","rows":[0,0,0,127,127,108,108,108],"ink":null,"paper":null},{"ch":"╔","rows":[0,0,127,96,111,108,108,108],"ink":null,"paper":null},{"ch":"╕","rows":[0,0,248,24,248,24,24,24],"ink":null,"paper":null},{"ch":"╖","rows":[0,0,0,252,252,108,108,108],"ink":null,"paper":null},{"ch":"╗","rows":[0,0,252,12,236,108,108,108],"ink":null,"paper":null},{"ch":"╘","rows":[24,24,31,24,31,0,0,0],"ink":null,"paper":null},{"ch":"╙","rows":[108,108,108,127,127,0,0,0],"ink":null,"paper":null},{"ch":"╚","rows":[108,108,111,96,127,0,0,0],"ink":null,"paper":null},{"ch":"╛","rows":[24,24,248,24,248,0,0,0],"ink":null,"paper":null},{"ch":"╜","rows":[108,108,108,252,252,0,0,0],"ink":null,"paper":null},{"ch":"╝","rows":[108,108,236,12,252,0,0,0],"ink":null,"paper":null},{"ch":"╞","rows":[24,24,31,24,31,24,24,24],"ink":null,"paper":null},{"ch":"╟","rows":[108,108,108,111,111,108,108,108],"ink":null,"paper":null},{"ch":"╠","rows":[108,108,111,96,111,108,108,108],"ink":null,"paper":null},{"ch":"╡","rows":[24,24,248,24,248,24,24,24],"ink":null,"paper":null},{"ch":"╢","rows":[108,108,108,236,236,108,108,108],"ink":null,"paper":null},{"ch":"╣","rows":[108,108,236,12,236,108,108,108],"ink":null,"paper":null},{"ch":"╤","rows":[0,0,255,0,255,24,24,24],"ink":null,"paper":null},{"ch":"╥","rows":[0,0,0,255,255,108,108,108],"ink":null,"paper":null},{"ch":"╦","rows":[0,0,255,0,239,108,108,108],"ink":null,"paper":null},{"ch":"╧","rows":[24,24,255,0,255,0,0,0],"ink":null,"paper":null},{"ch":"╨","rows":[108,108,108,255,255,0,0,0],"ink":null,"paper":null},{"ch":"╩","rows":[108,108,239,0,255,0,0,0],"ink":null,"paper":null},{"ch":"╪","rows":[24,24,255,24,255,24,24,24],"ink":null,"paper":null},{"ch":"╫","rows":[108,108,108,255,255,108,108,108],"ink":null,"paper":null},{"ch":"╬","rows":[108,108,239,0,239,108,108,108],"ink":null,"paper":null},{"ch":"╭","rows":[0,0,0,7,15,28,24,24],"ink":null,"paper":null},{"ch":"╮","rows":[0,0,0,224,240,56,24,24],"ink":null,"paper":null},{"ch":"╯","rows":[24,24,56,240,224,0,0,0],"ink":null,"paper":null},{"ch":"╰","rows":[24,24,28,15,7,0,0,0],"ink":null,"paper":null},{"ch":"╱","rows":[3,6,12,24,48,96,192,128],"ink":null,"paper":null},{"ch":"╲","rows":[192,96,48,24,12,6,3,1],"ink":null,"paper":null},{"ch":"╳","rows":[195,102,60,24,60,102,195,129],"ink":null,"paper":null},{"ch":"╴","rows":[0,0,0,240,240,0,0,0],"ink":null,"paper":null},{"ch":"╵","rows":[24,24,24,24,0,0,0,0],"ink":null,"paper":null},{"ch":"╶","rows":[0,0,0,15,15,0,0,0],"ink":null,"paper":null},{"ch":"╷","rows":[0,0,0,0,24,24,24,24],"ink":null,"paper":null},{"ch":"╸","rows":[0,0,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"╹","rows":[60,60,60,60,0,0,0,0],"ink":null,"paper":null},{"ch":"╺","rows":[0,0,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"╻","rows":[0,0,0,0,60,60,60,60],"ink":null,"paper":null},{"ch":"╼","rows":[0,0,15,255,255,15,0,0],"ink":null,"paper":null},{"ch":"╽","rows":[24,24,24,24,60,60,60,60],"ink":null,"paper":null},{"ch":"╾","rows":[0,0,240,255,255,240,0,0],"ink":null,"paper":null},{"ch":"╿","rows":[60,60,60,60,24,24,24,24],"ink":null,"paper":null},{"ch":"▀","rows":[255,255,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"▁","rows":[0,0,0,0,0,0,0,255],"ink":null,"paper":null},{"ch":"▂","rows":[0,0,0,0,0,0,255,255],"ink":null,"paper":null},{"ch":"▃","rows":[0,0,0,0,0,255,255,255],"ink":null,"paper":null},{"ch":"▄","rows":[0,0,0,0,255,255,255,255],"ink":null,"paper":null},{"ch":"▅","rows":[0,0,0,255,255,255,255,255],"ink":null,"paper":null},{"ch":"▆","rows":[0,0,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"▇","rows":[0,255,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"█","rows":[255,255,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"▉","rows":[254,254,254,254,254,254,254,254],"ink":null,"paper":null},{"ch":"▊","rows":[252,252,252,252,252,252,252,252],"ink":null,"paper":null},{"ch":"▋","rows":[248,248,248,248,248,248,248,248],"ink":null,"paper":null},{"ch":"▌","rows":[240,240,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"▍","rows":[224,224,224,224,224,224,224,224],"ink":null,"paper":null},{"ch":"▎","rows":[192,192,192,192,192,192,192,192],"ink":null,"paper":null},{"ch":"▏","rows":[128,128,128,128,128,128,128,128],"ink":null,"paper":null},{"ch":"▐","rows":[15,15,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"░","rows":[34,136,34,136,34,136,34,136],"ink":null,"paper":null},{"ch":"▒","rows":[170,85,170,85,170,85,170,85],"ink":null,"paper":null},{"ch":"▓","rows":[221,119,221,119,221,119,221,119],"ink":null,"paper":null},{"ch":"▔","rows":[255,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"▕","rows":[1,1,1,1,1,1,1,1],"ink":null,"paper":null},{"ch":"▖","rows":[0,0,0,0,240,240,240,240],"ink":null,"paper":null},{"ch":"▗","rows":[0,0,0,0,15,15,15,15],"ink":null,"paper":null},{"ch":"▘","rows":[240,240,240,240,0,0,0,0],"ink":null,"paper":null},{"ch":"▙","rows":[240,240,240,240,255,255,255,255],"ink":null,"paper":null},{"ch":"▚","rows":[240,240,240,240,15,15,15,15],"ink":null,"paper":null},{"ch":"▛","rows":[255,255,255,255,240,240,240,240],"ink":null,"paper":null},{"ch":"▜","rows":[255,255,255,255,15,15,15,15],"ink":null,"paper":null},{"ch":"▝","rows":[15,15,15,15,0,0,0,0],"ink":null,"paper":null},{"ch":"▞","rows":[15,15,15,15,240,240,240,240],"ink":null,"paper":null},{"ch":"▟","rows":[15,15,15,15,255,255,255,255],"ink":null,"paper":null},{"ch":"■","rows":[0,126,126,126,126,126,126,0],"ink":null,"paper":null},{"ch":"□","rows":[0,126,102,102,102,102,126,0],"ink":null,"paper":null},{"ch":"▢","rows":[124,198,198,198,198,198,124,0],"ink":null,"paper":null},{"ch":"▣","rows":[254,130,186,186,186,130,254,0],"ink":null,"paper":null},{"ch":"▤","rows":[255,0,255,0,255,0,255,0],"ink":null,"paper":null},{"ch":"▥","rows":[170,170,170,170,170,170,170,170],"ink":null,"paper":null},{"ch":"▦","rows":[68,255,68,68,68,255,68,68],"ink":null,"paper":null},{"ch":"▧","rows":[136,68,34,17,136,68,34,17],"ink":null,"paper":null},{"ch":"▨","rows":[17,34,68,136,17,34,68,136],"ink":null,"paper":null},{"ch":"▩","rows":[170,68,170,17,170,68,170,17],"ink":null,"paper":null},{"ch":"▬","rows":[0,0,0,0,126,126,126,0],"ink":null,"paper":null},{"ch":"▭","rows":[0,0,0,0,126,102,126,0],"ink":null,"paper":null},{"ch":"▮","rows":[60,60,60,60,60,60,60,0],"ink":null,"paper":null},{"ch":"▯","rows":[60,36,36,36,36,36,60,0],"ink":null,"paper":null},{"ch":"▰","rows":[0,0,0,0,63,126,252,0],"ink":null,"paper":null},{"ch":"▱","rows":[0,0,0,0,63,102,252,0],"ink":null,"paper":null},{"ch":"▲","rows":[24,24,60,60,126,126,255,255],"ink":null,"paper":null},{"ch":"△","rows":[24,24,60,102,102,195,195,255],"ink":null,"paper":null},{"ch":"▴","rows":[0,16,16,56,56,124,124,0],"ink":null,"paper":null},{"ch":"▵","rows":[0,16,40,68,130,130,254,0],"ink":null,"paper":null},{"ch":"▷","rows":[192,240,220,199,220,240,192,0],"ink":null,"paper":null},{"ch":"▸","rows":[0,96,120,126,120,96,0,0],"ink":null,"paper":null},{"ch":"▹","rows":[0,96,88,70,88,96,0,0],"ink":null,"paper":null},{"ch":"►","rows":[0,224,252,255,252,224,0,0],"ink":null,"paper":null},{"ch":"▻","rows":[0,240,220,199,220,240,0,0],"ink":null,"paper":null},{"ch":"▼","rows":[255,255,126,126,60,60,24,24],"ink":null,"paper":null},{"ch":"▽","rows":[255,195,195,102,102,60,24,24],"ink":null,"paper":null},{"ch":"▾","rows":[0,124,124,56,56,16,16,0],"ink":null,"paper":null},{"ch":"▿","rows":[0,254,130,130,68,40,16,0],"ink":null,"paper":null},{"ch":"◁","rows":[3,15,59,227,59,15,3,0],"ink":null,"paper":null},{"ch":"◂","rows":[0,6,30,126,30,6,0,0],"ink":null,"paper":null},{"ch":"◃","rows":[0,6,26,98,26,6,0,0],"ink":null,"paper":null},{"ch":"◄","rows":[0,7,63,255,63,7,0,0],"ink":null,"paper":null},{"ch":"◅","rows":[0,15,59,227,59,15,0,0],"ink":null,"paper":null},{"ch":"◆","rows":[24,60,126,255,255,126,60,24],"ink":null,"paper":null},{"ch":"◇","rows":[24,60,102,195,195,102,60,24],"ink":null,"paper":null},{"ch":"◈","rows":[24,36,90,189,189,90,36,24],"ink":null,"paper":null},{"ch":"◉","rows":[60,102,195,219,219,195,102,60],"ink":null,"paper":null},{"ch":"◊","rows":[16,56,108,198,198,108,56,16],"ink":null,"paper":null},{"ch":"○","rows":[0,60,102,66,66,102,60,0],"ink":null,"paper":null},{"ch":"◌","rows":[16,68,0,130,0,68,16,0],"ink":null,"paper":null},{"ch":"◍","rows":[0,56,108,170,170,108,56,0],"ink":null,"paper":null},{"ch":"◎","rows":[56,68,146,170,146,68,56,0],"ink":null,"paper":null},{"ch":"●","rows":[0,60,126,126,126,126,60,0],"ink":null,"paper":null},{"ch":"◐","rows":[60,118,243,243,243,243,118,60],"ink":null,"paper":null},{"ch":"◑","rows":[60,110,207,207,207,207,110,60],"ink":null,"paper":null},{"ch":"◒","rows":[60,102,195,195,255,255,126,60],"ink":null,"paper":null},{"ch":"◓","rows":[60,126,255,255,195,195,102,60],"ink":null,"paper":null},{"ch":"◔","rows":[60,110,207,207,195,195,102,60],"ink":null,"paper":null},{"ch":"◕","rows":[60,110,207,207,255,255,126,60],"ink":null,"paper":null},{"ch":"◖","rows":[0,7,31,63,63,31,7,0],"ink":null,"paper":null},{"ch":"◗","rows":[0,224,248,252,252,248,224,0],"ink":null,"paper":null},{"ch":"◘","rows":[255,255,231,195,195,231,255,255],"ink":null,"paper":null},{"ch":"◙","rows":[255,195,153,189,189,153,195,255],"ink":null,"paper":null},{"ch":"◚","rows":[255,195,153,189,0,0,0,0],"ink":null,"paper":null},{"ch":"◛","rows":[0,0,0,0,189,153,195,255],"ink":null,"paper":null},{"ch":"◜","rows":[56,96,192,192,0,0,0,0],"ink":null,"paper":null},{"ch":"◝","rows":[28,6,3,3,0,0,0,0],"ink":null,"paper":null},{"ch":"◞","rows":[0,0,0,0,3,3,6,28],"ink":null,"paper":null},{"ch":"◟","rows":[0,0,0,0,192,192,96,56],"ink":null,"paper":null},{"ch":"◠","rows":[60,102,195,195,0,0,0,0],"ink":null,"paper":null},{"ch":"◡","rows":[0,0,0,0,195,195,102,60],"ink":null,"paper":null},{"ch":"◢","rows":[1,3,7,15,31,63,127,255],"ink":null,"paper":null},{"ch":"◣","rows":[128,192,224,240,248,252,254,255],"ink":null,"paper":null},{"ch":"◤","rows":[255,254,252,248,240,224,192,128],"ink":null,"paper":null},{"ch":"◥","rows":[255,127,63,31,15,7,3,1],"ink":null,"paper":null},{"ch":"◦","rows":[0,0,24,36,36,24,0,0],"ink":null,"paper":null},{"ch":"◧","rows":[255,243,243,243,243,243,243,255],"ink":null,"paper":null},{"ch":"◨","rows":[255,207,207,207,207,207,207,255],"ink":null,"paper":null},{"ch":"◩","rows":[255,255,255,251,243,227,195,255],"ink":null,"paper":null},{"ch":"◪","rows":[255,195,199,207,223,255,255,255],"ink":null,"paper":null},{"ch":"◫","rows":[255,219,219,219,219,219,219,255],"ink":null,"paper":null},{"ch":"◬","rows":[24,24,36,66,90,153,129,255],"ink":null,"paper":null},{"ch":"◭","rows":[24,24,60,118,118,243,243,255],"ink":null,"paper":null},{"ch":"◮","rows":[24,24,60,110,110,207,207,255],"ink":null,"paper":null},{"ch":"◯","rows":[60,102,195,195,195,195,102,60],"ink":null,"paper":null},{"ch":"◰","rows":[255,219,219,219,251,195,195,255],"ink":null,"paper":null},{"ch":"◱","rows":[255,195,195,195,251,219,219,255],"ink":null,"paper":null},{"ch":"◲","rows":[255,195,195,195,223,219,219,255],"ink":null,"paper":null},{"ch":"◳","rows":[255,219,219,219,223,195,195,255],"ink":null,"paper":null},{"ch":"◴","rows":[60,126,219,219,251,195,102,60],"ink":null,"paper":null},{"ch":"◵","rows":[60,102,195,251,219,219,126,60],"ink":null,"paper":null},{"ch":"◶","rows":[60,102,195,223,219,219,126,60],"ink":null,"paper":null},{"ch":"◷","rows":[60,126,219,219,223,195,102,60],"ink":null,"paper":null},{"ch":"◸","rows":[255,198,204,216,240,224,192,128],"ink":null,"paper":null},{"ch":"◹","rows":[255,99,51,27,15,7,3,1],"ink":null,"paper":null},{"ch":"◺","rows":[128,192,224,240,216,204,198,255],"ink":null,"paper":null},{"ch":"◿","rows":[1,3,7,15,27,51,99,255],"ink":null,"paper":null},{"ch":"★","rows":[0,16,56,254,56,108,130,0],"ink":null,"paper":null},{"ch":"☆","rows":[0,16,56,198,56,108,130,0],"ink":null,"paper":null},{"ch":"☉","rows":[0,60,66,90,90,66,60,0],"ink":null,"paper":null},{"ch":"☐","rows":[254,130,130,130,130,130,254,0],"ink":null,"paper":null},{"ch":"☒","rows":[254,130,170,146,170,130,254,0],"ink":null,"paper":null},{"ch":"☓","rows":[0,68,40,40,16,40,40,68],"ink":null,"paper":null},{"ch":"☖","rows":[0,16,40,68,130,130,130,254],"ink":null,"paper":null},{"ch":"☗","rows":[0,16,56,124,254,254,254,254],"ink":null,"paper":null},{"ch":"☡","rows":[0,56,120,216,216,216,216,222],"ink":null,"paper":null},{"ch":"☥","rows":[124,198,108,56,254,56,56,0],"ink":null,"paper":null},{"ch":"☨","rows":[24,60,24,126,24,24,24,0],"ink":null,"paper":null},{"ch":"☰","rows":[0,0,254,0,254,0,254,0],"ink":null,"paper":null},{"ch":"☱","rows":[0,0,198,0,254,0,254,0],"ink":null,"paper":null},{"ch":"☲","rows":[0,0,254,0,198,0,254,0],"ink":null,"paper":null},{"ch":"☳","rows":[0,0,198,0,198,0,254,0],"ink":null,"paper":null},{"ch":"☴","rows":[0,0,254,0,254,0,198,0],"ink":null,"paper":null},{"ch":"☵","rows":[0,0,198,0,254,0,198,0],"ink":null,"paper":null},{"ch":"☶","rows":[0,0,254,0,198,0,198,0],"ink":null,"paper":null},{"ch":"☷","rows":[0,0,198,0,198,0,198,0],"ink":null,"paper":null},{"ch":"☻","rows":[126,255,219,255,195,231,255,126],"ink":null,"paper":null},{"ch":"☼","rows":[0,16,84,40,198,40,84,16],"ink":null,"paper":null},{"ch":"♡","rows":[108,254,198,198,108,56,16,0],"ink":null,"paper":null},{"ch":"♢","rows":[16,56,108,198,108,56,16,0],"ink":null,"paper":null},{"ch":"♤","rows":[16,56,108,198,238,56,124,0],"ink":null,"paper":null},{"ch":"♧","rows":[56,56,198,198,238,40,124,0],"ink":null,"paper":null},{"ch":"♩","rows":[12,12,12,12,12,60,124,56],"ink":null,"paper":null},{"ch":"♪","rows":[24,28,30,27,24,120,248,112],"ink":null,"paper":null},{"ch":"♫","rows":[127,99,99,99,99,103,230,192],"ink":null,"paper":null},{"ch":"♬","rows":[127,99,127,99,99,103,230,192],"ink":null,"paper":null},{"ch":"⚃","rows":[255,129,165,129,129,165,129,255],"ink":null,"paper":null},{"ch":"⚊","rows":[0,0,254,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⚋","rows":[0,0,198,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⚌","rows":[0,0,254,0,254,0,0,0],"ink":null,"paper":null},{"ch":"⚍","rows":[0,0,198,0,254,0,0,0],"ink":null,"paper":null},{"ch":"⚎","rows":[0,0,254,0,198,0,0,0],"ink":null,"paper":null},{"ch":"⚏","rows":[0,0,198,0,198,0,0,0],"ink":null,"paper":null},{"ch":"⚞","rows":[224,56,0,254,254,0,56,224],"ink":null,"paper":null},{"ch":"⚟","rows":[7,28,0,127,127,0,28,7],"ink":null,"paper":null},{"ch":"⚬","rows":[0,56,124,108,124,56,0,0],"ink":null,"paper":null},{"ch":"⛉","rows":[0,254,130,130,130,68,40,16],"ink":null,"paper":null},{"ch":"⛊","rows":[0,254,254,254,254,124,56,16],"ink":null,"paper":null},{"ch":"⛶","rows":[0,108,130,130,0,130,130,108],"ink":null,"paper":null},{"ch":"✓","rows":[2,6,12,216,240,224,192,0],"ink":null,"paper":null},{"ch":"✚","rows":[0,56,56,254,254,254,56,56],"ink":null,"paper":null},{"ch":"✛","rows":[0,16,16,16,238,16,16,16],"ink":null,"paper":null},{"ch":"✜","rows":[0,56,56,198,198,198,56,56],"ink":null,"paper":null},{"ch":"✵","rows":[0,146,84,56,238,56,84,146],"ink":null,"paper":null},{"ch":"❏","rows":[0,252,134,134,134,134,254,126],"ink":null,"paper":null},{"ch":"❐","rows":[0,126,254,134,134,134,134,252],"ink":null,"paper":null},{"ch":"⠀","rows":[0,0,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⠁","rows":[240,240,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⠂","rows":[0,0,240,240,0,0,0,0],"ink":null,"paper":null},{"ch":"⠃","rows":[240,240,240,240,0,0,0,0],"ink":null,"paper":null},{"ch":"⠄","rows":[0,0,0,0,240,240,0,0],"ink":null,"paper":null},{"ch":"⠅","rows":[240,240,0,0,240,240,0,0],"ink":null,"paper":null},{"ch":"⠆","rows":[0,0,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"⠇","rows":[240,240,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"⠈","rows":[15,15,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⠉","rows":[255,255,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"⠊","rows":[15,15,240,240,0,0,0,0],"ink":null,"paper":null},{"ch":"⠋","rows":[255,255,240,240,0,0,0,0],"ink":null,"paper":null},{"ch":"⠌","rows":[15,15,0,0,240,240,0,0],"ink":null,"paper":null},{"ch":"⠍","rows":[255,255,0,0,240,240,0,0],"ink":null,"paper":null},{"ch":"⠎","rows":[15,15,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"⠏","rows":[255,255,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"⠐","rows":[0,0,15,15,0,0,0,0],"ink":null,"paper":null},{"ch":"⠑","rows":[240,240,15,15,0,0,0,0],"ink":null,"paper":null},{"ch":"⠒","rows":[0,0,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"⠓","rows":[240,240,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"⠔","rows":[0,0,15,15,240,240,0,0],"ink":null,"paper":null},{"ch":"⠕","rows":[240,240,15,15,240,240,0,0],"ink":null,"paper":null},{"ch":"⠖","rows":[0,0,255,255,240,240,0,0],"ink":null,"paper":null},{"ch":"⠗","rows":[240,240,255,255,240,240,0,0],"ink":null,"paper":null},{"ch":"⠘","rows":[15,15,15,15,0,0,0,0],"ink":null,"paper":null},{"ch":"⠙","rows":[255,255,15,15,0,0,0,0],"ink":null,"paper":null},{"ch":"⠚","rows":[15,15,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"⠛","rows":[255,255,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"⠜","rows":[15,15,15,15,240,240,0,0],"ink":null,"paper":null},{"ch":"⠝","rows":[255,255,15,15,240,240,0,0],"ink":null,"paper":null},{"ch":"⠞","rows":[15,15,255,255,240,240,0,0],"ink":null,"paper":null},{"ch":"⠟","rows":[255,255,255,255,240,240,0,0],"ink":null,"paper":null},{"ch":"⠠","rows":[0,0,0,0,15,15,0,0],"ink":null,"paper":null},{"ch":"⠡","rows":[240,240,0,0,15,15,0,0],"ink":null,"paper":null},{"ch":"⠢","rows":[0,0,240,240,15,15,0,0],"ink":null,"paper":null},{"ch":"⠣","rows":[240,240,240,240,15,15,0,0],"ink":null,"paper":null},{"ch":"⠤","rows":[0,0,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"⠥","rows":[240,240,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"⠦","rows":[0,0,240,240,255,255,0,0],"ink":null,"paper":null},{"ch":"⠧","rows":[240,240,240,240,255,255,0,0],"ink":null,"paper":null},{"ch":"⠨","rows":[15,15,0,0,15,15,0,0],"ink":null,"paper":null},{"ch":"⠩","rows":[255,255,0,0,15,15,0,0],"ink":null,"paper":null},{"ch":"⠪","rows":[15,15,240,240,15,15,0,0],"ink":null,"paper":null},{"ch":"⠫","rows":[255,255,240,240,15,15,0,0],"ink":null,"paper":null},{"ch":"⠬","rows":[15,15,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"⠭","rows":[255,255,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"⠮","rows":[15,15,240,240,255,255,0,0],"ink":null,"paper":null},{"ch":"⠯","rows":[255,255,240,240,255,255,0,0],"ink":null,"paper":null},{"ch":"⠰","rows":[0,0,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"⠱","rows":[240,240,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"⠲","rows":[0,0,255,255,15,15,0,0],"ink":null,"paper":null},{"ch":"⠳","rows":[240,240,255,255,15,15,0,0],"ink":null,"paper":null},{"ch":"⠴","rows":[0,0,15,15,255,255,0,0],"ink":null,"paper":null},{"ch":"⠵","rows":[240,240,15,15,255,255,0,0],"ink":null,"paper":null},{"ch":"⠶","rows":[0,0,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"⠷","rows":[240,240,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"⠸","rows":[15,15,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"⠹","rows":[255,255,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"⠺","rows":[15,15,255,255,15,15,0,0],"ink":null,"paper":null},{"ch":"⠻","rows":[255,255,255,255,15,15,0,0],"ink":null,"paper":null},{"ch":"⠼","rows":[15,15,15,15,255,255,0,0],"ink":null,"paper":null},{"ch":"⠽","rows":[255,255,15,15,255,255,0,0],"ink":null,"paper":null},{"ch":"⠾","rows":[15,15,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"⠿","rows":[255,255,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"⡀","rows":[0,0,0,0,0,0,240,240],"ink":null,"paper":null},{"ch":"⡁","rows":[240,240,0,0,0,0,240,240],"ink":null,"paper":null},{"ch":"⡂","rows":[0,0,240,240,0,0,240,240],"ink":null,"paper":null},{"ch":"⡃","rows":[240,240,240,240,0,0,240,240],"ink":null,"paper":null},{"ch":"⡄","rows":[0,0,0,0,240,240,240,240],"ink":null,"paper":null},{"ch":"⡅","rows":[240,240,0,0,240,240,240,240],"ink":null,"paper":null},{"ch":"⡆","rows":[0,0,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"⡇","rows":[240,240,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"⡈","rows":[15,15,0,0,0,0,240,240],"ink":null,"paper":null},{"ch":"⡉","rows":[255,255,0,0,0,0,240,240],"ink":null,"paper":null},{"ch":"⡊","rows":[15,15,240,240,0,0,240,240],"ink":null,"paper":null},{"ch":"⡋","rows":[255,255,240,240,0,0,240,240],"ink":null,"paper":null},{"ch":"⡌","rows":[15,15,0,0,240,240,240,240],"ink":null,"paper":null},{"ch":"⡍","rows":[255,255,0,0,240,240,240,240],"ink":null,"paper":null},{"ch":"⡎","rows":[15,15,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"⡏","rows":[255,255,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"⡐","rows":[0,0,15,15,0,0,240,240],"ink":null,"paper":null},{"ch":"⡑","rows":[240,240,15,15,0,0,240,240],"ink":null,"paper":null},{"ch":"⡒","rows":[0,0,255,255,0,0,240,240],"ink":null,"paper":null},{"ch":"⡓","rows":[240,240,255,255,0,0,240,240],"ink":null,"paper":null},{"ch":"⡔","rows":[0,0,15,15,240,240,240,240],"ink":null,"paper":null},{"ch":"⡕","rows":[240,240,15,15,240,240,240,240],"ink":null,"paper":null},{"ch":"⡖","rows":[0,0,255,255,240,240,240,240],"ink":null,"paper":null},{"ch":"⡗","rows":[240,240,255,255,240,240,240,240],"ink":null,"paper":null},{"ch":"⡘","rows":[15,15,15,15,0,0,240,240],"ink":null,"paper":null},{"ch":"⡙","rows":[255,255,15,15,0,0,240,240],"ink":null,"paper":null},{"ch":"⡚","rows":[15,15,255,255,0,0,240,240],"ink":null,"paper":null},{"ch":"⡛","rows":[255,255,255,255,0,0,240,240],"ink":null,"paper":null},{"ch":"⡜","rows":[15,15,15,15,240,240,240,240],"ink":null,"paper":null},{"ch":"⡝","rows":[255,255,15,15,240,240,240,240],"ink":null,"paper":null},{"ch":"⡞","rows":[15,15,255,255,240,240,240,240],"ink":null,"paper":null},{"ch":"⡟","rows":[255,255,255,255,240,240,240,240],"ink":null,"paper":null},{"ch":"⡠","rows":[0,0,0,0,15,15,240,240],"ink":null,"paper":null},{"ch":"⡡","rows":[240,240,0,0,15,15,240,240],"ink":null,"paper":null},{"ch":"⡢","rows":[0,0,240,240,15,15,240,240],"ink":null,"paper":null},{"ch":"⡣","rows":[240,240,240,240,15,15,240,240],"ink":null,"paper":null},{"ch":"⡤","rows":[0,0,0,0,255,255,240,240],"ink":null,"paper":null},{"ch":"⡥","rows":[240,240,0,0,255,255,240,240],"ink":null,"paper":null},{"ch":"⡦","rows":[0,0,240,240,255,255,240,240],"ink":null,"paper":null},{"ch":"⡧","rows":[240,240,240,240,255,255,240,240],"ink":null,"paper":null},{"ch":"⡨","rows":[15,15,0,0,15,15,240,240],"ink":null,"paper":null},{"ch":"⡩","rows":[255,255,0,0,15,15,240,240],"ink":null,"paper":null},{"ch":"⡪","rows":[15,15,240,240,15,15,240,240],"ink":null,"paper":null},{"ch":"⡫","rows":[255,255,240,240,15,15,240,240],"ink":null,"paper":null},{"ch":"⡬","rows":[15,15,0,0,255,255,240,240],"ink":null,"paper":null},{"ch":"⡭","rows":[255,255,0,0,255,255,240,240],"ink":null,"paper":null},{"ch":"⡮","rows":[15,15,240,240,255,255,240,240],"ink":null,"paper":null},{"ch":"⡯","rows":[255,255,240,240,255,255,240,240],"ink":null,"paper":null},{"ch":"⡰","rows":[0,0,15,15,15,15,240,240],"ink":null,"paper":null},{"ch":"⡱","rows":[240,240,15,15,15,15,240,240],"ink":null,"paper":null},{"ch":"⡲","rows":[0,0,255,255,15,15,240,240],"ink":null,"paper":null},{"ch":"⡳","rows":[240,240,255,255,15,15,240,240],"ink":null,"paper":null},{"ch":"⡴","rows":[0,0,15,15,255,255,240,240],"ink":null,"paper":null},{"ch":"⡵","rows":[240,240,15,15,255,255,240,240],"ink":null,"paper":null},{"ch":"⡶","rows":[0,0,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"⡷","rows":[240,240,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"⡸","rows":[15,15,15,15,15,15,240,240],"ink":null,"paper":null},{"ch":"⡹","rows":[255,255,15,15,15,15,240,240],"ink":null,"paper":null},{"ch":"⡺","rows":[15,15,255,255,15,15,240,240],"ink":null,"paper":null},{"ch":"⡻","rows":[255,255,255,255,15,15,240,240],"ink":null,"paper":null},{"ch":"⡼","rows":[15,15,15,15,255,255,240,240],"ink":null,"paper":null},{"ch":"⡽","rows":[255,255,15,15,255,255,240,240],"ink":null,"paper":null},{"ch":"⡾","rows":[15,15,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"⡿","rows":[255,255,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"⢀","rows":[0,0,0,0,0,0,15,15],"ink":null,"paper":null},{"ch":"⢁","rows":[240,240,0,0,0,0,15,15],"ink":null,"paper":null},{"ch":"⢂","rows":[0,0,240,240,0,0,15,15],"ink":null,"paper":null},{"ch":"⢃","rows":[240,240,240,240,0,0,15,15],"ink":null,"paper":null},{"ch":"⢄","rows":[0,0,0,0,240,240,15,15],"ink":null,"paper":null},{"ch":"⢅","rows":[240,240,0,0,240,240,15,15],"ink":null,"paper":null},{"ch":"⢆","rows":[0,0,240,240,240,240,15,15],"ink":null,"paper":null},{"ch":"⢇","rows":[240,240,240,240,240,240,15,15],"ink":null,"paper":null},{"ch":"⢈","rows":[15,15,0,0,0,0,15,15],"ink":null,"paper":null},{"ch":"⢉","rows":[255,255,0,0,0,0,15,15],"ink":null,"paper":null},{"ch":"⢊","rows":[15,15,240,240,0,0,15,15],"ink":null,"paper":null},{"ch":"⢋","rows":[255,255,240,240,0,0,15,15],"ink":null,"paper":null},{"ch":"⢌","rows":[15,15,0,0,240,240,15,15],"ink":null,"paper":null},{"ch":"⢍","rows":[255,255,0,0,240,240,15,15],"ink":null,"paper":null},{"ch":"⢎","rows":[15,15,240,240,240,240,15,15],"ink":null,"paper":null},{"ch":"⢏","rows":[255,255,240,240,240,240,15,15],"ink":null,"paper":null},{"ch":"⢐","rows":[0,0,15,15,0,0,15,15],"ink":null,"paper":null},{"ch":"⢑","rows":[240,240,15,15,0,0,15,15],"ink":null,"paper":null},{"ch":"⢒","rows":[0,0,255,255,0,0,15,15],"ink":null,"paper":null},{"ch":"⢓","rows":[240,240,255,255,0,0,15,15],"ink":null,"paper":null},{"ch":"⢔","rows":[0,0,15,15,240,240,15,15],"ink":null,"paper":null},{"ch":"⢕","rows":[240,240,15,15,240,240,15,15],"ink":null,"paper":null},{"ch":"⢖","rows":[0,0,255,255,240,240,15,15],"ink":null,"paper":null},{"ch":"⢗","rows":[240,240,255,255,240,240,15,15],"ink":null,"paper":null},{"ch":"⢘","rows":[15,15,15,15,0,0,15,15],"ink":null,"paper":null},{"ch":"⢙","rows":[255,255,15,15,0,0,15,15],"ink":null,"paper":null},{"ch":"⢚","rows":[15,15,255,255,0,0,15,15],"ink":null,"paper":null},{"ch":"⢛","rows":[255,255,255,255,0,0,15,15],"ink":null,"paper":null},{"ch":"⢜","rows":[15,15,15,15,240,240,15,15],"ink":null,"paper":null},{"ch":"⢝","rows":[255,255,15,15,240,240,15,15],"ink":null,"paper":null},{"ch":"⢞","rows":[15,15,255,255,240,240,15,15],"ink":null,"paper":null},{"ch":"⢟","rows":[255,255,255,255,240,240,15,15],"ink":null,"paper":null},{"ch":"⢠","rows":[0,0,0,0,15,15,15,15],"ink":null,"paper":null},{"ch":"⢡","rows":[240,240,0,0,15,15,15,15],"ink":null,"paper":null},{"ch":"⢢","rows":[0,0,240,240,15,15,15,15],"ink":null,"paper":null},{"ch":"⢣","rows":[240,240,240,240,15,15,15,15],"ink":null,"paper":null},{"ch":"⢤","rows":[0,0,0,0,255,255,15,15],"ink":null,"paper":null},{"ch":"⢥","rows":[240,240,0,0,255,255,15,15],"ink":null,"paper":null},{"ch":"⢦","rows":[0,0,240,240,255,255,15,15],"ink":null,"paper":null},{"ch":"⢧","rows":[240,240,240,240,255,255,15,15],"ink":null,"paper":null},{"ch":"⢨","rows":[15,15,0,0,15,15,15,15],"ink":null,"paper":null},{"ch":"⢩","rows":[255,255,0,0,15,15,15,15],"ink":null,"paper":null},{"ch":"⢪","rows":[15,15,240,240,15,15,15,15],"ink":null,"paper":null},{"ch":"⢫","rows":[255,255,240,240,15,15,15,15],"ink":null,"paper":null},{"ch":"⢬","rows":[15,15,0,0,255,255,15,15],"ink":null,"paper":null},{"ch":"⢭","rows":[255,255,0,0,255,255,15,15],"ink":null,"paper":null},{"ch":"⢮","rows":[15,15,240,240,255,255,15,15],"ink":null,"paper":null},{"ch":"⢯","rows":[255,255,240,240,255,255,15,15],"ink":null,"paper":null},{"ch":"⢰","rows":[0,0,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"⢱","rows":[240,240,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"⢲","rows":[0,0,255,255,15,15,15,15],"ink":null,"paper":null},{"ch":"⢳","rows":[240,240,255,255,15,15,15,15],"ink":null,"paper":null},{"ch":"⢴","rows":[0,0,15,15,255,255,15,15],"ink":null,"paper":null},{"ch":"⢵","rows":[240,240,15,15,255,255,15,15],"ink":null,"paper":null},{"ch":"⢶","rows":[0,0,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"⢷","rows":[240,240,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"⢸","rows":[15,15,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"⢹","rows":[255,255,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"⢺","rows":[15,15,255,255,15,15,15,15],"ink":null,"paper":null},{"ch":"⢻","rows":[255,255,255,255,15,15,15,15],"ink":null,"paper":null},{"ch":"⢼","rows":[15,15,15,15,255,255,15,15],"ink":null,"paper":null},{"ch":"⢽","rows":[255,255,15,15,255,255,15,15],"ink":null,"paper":null},{"ch":"⢾","rows":[15,15,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"⢿","rows":[255,255,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"⣀","rows":[0,0,0,0,0,0,255,255],"ink":null,"paper":null},{"ch":"⣁","rows":[240,240,0,0,0,0,255,255],"ink":null,"paper":null},{"ch":"⣂","rows":[0,0,240,240,0,0,255,255],"ink":null,"paper":null},{"ch":"⣃","rows":[240,240,240,240,0,0,255,255],"ink":null,"paper":null},{"ch":"⣄","rows":[0,0,0,0,240,240,255,255],"ink":null,"paper":null},{"ch":"⣅","rows":[240,240,0,0,240,240,255,255],"ink":null,"paper":null},{"ch":"⣆","rows":[0,0,240,240,240,240,255,255],"ink":null,"paper":null},{"ch":"⣇","rows":[240,240,240,240,240,240,255,255],"ink":null,"paper":null},{"ch":"⣈","rows":[15,15,0,0,0,0,255,255],"ink":null,"paper":null},{"ch":"⣉","rows":[255,255,0,0,0,0,255,255],"ink":null,"paper":null},{"ch":"⣊","rows":[15,15,240,240,0,0,255,255],"ink":null,"paper":null},{"ch":"⣋","rows":[255,255,240,240,0,0,255,255],"ink":null,"paper":null},{"ch":"⣌","rows":[15,15,0,0,240,240,255,255],"ink":null,"paper":null},{"ch":"⣍","rows":[255,255,0,0,240,240,255,255],"ink":null,"paper":null},{"ch":"⣎","rows":[15,15,240,240,240,240,255,255],"ink":null,"paper":null},{"ch":"⣏","rows":[255,255,240,240,240,240,255,255],"ink":null,"paper":null},{"ch":"⣐","rows":[0,0,15,15,0,0,255,255],"ink":null,"paper":null},{"ch":"⣑","rows":[240,240,15,15,0,0,255,255],"ink":null,"paper":null},{"ch":"⣒","rows":[0,0,255,255,0,0,255,255],"ink":null,"paper":null},{"ch":"⣓","rows":[240,240,255,255,0,0,255,255],"ink":null,"paper":null},{"ch":"⣔","rows":[0,0,15,15,240,240,255,255],"ink":null,"paper":null},{"ch":"⣕","rows":[240,240,15,15,240,240,255,255],"ink":null,"paper":null},{"ch":"⣖","rows":[0,0,255,255,240,240,255,255],"ink":null,"paper":null},{"ch":"⣗","rows":[240,240,255,255,240,240,255,255],"ink":null,"paper":null},{"ch":"⣘","rows":[15,15,15,15,0,0,255,255],"ink":null,"paper":null},{"ch":"⣙","rows":[255,255,15,15,0,0,255,255],"ink":null,"paper":null},{"ch":"⣚","rows":[15,15,255,255,0,0,255,255],"ink":null,"paper":null},{"ch":"⣛","rows":[255,255,255,255,0,0,255,255],"ink":null,"paper":null},{"ch":"⣜","rows":[15,15,15,15,240,240,255,255],"ink":null,"paper":null},{"ch":"⣝","rows":[255,255,15,15,240,240,255,255],"ink":null,"paper":null},{"ch":"⣞","rows":[15,15,255,255,240,240,255,255],"ink":null,"paper":null},{"ch":"⣟","rows":[255,255,255,255,240,240,255,255],"ink":null,"paper":null},{"ch":"⣠","rows":[0,0,0,0,15,15,255,255],"ink":null,"paper":null},{"ch":"⣡","rows":[240,240,0,0,15,15,255,255],"ink":null,"paper":null},{"ch":"⣢","rows":[0,0,240,240,15,15,255,255],"ink":null,"paper":null},{"ch":"⣣","rows":[240,240,240,240,15,15,255,255],"ink":null,"paper":null},{"ch":"⣤","rows":[0,0,0,0,255,255,255,255],"ink":null,"paper":null},{"ch":"⣥","rows":[240,240,0,0,255,255,255,255],"ink":null,"paper":null},{"ch":"⣦","rows":[0,0,240,240,255,255,255,255],"ink":null,"paper":null},{"ch":"⣧","rows":[240,240,240,240,255,255,255,255],"ink":null,"paper":null},{"ch":"⣨","rows":[15,15,0,0,15,15,255,255],"ink":null,"paper":null},{"ch":"⣩","rows":[255,255,0,0,15,15,255,255],"ink":null,"paper":null},{"ch":"⣪","rows":[15,15,240,240,15,15,255,255],"ink":null,"paper":null},{"ch":"⣫","rows":[255,255,240,240,15,15,255,255],"ink":null,"paper":null},{"ch":"⣬","rows":[15,15,0,0,255,255,255,255],"ink":null,"paper":null},{"ch":"⣭","rows":[255,255,0,0,255,255,255,255],"ink":null,"paper":null},{"ch":"⣮","rows":[15,15,240,240,255,255,255,255],"ink":null,"paper":null},{"ch":"⣯","rows":[255,255,240,240,255,255,255,255],"ink":null,"paper":null},{"ch":"⣰","rows":[0,0,15,15,15,15,255,255],"ink":null,"paper":null},{"ch":"⣱","rows":[240,240,15,15,15,15,255,255],"ink":null,"paper":null},{"ch":"⣲","rows":[0,0,255,255,15,15,255,255],"ink":null,"paper":null},{"ch":"⣳","rows":[240,240,255,255,15,15,255,255],"ink":null,"paper":null},{"ch":"⣴","rows":[0,0,15,15,255,255,255,255],"ink":null,"paper":null},{"ch":"⣵","rows":[240,240,15,15,255,255,255,255],"ink":null,"paper":null},{"ch":"⣶","rows":[0,0,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"⣷","rows":[240,240,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"⣸","rows":[15,15,15,15,15,15,255,255],"ink":null,"paper":null},{"ch":"⣹","rows":[255,255,15,15,15,15,255,255],"ink":null,"paper":null},{"ch":"⣺","rows":[15,15,255,255,15,15,255,255],"ink":null,"paper":null},{"ch":"⣻","rows":[255,255,255,255,15,15,255,255],"ink":null,"paper":null},{"ch":"⣼","rows":[15,15,15,15,255,255,255,255],"ink":null,"paper":null},{"ch":"⣽","rows":[255,255,15,15,255,255,255,255],"ink":null,"paper":null},{"ch":"⣾","rows":[15,15,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"⣿","rows":[255,255,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"⧉","rows":[248,136,190,170,250,34,62,0],"ink":null,"paper":null},{"ch":"⬒","rows":[255,255,255,255,195,195,195,255],"ink":null,"paper":null},{"ch":"⬓","rows":[255,195,195,195,255,255,255,255],"ink":null,"paper":null},{"ch":"⬔","rows":[255,255,255,223,207,199,195,255],"ink":null,"paper":null},{"ch":"⬕","rows":[255,195,227,243,251,255,255,255],"ink":null,"paper":null},{"ch":"⬖","rows":[24,60,118,243,243,118,60,24],"ink":null,"paper":null},{"ch":"⬗","rows":[24,60,110,207,207,110,60,24],"ink":null,"paper":null},{"ch":"⬘","rows":[24,60,126,255,195,102,60,24],"ink":null,"paper":null},{"ch":"⬙","rows":[24,60,102,195,255,126,60,24],"ink":null,"paper":null},{"ch":"⬚","rows":[0,170,0,130,0,130,0,170],"ink":null,"paper":null},{"ch":"⬝","rows":[0,0,0,24,24,0,0,0],"ink":null,"paper":null},{"ch":"⬤","rows":[60,126,255,255,255,255,126,60],"ink":null,"paper":null},{"ch":"⬥","rows":[0,16,56,124,124,56,16,0],"ink":null,"paper":null},{"ch":"⬦","rows":[0,16,56,108,108,56,16,0],"ink":null,"paper":null},{"ch":"⬧","rows":[16,56,124,124,124,56,16,0],"ink":null,"paper":null},{"ch":"⬨","rows":[16,40,68,68,68,40,16,0],"ink":null,"paper":null},{"ch":"⬩","rows":[0,16,56,124,56,16,0,0],"ink":null,"paper":null},{"ch":"⬪","rows":[0,16,56,56,56,16,0,0],"ink":null,"paper":null},{"ch":"⬫","rows":[0,16,56,40,56,16,0,0],"ink":null,"paper":null},{"ch":"⬬","rows":[0,60,126,255,255,126,60,0],"ink":null,"paper":null},{"ch":"⬭","rows":[0,60,102,195,195,102,60,0],"ink":null,"paper":null},{"ch":"⬮","rows":[24,60,126,126,126,126,60,24],"ink":null,"paper":null},{"ch":"⬯","rows":[24,60,102,102,102,102,60,24],"ink":null,"paper":null},{"ch":"⭘","rows":[0,60,126,102,102,126,60,0],"ink":null,"paper":null},{"ch":"⭳","rows":[56,56,124,56,16,0,124,0],"ink":null,"paper":null},{"ch":"⮜","rows":[3,14,60,248,60,14,3,0],"ink":null,"paper":null},{"ch":"⮝","rows":[16,16,56,56,124,108,198,130],"ink":null,"paper":null},{"ch":"⮞","rows":[192,112,60,31,60,112,192,0],"ink":null,"paper":null},{"ch":"⮟","rows":[130,198,108,124,56,56,16,16],"ink":null,"paper":null},{"ch":"⮺","rows":[31,17,125,85,95,68,124,0],"ink":null,"paper":null},{"ch":"⯀","rows":[0,126,126,126,126,126,126,0],"ink":null,"paper":null},{"ch":"⯅","rows":[16,16,56,56,124,124,254,254],"ink":null,"paper":null},{"ch":"⯆","rows":[254,254,124,124,56,56,16,16],"ink":null,"paper":null},{"ch":"⯇","rows":[3,15,63,255,63,15,3,0],"ink":null,"paper":null},{"ch":"⯈","rows":[192,240,252,255,252,240,192,0],"ink":null,"paper":null},{"ch":"⯊","rows":[0,0,24,60,60,126,126,126],"ink":null,"paper":null},{"ch":"⯋","rows":[126,126,126,60,60,24,0,0],"ink":null,"paper":null},{"ch":"〒","rows":[0,254,0,254,56,56,56,56],"ink":null,"paper":null},{"ch":"䷀","rows":[254,254,254,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷁","rows":[198,198,198,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷂","rows":[198,254,198,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷃","rows":[254,198,198,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷄","rows":[198,254,198,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷅","rows":[254,254,254,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷆","rows":[198,198,198,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷇","rows":[198,254,198,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷈","rows":[254,254,198,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷉","rows":[254,254,254,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷊","rows":[198,198,198,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷋","rows":[254,254,254,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷌","rows":[254,254,254,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷍","rows":[254,198,254,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷎","rows":[198,198,198,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷏","rows":[198,198,254,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷐","rows":[198,254,254,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷑","rows":[254,198,198,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷒","rows":[198,198,198,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷓","rows":[254,254,198,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷔","rows":[254,198,254,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷕","rows":[254,198,198,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷖","rows":[254,198,198,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷗","rows":[198,198,198,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷘","rows":[254,254,254,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷙","rows":[254,198,198,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷚","rows":[254,198,198,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷛","rows":[198,254,254,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷜","rows":[198,254,198,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷝","rows":[254,198,254,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷞","rows":[198,254,254,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷟","rows":[198,198,254,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷠","rows":[254,254,254,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷡","rows":[198,198,254,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷢","rows":[254,198,254,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷣","rows":[198,198,198,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷤","rows":[254,254,198,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷥","rows":[254,198,254,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷦","rows":[198,254,198,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷧","rows":[198,198,254,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷨","rows":[254,198,198,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷩","rows":[254,254,198,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷪","rows":[198,254,254,0,254,254,254,0],"ink":null,"paper":null},{"ch":"䷫","rows":[254,254,254,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷬","rows":[198,254,254,0,198,198,198,0],"ink":null,"paper":null},{"ch":"䷭","rows":[198,198,198,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷮","rows":[198,254,254,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷯","rows":[198,254,198,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷰","rows":[198,254,254,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷱","rows":[254,198,254,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷲","rows":[198,198,254,0,198,198,254,0],"ink":null,"paper":null},{"ch":"䷳","rows":[254,198,198,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷴","rows":[254,254,198,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷵","rows":[198,198,254,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷶","rows":[198,198,254,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷷","rows":[254,198,254,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷸","rows":[254,254,198,0,254,254,198,0],"ink":null,"paper":null},{"ch":"䷹","rows":[198,254,254,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷺","rows":[254,254,198,0,198,254,198,0],"ink":null,"paper":null},{"ch":"䷻","rows":[254,198,254,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷼","rows":[254,254,198,0,198,254,254,0],"ink":null,"paper":null},{"ch":"䷽","rows":[198,198,254,0,254,198,198,0],"ink":null,"paper":null},{"ch":"䷾","rows":[198,254,198,0,254,198,254,0],"ink":null,"paper":null},{"ch":"䷿","rows":[254,198,254,0,198,254,198,0],"ink":null,"paper":null},{"ch":"﬩","rows":[0,0,16,16,16,124,0,0],"ink":null,"paper":null},{"ch":"＄","rows":[24,62,96,60,6,124,24,0],"ink":null,"paper":null},{"ch":"＋","rows":[0,24,24,126,24,24,0,0],"ink":null,"paper":null},{"ch":"＜","rows":[12,24,48,96,48,24,12,0],"ink":null,"paper":null},{"ch":"＝","rows":[0,0,126,0,126,0,0,0],"ink":null,"paper":null},{"ch":"＞","rows":[96,48,24,12,24,48,96,0],"ink":null,"paper":null},{"ch":"＾","rows":[16,56,108,198,0,0,0,0],"ink":null,"paper":null},{"ch":"｀","rows":[24,12,6,0,0,0,0,0],"ink":null,"paper":null},{"ch":"｜","rows":[24,24,24,24,24,24,24,0],"ink":null,"paper":null},{"ch":"￼","rows":[0,84,130,16,170,16,130,84],"ink":null,"paper":null},{"ch":"�","rows":[0,254,198,246,230,254,238,254],"ink":null,"paper":null},{"ch":"𝌀","rows":[0,0,146,0,0,0,0,0],"ink":null,"paper":null},{"ch":"𝌁","rows":[0,0,254,0,146,0,0,0],"ink":null,"paper":null},{"ch":"𝌂","rows":[0,0,198,0,146,0,0,0],"ink":null,"paper":null},{"ch":"𝌃","rows":[0,0,146,0,254,0,0,0],"ink":null,"paper":null},{"ch":"𝌄","rows":[0,0,146,0,198,0,0,0],"ink":null,"paper":null},{"ch":"𝌅","rows":[0,0,146,0,146,0,0,0],"ink":null,"paper":null},{"ch":"𝌆","rows":[254,0,254,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌇","rows":[254,0,254,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌈","rows":[254,0,254,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌉","rows":[254,0,254,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌊","rows":[254,0,254,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌋","rows":[254,0,254,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌌","rows":[254,0,254,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌍","rows":[254,0,254,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌎","rows":[254,0,254,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌏","rows":[254,0,198,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌐","rows":[254,0,198,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌑","rows":[254,0,198,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌒","rows":[254,0,198,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌓","rows":[254,0,198,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌔","rows":[254,0,198,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌕","rows":[254,0,198,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌖","rows":[254,0,198,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌗","rows":[254,0,198,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌘","rows":[254,0,146,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌙","rows":[254,0,146,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌚","rows":[254,0,146,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌛","rows":[254,0,146,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌜","rows":[254,0,146,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌝","rows":[254,0,146,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌞","rows":[254,0,146,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌟","rows":[254,0,146,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌠","rows":[254,0,146,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌡","rows":[198,0,254,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌢","rows":[198,0,254,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌣","rows":[198,0,254,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌤","rows":[198,0,254,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌥","rows":[198,0,254,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌦","rows":[198,0,254,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌧","rows":[198,0,254,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌨","rows":[198,0,254,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌩","rows":[198,0,254,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌪","rows":[198,0,198,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌫","rows":[198,0,198,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌬","rows":[198,0,198,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌭","rows":[198,0,198,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌮","rows":[198,0,198,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌯","rows":[198,0,198,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌰","rows":[198,0,198,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌱","rows":[198,0,198,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌲","rows":[198,0,198,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌳","rows":[198,0,146,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌴","rows":[198,0,146,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌵","rows":[198,0,146,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌶","rows":[198,0,146,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝌷","rows":[198,0,146,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝌸","rows":[198,0,146,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝌹","rows":[198,0,146,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝌺","rows":[198,0,146,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝌻","rows":[198,0,146,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝌼","rows":[146,0,254,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝌽","rows":[146,0,254,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝌾","rows":[146,0,254,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝌿","rows":[146,0,254,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝍀","rows":[146,0,254,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝍁","rows":[146,0,254,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝍂","rows":[146,0,254,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝍃","rows":[146,0,254,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝍄","rows":[146,0,254,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝍅","rows":[146,0,198,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝍆","rows":[146,0,198,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝍇","rows":[146,0,198,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝍈","rows":[146,0,198,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝍉","rows":[146,0,198,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝍊","rows":[146,0,198,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝍋","rows":[146,0,198,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝍌","rows":[146,0,198,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝍍","rows":[146,0,198,0,146,0,146,0],"ink":null,"paper":null},{"ch":"𝍎","rows":[146,0,146,0,254,0,254,0],"ink":null,"paper":null},{"ch":"𝍏","rows":[146,0,146,0,254,0,198,0],"ink":null,"paper":null},{"ch":"𝍐","rows":[146,0,146,0,254,0,146,0],"ink":null,"paper":null},{"ch":"𝍑","rows":[146,0,146,0,198,0,254,0],"ink":null,"paper":null},{"ch":"𝍒","rows":[146,0,146,0,198,0,198,0],"ink":null,"paper":null},{"ch":"𝍓","rows":[146,0,146,0,198,0,146,0],"ink":null,"paper":null},{"ch":"𝍔","rows":[146,0,146,0,146,0,254,0],"ink":null,"paper":null},{"ch":"𝍕","rows":[146,0,146,0,146,0,198,0],"ink":null,"paper":null},{"ch":"𝍖","rows":[146,0,146,0,146,0,146,0],"ink":null,"paper":null},{"ch":"🄯","rows":[0,124,130,186,138,186,130,124],"ink":null,"paper":null},{"ch":"🗩","rows":[0,124,130,130,130,92,160,192],"ink":null,"paper":null},{"ch":"🡠","rows":[16,56,56,56,56,56,124,214],"ink":null,"paper":null},{"ch":"🬀","rows":[240,240,240,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🬁","rows":[15,15,15,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🬂","rows":[255,255,255,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🬃","rows":[0,0,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"🬄","rows":[240,240,240,240,240,240,0,0],"ink":null,"paper":null},{"ch":"🬅","rows":[15,15,255,240,240,240,0,0],"ink":null,"paper":null},{"ch":"🬆","rows":[255,255,255,240,240,240,0,0],"ink":null,"paper":null},{"ch":"🬇","rows":[0,0,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"🬈","rows":[240,240,255,15,15,15,0,0],"ink":null,"paper":null},{"ch":"🬉","rows":[15,15,15,15,15,15,0,0],"ink":null,"paper":null},{"ch":"🬊","rows":[255,255,255,15,15,15,0,0],"ink":null,"paper":null},{"ch":"🬋","rows":[0,0,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"🬌","rows":[240,240,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"🬍","rows":[15,15,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"🬎","rows":[255,255,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"🬏","rows":[0,0,0,0,0,240,240,240],"ink":null,"paper":null},{"ch":"🬐","rows":[240,240,240,0,0,240,240,240],"ink":null,"paper":null},{"ch":"🬑","rows":[15,15,15,0,0,240,240,240],"ink":null,"paper":null},{"ch":"🬒","rows":[255,255,255,0,0,240,240,240],"ink":null,"paper":null},{"ch":"🬓","rows":[0,0,240,240,240,240,240,240],"ink":null,"paper":null},{"ch":"🬔","rows":[15,15,255,240,240,240,240,240],"ink":null,"paper":null},{"ch":"🬕","rows":[255,255,255,240,240,240,240,240],"ink":null,"paper":null},{"ch":"🬖","rows":[0,0,15,15,15,255,240,240],"ink":null,"paper":null},{"ch":"🬗","rows":[240,240,255,15,15,255,240,240],"ink":null,"paper":null},{"ch":"🬘","rows":[15,15,15,15,15,255,240,240],"ink":null,"paper":null},{"ch":"🬙","rows":[255,255,255,15,15,255,240,240],"ink":null,"paper":null},{"ch":"🬚","rows":[0,0,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"🬛","rows":[240,240,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"🬜","rows":[15,15,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"🬝","rows":[255,255,255,255,255,255,240,240],"ink":null,"paper":null},{"ch":"🬞","rows":[0,0,0,0,0,15,15,15],"ink":null,"paper":null},{"ch":"🬟","rows":[240,240,240,0,0,15,15,15],"ink":null,"paper":null},{"ch":"🬠","rows":[15,15,15,0,0,15,15,15],"ink":null,"paper":null},{"ch":"🬡","rows":[255,255,255,0,0,15,15,15],"ink":null,"paper":null},{"ch":"🬢","rows":[0,0,240,240,240,255,15,15],"ink":null,"paper":null},{"ch":"🬣","rows":[240,240,240,240,240,255,15,15],"ink":null,"paper":null},{"ch":"🬤","rows":[15,15,255,240,240,255,15,15],"ink":null,"paper":null},{"ch":"🬥","rows":[255,255,255,240,240,255,15,15],"ink":null,"paper":null},{"ch":"🬦","rows":[0,0,15,15,15,15,15,15],"ink":null,"paper":null},{"ch":"🬧","rows":[240,240,255,15,15,15,15,15],"ink":null,"paper":null},{"ch":"🬨","rows":[255,255,255,15,15,15,15,15],"ink":null,"paper":null},{"ch":"🬩","rows":[0,0,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"🬪","rows":[240,240,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"🬫","rows":[15,15,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"🬬","rows":[255,255,255,255,255,255,15,15],"ink":null,"paper":null},{"ch":"🬭","rows":[0,0,0,0,0,255,255,255],"ink":null,"paper":null},{"ch":"🬮","rows":[240,240,240,0,0,255,255,255],"ink":null,"paper":null},{"ch":"🬯","rows":[15,15,15,0,0,255,255,255],"ink":null,"paper":null},{"ch":"🬰","rows":[255,255,255,0,0,255,255,255],"ink":null,"paper":null},{"ch":"🬱","rows":[0,0,240,240,240,255,255,255],"ink":null,"paper":null},{"ch":"🬲","rows":[240,240,240,240,240,255,255,255],"ink":null,"paper":null},{"ch":"🬳","rows":[15,15,255,240,240,255,255,255],"ink":null,"paper":null},{"ch":"🬴","rows":[255,255,255,240,240,255,255,255],"ink":null,"paper":null},{"ch":"🬵","rows":[0,0,15,15,15,255,255,255],"ink":null,"paper":null},{"ch":"🬶","rows":[240,240,255,15,15,255,255,255],"ink":null,"paper":null},{"ch":"🬷","rows":[15,15,15,15,15,255,255,255],"ink":null,"paper":null},{"ch":"🬸","rows":[255,255,255,15,15,255,255,255],"ink":null,"paper":null},{"ch":"🬹","rows":[0,0,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🬺","rows":[240,240,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🬻","rows":[15,15,255,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🬼","rows":[0,0,0,0,0,128,192,224],"ink":null,"paper":null},{"ch":"🬽","rows":[0,0,0,0,0,192,248,255],"ink":null,"paper":null},{"ch":"🬾","rows":[0,0,128,192,240,248,252,254],"ink":null,"paper":null},{"ch":"🬿","rows":[0,0,128,192,192,224,240,240],"ink":null,"paper":null},{"ch":"🭀","rows":[128,128,192,192,224,224,240,240],"ink":null,"paper":null},{"ch":"🭁","rows":[31,63,127,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🭂","rows":[0,7,63,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🭃","rows":[1,3,7,15,63,127,255,255],"ink":null,"paper":null},{"ch":"🭄","rows":[15,15,31,63,63,127,255,255],"ink":null,"paper":null},{"ch":"🭅","rows":[31,31,63,63,63,127,127,255],"ink":null,"paper":null},{"ch":"🭆","rows":[0,0,0,3,63,255,255,255],"ink":null,"paper":null},{"ch":"🭇","rows":[0,0,0,0,0,1,3,7],"ink":null,"paper":null},{"ch":"🭈","rows":[0,0,0,0,0,3,31,255],"ink":null,"paper":null},{"ch":"🭉","rows":[0,0,1,3,15,31,63,127],"ink":null,"paper":null},{"ch":"🭊","rows":[0,0,1,3,3,7,15,15],"ink":null,"paper":null},{"ch":"🭋","rows":[1,1,3,3,7,7,15,15],"ink":null,"paper":null},{"ch":"🭌","rows":[248,252,254,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🭍","rows":[0,224,252,255,255,255,255,255],"ink":null,"paper":null},{"ch":"🭎","rows":[128,192,224,240,252,254,255,255],"ink":null,"paper":null},{"ch":"🭏","rows":[240,240,248,252,252,254,255,255],"ink":null,"paper":null},{"ch":"🭐","rows":[248,248,252,252,252,254,254,255],"ink":null,"paper":null},{"ch":"🭑","rows":[0,0,0,192,252,255,255,255],"ink":null,"paper":null},{"ch":"🭒","rows":[255,255,255,255,255,127,63,31],"ink":null,"paper":null},{"ch":"🭓","rows":[255,255,255,255,255,63,7,0],"ink":null,"paper":null},{"ch":"🭔","rows":[255,255,127,63,15,7,3,1],"ink":null,"paper":null},{"ch":"🭕","rows":[255,255,127,63,63,31,15,15],"ink":null,"paper":null},{"ch":"🭖","rows":[255,127,127,63,63,63,31,31],"ink":null,"paper":null},{"ch":"🭗","rows":[224,192,128,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🭘","rows":[255,248,192,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🭙","rows":[254,252,248,240,192,128,0,0],"ink":null,"paper":null},{"ch":"🭚","rows":[240,240,224,192,192,128,0,0],"ink":null,"paper":null},{"ch":"🭛","rows":[240,240,224,224,192,192,128,128],"ink":null,"paper":null},{"ch":"🭜","rows":[255,255,255,252,192,0,0,0],"ink":null,"paper":null},{"ch":"🭝","rows":[255,255,255,255,255,254,252,248],"ink":null,"paper":null},{"ch":"🭞","rows":[255,255,255,255,255,252,224,0],"ink":null,"paper":null},{"ch":"🭟","rows":[255,255,254,252,240,224,192,128],"ink":null,"paper":null},{"ch":"🭠","rows":[255,255,254,252,252,248,240,240],"ink":null,"paper":null},{"ch":"🭡","rows":[255,254,254,252,252,252,248,248],"ink":null,"paper":null},{"ch":"🭢","rows":[7,3,1,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🭣","rows":[255,31,3,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🭤","rows":[127,63,31,15,3,1,0,0],"ink":null,"paper":null},{"ch":"🭥","rows":[15,15,7,3,3,1,0,0],"ink":null,"paper":null},{"ch":"🭦","rows":[15,15,7,7,3,3,1,1],"ink":null,"paper":null},{"ch":"🭧","rows":[255,255,255,63,3,0,0,0],"ink":null,"paper":null},{"ch":"🭨","rows":[127,63,31,15,15,31,63,127],"ink":null,"paper":null},{"ch":"🭩","rows":[0,129,195,231,255,255,255,255],"ink":null,"paper":null},{"ch":"🭪","rows":[254,252,248,240,240,248,252,254],"ink":null,"paper":null},{"ch":"🭫","rows":[255,255,255,255,231,195,129,0],"ink":null,"paper":null},{"ch":"🭬","rows":[128,192,224,240,240,224,192,128],"ink":null,"paper":null},{"ch":"🭭","rows":[255,126,60,24,0,0,0,0],"ink":null,"paper":null},{"ch":"🭮","rows":[1,3,7,15,15,7,3,1],"ink":null,"paper":null},{"ch":"🭯","rows":[0,0,0,0,24,60,126,255],"ink":null,"paper":null},{"ch":"🭰","rows":[96,96,96,96,96,96,96,96],"ink":null,"paper":null},{"ch":"🭱","rows":[48,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"🭲","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"🭳","rows":[24,24,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"🭴","rows":[12,12,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"🭵","rows":[6,6,6,6,6,6,6,6],"ink":null,"paper":null},{"ch":"🭶","rows":[0,255,255,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🭷","rows":[0,0,255,255,0,0,0,0],"ink":null,"paper":null},{"ch":"🭸","rows":[0,0,0,255,255,0,0,0],"ink":null,"paper":null},{"ch":"🭹","rows":[0,0,0,255,255,0,0,0],"ink":null,"paper":null},{"ch":"🭺","rows":[0,0,0,0,255,255,0,0],"ink":null,"paper":null},{"ch":"🭻","rows":[0,0,0,0,0,255,255,0],"ink":null,"paper":null},{"ch":"🭼","rows":[192,192,192,192,192,192,192,255],"ink":null,"paper":null},{"ch":"🭽","rows":[255,192,192,192,192,192,192,192],"ink":null,"paper":null},{"ch":"🭾","rows":[255,3,3,3,3,3,3,3],"ink":null,"paper":null},{"ch":"🭿","rows":[3,3,3,3,3,3,3,255],"ink":null,"paper":null},{"ch":"🮀","rows":[255,0,0,0,0,0,0,255],"ink":null,"paper":null},{"ch":"🮁","rows":[255,0,255,0,255,0,0,255],"ink":null,"paper":null},{"ch":"🮂","rows":[255,255,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🮃","rows":[255,255,255,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🮄","rows":[255,255,255,255,255,0,0,0],"ink":null,"paper":null},{"ch":"🮅","rows":[255,255,255,255,255,255,0,0],"ink":null,"paper":null},{"ch":"🮆","rows":[255,255,255,255,255,255,255,0],"ink":null,"paper":null},{"ch":"🮇","rows":[3,3,3,3,3,3,3,3],"ink":null,"paper":null},{"ch":"🮈","rows":[7,7,7,7,7,7,7,7],"ink":null,"paper":null},{"ch":"🮉","rows":[31,31,31,31,31,31,31,31],"ink":null,"paper":null},{"ch":"🮊","rows":[63,63,63,63,63,63,63,63],"ink":null,"paper":null},{"ch":"🮋","rows":[127,127,127,127,127,127,127,127],"ink":null,"paper":null},{"ch":"🮌","rows":[160,80,160,80,160,80,160,80],"ink":null,"paper":null},{"ch":"🮍","rows":[10,5,10,5,10,5,10,5],"ink":null,"paper":null},{"ch":"🮎","rows":[170,85,170,85,0,0,0,0],"ink":null,"paper":null},{"ch":"🮏","rows":[0,0,0,0,170,85,170,85],"ink":null,"paper":null},{"ch":"🮐","rows":[85,170,85,170,85,170,85,170],"ink":null,"paper":null},{"ch":"🮑","rows":[255,255,255,255,85,170,85,170],"ink":null,"paper":null},{"ch":"🮒","rows":[85,170,85,170,255,255,255,255],"ink":null,"paper":null},{"ch":"🮔","rows":[95,175,95,175,95,175,95,175],"ink":null,"paper":null},{"ch":"🮕","rows":[204,204,51,51,204,204,51,51],"ink":null,"paper":null},{"ch":"🮖","rows":[51,51,204,204,51,51,204,204],"ink":null,"paper":null},{"ch":"🮗","rows":[0,255,255,0,0,255,255,0],"ink":null,"paper":null},{"ch":"🮘","rows":[204,102,51,153,204,102,51,153],"ink":null,"paper":null},{"ch":"🮙","rows":[51,102,204,153,51,102,204,153],"ink":null,"paper":null},{"ch":"🮚","rows":[255,126,60,24,24,60,126,255],"ink":null,"paper":null},{"ch":"🮛","rows":[129,195,231,255,255,231,195,129],"ink":null,"paper":null},{"ch":"🮜","rows":[170,84,168,80,160,64,128,0],"ink":null,"paper":null},{"ch":"🮝","rows":[170,85,42,21,10,5,2,1],"ink":null,"paper":null},{"ch":"🮞","rows":[0,1,2,5,10,21,42,85],"ink":null,"paper":null},{"ch":"🮟","rows":[0,128,64,160,80,168,84,170],"ink":null,"paper":null},{"ch":"🮠","rows":[24,48,96,192,128,0,0,0],"ink":null,"paper":null},{"ch":"🮡","rows":[24,12,6,3,1,0,0,0],"ink":null,"paper":null},{"ch":"🮢","rows":[0,0,0,128,192,96,48,24],"ink":null,"paper":null},{"ch":"🮣","rows":[0,0,0,1,3,6,12,24],"ink":null,"paper":null},{"ch":"🮤","rows":[24,48,96,192,192,96,48,24],"ink":null,"paper":null},{"ch":"🮥","rows":[24,12,6,3,3,6,12,24],"ink":null,"paper":null},{"ch":"🮦","rows":[0,0,0,129,195,102,60,24],"ink":null,"paper":null},{"ch":"🮧","rows":[24,60,102,195,129,0,0,0],"ink":null,"paper":null},{"ch":"🮨","rows":[24,48,96,193,131,6,12,24],"ink":null,"paper":null},{"ch":"🮩","rows":[24,12,6,131,193,96,48,24],"ink":null,"paper":null},{"ch":"🮪","rows":[24,12,6,131,195,102,60,24],"ink":null,"paper":null},{"ch":"🮫","rows":[24,48,96,193,195,102,60,24],"ink":null,"paper":null},{"ch":"🮬","rows":[24,60,102,195,131,6,12,24],"ink":null,"paper":null},{"ch":"🮭","rows":[24,60,102,195,193,96,48,24],"ink":null,"paper":null},{"ch":"🮮","rows":[24,60,102,195,195,102,60,24],"ink":null,"paper":null},{"ch":"🮯","rows":[0,24,24,255,255,24,24,0],"ink":null,"paper":null},{"ch":"🮰","rows":[128,192,224,240,248,252,238,129],"ink":null,"paper":null},{"ch":"🮱","rows":[253,249,243,39,15,31,63,255],"ink":null,"paper":null},{"ch":"🮲","rows":[7,3,31,38,47,6,62,16],"ink":null,"paper":null},{"ch":"🮳","rows":[24,224,0,224,48,16,14,0],"ink":null,"paper":null},{"ch":"🮴","rows":[249,249,217,153,1,159,223,255],"ink":null,"paper":null},{"ch":"🮵","rows":[239,16,48,127,127,48,16,239],"ink":null,"paper":null},{"ch":"🮶","rows":[247,8,12,254,254,12,8,247],"ink":null,"paper":null},{"ch":"🮷","rows":[3,27,27,27,126,61,27,3],"ink":null,"paper":null},{"ch":"🮸","rows":[3,27,61,126,27,27,27,3],"ink":null,"paper":null},{"ch":"🮹","rows":[0,62,65,64,64,64,127,0],"ink":null,"paper":null},{"ch":"🮺","rows":[0,0,252,2,2,2,254,0],"ink":null,"paper":null},{"ch":"🮻","rows":[108,108,238,0,238,108,108,0],"ink":null,"paper":null},{"ch":"🮼","rows":[255,3,3,51,51,3,3,255],"ink":null,"paper":null},{"ch":"🮽","rows":[60,153,195,231,195,153,60,126],"ink":null,"paper":null},{"ch":"🮾","rows":[255,255,255,254,252,249,243,231],"ink":null,"paper":null},{"ch":"🮿","rows":[231,195,153,60,60,153,195,231],"ink":null,"paper":null},{"ch":"🯀","rows":[108,146,68,40,68,146,108,0],"ink":null,"paper":null},{"ch":"🯁","rows":[95,96,99,98,100,123,96,95],"ink":null,"paper":null},{"ch":"🯂","rows":[255,4,3,252,2,252,4,248],"ink":null,"paper":null},{"ch":"🯃","rows":[252,2,252,0,0,0,0,0],"ink":null,"paper":null},{"ch":"🯄","rows":[195,153,249,243,231,255,231,255],"ink":null,"paper":null},{"ch":"🯅","rows":[56,56,16,254,16,40,68,130],"ink":null,"paper":null},{"ch":"🯆","rows":[56,56,146,124,16,40,40,40],"ink":null,"paper":null},{"ch":"🯇","rows":[56,56,18,124,144,40,36,34],"ink":null,"paper":null},{"ch":"🯈","rows":[56,56,144,124,18,40,72,136],"ink":null,"paper":null},{"ch":"🯉","rows":[56,56,16,254,16,56,124,254],"ink":null,"paper":null},{"ch":"🯊","rows":[16,40,68,68,68,84,108,68],"ink":null,"paper":null},{"ch":"0","rows":[0,124,206,198,198,198,230,124],"ink":null,"paper":null},{"ch":"1","rows":[0,120,24,24,24,24,24,126],"ink":null,"paper":null},{"ch":"2","rows":[0,124,198,12,56,96,192,254],"ink":null,"paper":null},{"ch":"3","rows":[0,124,198,6,60,6,198,124],"ink":null,"paper":null},{"ch":"4","rows":[0,30,54,102,198,254,6,6],"ink":null,"paper":null},{"ch":"5","rows":[0,254,192,252,6,6,198,124],"ink":null,"paper":null},{"ch":"6","rows":[0,124,198,192,252,198,198,124],"ink":null,"paper":null},{"ch":"7","rows":[0,254,198,12,24,48,96,192],"ink":null,"paper":null},{"ch":"8","rows":[0,124,198,198,124,198,198,124],"ink":null,"paper":null},{"ch":"9","rows":[0,124,198,198,126,6,198,124],"ink":null,"paper":null},{"ch":"A","rows":[0,56,108,198,198,254,198,198],"ink":null,"paper":null},{"ch":"B","rows":[0,252,198,198,252,198,198,252],"ink":null,"paper":null},{"ch":"C","rows":[0,124,198,192,192,192,198,124],"ink":null,"paper":null},{"ch":"D","rows":[0,248,204,198,198,198,204,248],"ink":null,"paper":null},{"ch":"E","rows":[0,254,192,192,248,192,192,254],"ink":null,"paper":null},{"ch":"F","rows":[0,254,192,192,248,192,192,192],"ink":null,"paper":null},{"ch":"G","rows":[0,126,192,192,222,198,198,126],"ink":null,"paper":null},{"ch":"H","rows":[0,198,198,198,254,198,198,198],"ink":null,"paper":null},{"ch":"I","rows":[0,126,24,24,24,24,24,126],"ink":null,"paper":null},{"ch":"J","rows":[0,30,6,6,6,198,198,124],"ink":null,"paper":null},{"ch":"K","rows":[0,198,204,216,240,216,204,198],"ink":null,"paper":null},{"ch":"L","rows":[0,192,192,192,192,192,192,254],"ink":null,"paper":null},{"ch":"M","rows":[0,198,238,254,214,198,198,198],"ink":null,"paper":null},{"ch":"N","rows":[0,198,230,246,222,206,198,198],"ink":null,"paper":null},{"ch":"O","rows":[0,124,198,198,198,198,198,124],"ink":null,"paper":null},{"ch":"P","rows":[0,252,198,198,252,192,192,192],"ink":null,"paper":null},{"ch":"Q","rows":[0,124,198,198,198,222,204,122],"ink":null,"paper":null},{"ch":"R","rows":[0,252,198,198,252,216,204,198],"ink":null,"paper":null},{"ch":"S","rows":[0,124,198,192,124,6,198,124],"ink":null,"paper":null},{"ch":"T","rows":[0,126,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"U","rows":[0,198,198,198,198,198,198,124],"ink":null,"paper":null},{"ch":"V","rows":[0,198,198,198,198,108,56,16],"ink":null,"paper":null},{"ch":"W","rows":[0,198,198,214,254,238,198,198],"ink":null,"paper":null},{"ch":"X","rows":[0,198,238,124,56,124,238,198],"ink":null,"paper":null},{"ch":"Y","rows":[0,102,102,102,60,24,24,24],"ink":null,"paper":null},{"ch":"Z","rows":[0,254,14,28,56,112,224,254],"ink":null,"paper":null},{"ch":"a","rows":[0,0,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"b","rows":[0,192,192,252,198,198,198,252],"ink":null,"paper":null},{"ch":"c","rows":[0,0,0,124,198,192,198,124],"ink":null,"paper":null},{"ch":"d","rows":[0,6,6,126,198,198,198,126],"ink":null,"paper":null},{"ch":"e","rows":[0,0,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"f","rows":[0,60,48,254,48,48,48,48],"ink":null,"paper":null},{"ch":"g","rows":[0,0,0,126,198,126,6,124],"ink":null,"paper":null},{"ch":"h","rows":[0,192,192,252,198,198,198,198],"ink":null,"paper":null},{"ch":"i","rows":[0,24,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"j","rows":[0,6,0,6,6,6,198,124],"ink":null,"paper":null},{"ch":"k","rows":[0,192,192,198,204,248,204,198],"ink":null,"paper":null},{"ch":"l","rows":[0,192,192,192,192,192,112,30],"ink":null,"paper":null},{"ch":"m","rows":[0,0,0,252,214,214,214,214],"ink":null,"paper":null},{"ch":"n","rows":[0,0,0,252,198,198,198,198],"ink":null,"paper":null},{"ch":"o","rows":[0,0,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"p","rows":[0,0,0,252,198,252,192,192],"ink":null,"paper":null},{"ch":"q","rows":[0,0,0,126,198,126,6,6],"ink":null,"paper":null},{"ch":"r","rows":[0,0,0,220,230,192,192,192],"ink":null,"paper":null},{"ch":"s","rows":[0,0,0,126,192,254,6,252],"ink":null,"paper":null},{"ch":"t","rows":[0,48,48,254,48,48,48,62],"ink":null,"paper":null},{"ch":"u","rows":[0,0,0,198,198,198,198,124],"ink":null,"paper":null},{"ch":"v","rows":[0,0,0,198,198,108,56,16],"ink":null,"paper":null},{"ch":"w","rows":[0,0,0,198,214,214,254,108],"ink":null,"paper":null},{"ch":"x","rows":[0,0,0,238,124,56,124,238],"ink":null,"paper":null},{"ch":"y","rows":[0,0,0,198,198,108,56,240],"ink":null,"paper":null},{"ch":"z","rows":[0,0,0,254,28,56,112,254],"ink":null,"paper":null},{"ch":"ª","rows":[0,124,6,126,198,126,0,0],"ink":null,"paper":null},{"ch":"µ","rows":[0,198,198,198,198,252,192,192],"ink":null,"paper":null},{"ch":"º","rows":[0,124,198,198,198,124,0,0],"ink":null,"paper":null},{"ch":"À","rows":[0,32,16,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Á","rows":[0,8,16,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Â","rows":[0,16,40,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Ã","rows":[0,20,40,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Ä","rows":[0,108,0,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Å","rows":[0,56,40,56,108,198,254,198],"ink":null,"paper":null},{"ch":"Æ","rows":[0,62,120,216,222,248,216,222],"ink":null,"paper":null},{"ch":"Ç","rows":[0,124,198,192,198,124,16,32],"ink":null,"paper":null},{"ch":"È","rows":[0,32,16,254,192,248,192,254],"ink":null,"paper":null},{"ch":"É","rows":[0,8,16,254,192,248,192,254],"ink":null,"paper":null},{"ch":"Ê","rows":[0,16,40,254,192,248,192,254],"ink":null,"paper":null},{"ch":"Ë","rows":[0,108,0,254,192,248,192,254],"ink":null,"paper":null},{"ch":"Ì","rows":[0,32,16,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Í","rows":[0,8,16,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Î","rows":[0,16,40,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Ï","rows":[0,108,0,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Ð","rows":[0,120,108,102,246,102,108,120],"ink":null,"paper":null},{"ch":"Ñ","rows":[0,20,40,198,230,214,206,198],"ink":null,"paper":null},{"ch":"Ò","rows":[0,32,16,124,198,198,198,124],"ink":null,"paper":null},{"ch":"Ó","rows":[0,8,16,124,198,198,198,124],"ink":null,"paper":null},{"ch":"Ô","rows":[0,16,40,124,198,198,198,124],"ink":null,"paper":null},{"ch":"Õ","rows":[0,20,40,124,198,198,198,124],"ink":null,"paper":null},{"ch":"Ö","rows":[0,108,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"Ø","rows":[0,124,198,206,214,230,198,124],"ink":null,"paper":null},{"ch":"Ù","rows":[0,32,16,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Ú","rows":[0,8,16,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Û","rows":[0,16,40,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Ü","rows":[0,108,0,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Ý","rows":[0,8,16,198,198,124,56,56],"ink":null,"paper":null},{"ch":"Þ","rows":[0,192,252,198,198,198,252,192],"ink":null,"paper":null},{"ch":"ß","rows":[0,120,204,216,220,198,214,220],"ink":null,"paper":null},{"ch":"à","rows":[0,32,16,124,6,126,198,126],"ink":null,"paper":null},{"ch":"á","rows":[0,8,16,124,6,126,198,126],"ink":null,"paper":null},{"ch":"â","rows":[0,16,40,124,6,126,198,126],"ink":null,"paper":null},{"ch":"ã","rows":[0,20,40,124,6,126,198,126],"ink":null,"paper":null},{"ch":"ä","rows":[0,108,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"å","rows":[0,56,40,124,6,126,198,126],"ink":null,"paper":null},{"ch":"æ","rows":[0,0,0,252,54,254,176,252],"ink":null,"paper":null},{"ch":"ç","rows":[0,0,126,192,192,126,16,32],"ink":null,"paper":null},{"ch":"è","rows":[0,32,16,124,198,254,192,124],"ink":null,"paper":null},{"ch":"é","rows":[0,8,16,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ê","rows":[0,16,40,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ë","rows":[0,108,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ì","rows":[0,32,16,120,24,24,24,254],"ink":null,"paper":null},{"ch":"í","rows":[0,8,16,120,24,24,24,254],"ink":null,"paper":null},{"ch":"î","rows":[0,16,40,120,24,24,24,254],"ink":null,"paper":null},{"ch":"ï","rows":[0,108,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"ð","rows":[0,24,12,126,198,198,198,124],"ink":null,"paper":null},{"ch":"ñ","rows":[0,20,40,252,198,198,198,198],"ink":null,"paper":null},{"ch":"ò","rows":[0,32,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ó","rows":[0,8,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ô","rows":[0,16,40,0,124,198,198,124],"ink":null,"paper":null},{"ch":"õ","rows":[0,20,40,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ö","rows":[0,0,108,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ø","rows":[0,0,0,124,206,214,230,124],"ink":null,"paper":null},{"ch":"ù","rows":[0,32,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ú","rows":[0,8,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"û","rows":[0,16,40,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ü","rows":[0,0,108,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ý","rows":[0,8,16,198,198,108,56,240],"ink":null,"paper":null},{"ch":"þ","rows":[0,192,192,252,198,252,192,192],"ink":null,"paper":null},{"ch":"ÿ","rows":[0,108,0,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ā","rows":[0,124,0,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ā","rows":[0,124,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ă","rows":[0,40,56,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ă","rows":[0,40,56,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ą","rows":[0,56,108,198,254,198,4,2],"ink":null,"paper":null},{"ch":"ą","rows":[0,124,6,126,198,126,4,2],"ink":null,"paper":null},{"ch":"Ć","rows":[0,8,16,124,198,192,198,124],"ink":null,"paper":null},{"ch":"ć","rows":[0,8,16,0,126,192,192,126],"ink":null,"paper":null},{"ch":"Ĉ","rows":[0,16,40,124,198,192,198,124],"ink":null,"paper":null},{"ch":"ĉ","rows":[0,16,40,0,126,192,192,126],"ink":null,"paper":null},{"ch":"Ċ","rows":[0,16,0,124,198,192,198,124],"ink":null,"paper":null},{"ch":"ċ","rows":[0,0,16,0,126,192,192,126],"ink":null,"paper":null},{"ch":"Č","rows":[0,40,16,124,198,192,198,124],"ink":null,"paper":null},{"ch":"č","rows":[0,40,16,0,126,192,192,126],"ink":null,"paper":null},{"ch":"Ď","rows":[0,80,32,248,204,198,204,248],"ink":null,"paper":null},{"ch":"ď","rows":[0,26,26,122,216,216,216,120],"ink":null,"paper":null},{"ch":"Đ","rows":[0,120,108,102,246,102,108,120],"ink":null,"paper":null},{"ch":"đ","rows":[0,12,30,12,124,204,204,124],"ink":null,"paper":null},{"ch":"Ē","rows":[0,124,0,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ē","rows":[0,124,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ĕ","rows":[0,40,56,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ĕ","rows":[0,40,56,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ė","rows":[0,16,0,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ė","rows":[0,16,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ę","rows":[0,254,192,248,192,254,4,2],"ink":null,"paper":null},{"ch":"ę","rows":[0,124,198,254,192,124,8,4],"ink":null,"paper":null},{"ch":"Ě","rows":[0,40,16,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ě","rows":[0,40,16,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ĝ","rows":[0,16,40,126,192,222,198,126],"ink":null,"paper":null},{"ch":"ĝ","rows":[0,16,40,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ğ","rows":[0,40,56,126,192,222,198,126],"ink":null,"paper":null},{"ch":"ğ","rows":[0,40,56,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ġ","rows":[0,16,0,126,192,222,198,126],"ink":null,"paper":null},{"ch":"ġ","rows":[0,16,0,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ģ","rows":[0,126,192,222,198,126,16,32],"ink":null,"paper":null},{"ch":"ģ","rows":[0,16,16,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ĥ","rows":[0,16,40,198,198,254,198,198],"ink":null,"paper":null},{"ch":"ĥ","rows":[0,16,40,192,192,252,198,198],"ink":null,"paper":null},{"ch":"Ħ","rows":[0,108,254,108,124,108,108,108],"ink":null,"paper":null},{"ch":"ħ","rows":[0,96,248,96,124,102,102,102],"ink":null,"paper":null},{"ch":"Ĩ","rows":[0,20,40,254,56,56,56,254],"ink":null,"paper":null},{"ch":"ĩ","rows":[0,20,40,120,24,24,24,254],"ink":null,"paper":null},{"ch":"Ī","rows":[0,124,0,254,56,56,56,254],"ink":null,"paper":null},{"ch":"ī","rows":[0,124,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"Ĭ","rows":[0,40,56,254,56,56,56,254],"ink":null,"paper":null},{"ch":"ĭ","rows":[0,40,56,120,24,24,24,254],"ink":null,"paper":null},{"ch":"Į","rows":[0,254,56,56,56,254,16,8],"ink":null,"paper":null},{"ch":"į","rows":[0,120,24,24,24,254,16,8],"ink":null,"paper":null},{"ch":"İ","rows":[0,24,0,126,24,24,24,126],"ink":null,"paper":null},{"ch":"ı","rows":[0,0,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"Ĳ","rows":[0,206,198,198,198,214,214,204],"ink":null,"paper":null},{"ch":"ĳ","rows":[0,198,0,198,198,214,214,204],"ink":null,"paper":null},{"ch":"Ĵ","rows":[0,4,10,6,6,6,198,124],"ink":null,"paper":null},{"ch":"ĵ","rows":[0,4,10,0,6,6,198,124],"ink":null,"paper":null},{"ch":"Ķ","rows":[0,198,204,248,204,198,16,32],"ink":null,"paper":null},{"ch":"ķ","rows":[0,0,198,204,248,206,16,32],"ink":null,"paper":null},{"ch":"ĸ","rows":[0,0,0,198,204,248,204,198],"ink":null,"paper":null},{"ch":"Ĺ","rows":[0,8,16,192,192,192,192,254],"ink":null,"paper":null},{"ch":"ĺ","rows":[0,8,16,192,192,192,224,62],"ink":null,"paper":null},{"ch":"Ļ","rows":[0,192,192,192,192,254,16,32],"ink":null,"paper":null},{"ch":"ļ","rows":[0,192,192,192,224,62,16,32],"ink":null,"paper":null},{"ch":"Ľ","rows":[0,198,198,194,196,192,192,254],"ink":null,"paper":null},{"ch":"ľ","rows":[0,194,194,194,192,192,112,30],"ink":null,"paper":null},{"ch":"Ŀ","rows":[0,192,192,192,208,192,192,254],"ink":null,"paper":null},{"ch":"ŀ","rows":[0,192,192,192,208,192,112,30],"ink":null,"paper":null},{"ch":"Ł","rows":[0,96,104,112,96,224,96,126],"ink":null,"paper":null},{"ch":"ł","rows":[0,96,104,112,96,224,48,30],"ink":null,"paper":null},{"ch":"Ń","rows":[0,8,16,198,230,214,206,198],"ink":null,"paper":null},{"ch":"ń","rows":[0,8,16,252,198,198,198,198],"ink":null,"paper":null},{"ch":"Ņ","rows":[0,198,230,214,206,198,16,32],"ink":null,"paper":null},{"ch":"ņ","rows":[0,252,198,198,198,198,16,32],"ink":null,"paper":null},{"ch":"Ň","rows":[0,40,16,198,230,214,206,198],"ink":null,"paper":null},{"ch":"ň","rows":[0,40,16,252,198,198,198,198],"ink":null,"paper":null},{"ch":"ŉ","rows":[0,192,64,188,54,54,54,54],"ink":null,"paper":null},{"ch":"Ŋ","rows":[0,220,246,198,198,198,214,220],"ink":null,"paper":null},{"ch":"ŋ","rows":[0,252,198,198,198,198,6,28],"ink":null,"paper":null},{"ch":"Ō","rows":[0,124,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ō","rows":[0,0,124,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ŏ","rows":[0,40,56,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ŏ","rows":[0,40,56,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ő","rows":[0,54,108,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ő","rows":[0,54,108,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Œ","rows":[0,126,216,216,222,216,216,126],"ink":null,"paper":null},{"ch":"œ","rows":[0,0,0,124,182,190,176,124],"ink":null,"paper":null},{"ch":"Ŕ","rows":[0,8,16,252,198,252,216,206],"ink":null,"paper":null},{"ch":"ŕ","rows":[0,8,16,220,230,192,192,192],"ink":null,"paper":null},{"ch":"Ŗ","rows":[0,252,198,252,216,206,16,32],"ink":null,"paper":null},{"ch":"ŗ","rows":[0,220,230,192,192,192,16,32],"ink":null,"paper":null},{"ch":"Ř","rows":[0,40,16,252,198,252,216,206],"ink":null,"paper":null},{"ch":"ř","rows":[0,40,16,220,230,192,192,192],"ink":null,"paper":null},{"ch":"Ś","rows":[0,8,16,254,192,254,6,254],"ink":null,"paper":null},{"ch":"ś","rows":[0,8,16,124,192,124,6,124],"ink":null,"paper":null},{"ch":"Ŝ","rows":[0,16,40,254,192,254,6,254],"ink":null,"paper":null},{"ch":"ŝ","rows":[0,16,40,124,192,124,6,124],"ink":null,"paper":null},{"ch":"Ş","rows":[0,254,192,254,6,254,16,32],"ink":null,"paper":null},{"ch":"ş","rows":[0,124,192,124,6,124,16,32],"ink":null,"paper":null},{"ch":"Š","rows":[0,40,16,254,192,254,6,254],"ink":null,"paper":null},{"ch":"š","rows":[0,40,16,124,192,124,6,124],"ink":null,"paper":null},{"ch":"Ţ","rows":[0,254,56,56,56,56,16,32],"ink":null,"paper":null},{"ch":"ţ","rows":[0,48,254,48,48,62,16,32],"ink":null,"paper":null},{"ch":"Ť","rows":[0,40,16,254,56,56,56,56],"ink":null,"paper":null},{"ch":"ť","rows":[0,50,50,250,48,48,48,62],"ink":null,"paper":null},{"ch":"Ŧ","rows":[0,126,24,24,60,24,24,24],"ink":null,"paper":null},{"ch":"ŧ","rows":[0,48,48,254,48,120,48,62],"ink":null,"paper":null},{"ch":"Ũ","rows":[0,20,40,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ũ","rows":[0,20,40,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ū","rows":[0,124,0,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ū","rows":[0,0,124,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ŭ","rows":[0,40,56,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ŭ","rows":[0,40,56,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ů","rows":[0,56,40,186,130,130,198,124],"ink":null,"paper":null},{"ch":"ů","rows":[0,56,40,56,130,130,198,124],"ink":null,"paper":null},{"ch":"Ű","rows":[0,54,108,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ű","rows":[0,54,108,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ų","rows":[0,198,198,198,198,124,16,8],"ink":null,"paper":null},{"ch":"ų","rows":[0,0,198,198,198,124,8,4],"ink":null,"paper":null},{"ch":"Ŵ","rows":[0,16,40,198,214,254,238,198],"ink":null,"paper":null},{"ch":"ŵ","rows":[0,16,40,198,214,214,254,108],"ink":null,"paper":null},{"ch":"Ŷ","rows":[0,16,40,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ŷ","rows":[0,16,40,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ÿ","rows":[0,108,0,198,198,124,56,56],"ink":null,"paper":null},{"ch":"Ź","rows":[0,8,16,254,28,56,112,254],"ink":null,"paper":null},{"ch":"ź","rows":[0,8,16,0,254,56,112,254],"ink":null,"paper":null},{"ch":"Ż","rows":[0,16,0,254,28,56,112,254],"ink":null,"paper":null},{"ch":"ż","rows":[0,0,16,0,254,56,112,254],"ink":null,"paper":null},{"ch":"Ž","rows":[0,40,16,254,28,56,112,254],"ink":null,"paper":null},{"ch":"ž","rows":[0,40,16,0,254,56,112,254],"ink":null,"paper":null},{"ch":"ſ","rows":[0,30,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"ƀ","rows":[0,96,240,96,124,102,102,124],"ink":null,"paper":null},{"ch":"Ɓ","rows":[0,252,102,102,124,102,102,124],"ink":null,"paper":null},{"ch":"Ƃ","rows":[0,252,192,192,252,198,198,252],"ink":null,"paper":null},{"ch":"ƃ","rows":[0,252,192,252,198,198,198,252],"ink":null,"paper":null},{"ch":"Ƅ","rows":[0,96,224,96,124,102,102,124],"ink":null,"paper":null},{"ch":"ƅ","rows":[0,96,224,124,102,102,102,124],"ink":null,"paper":null},{"ch":"Ɔ","rows":[0,124,198,6,6,6,198,124],"ink":null,"paper":null},{"ch":"Ɖ","rows":[0,120,108,102,246,102,108,120],"ink":null,"paper":null},{"ch":"Ɗ","rows":[0,248,108,102,102,102,108,120],"ink":null,"paper":null},{"ch":"Ǝ","rows":[0,254,6,6,62,6,6,254],"ink":null,"paper":null},{"ch":"Ə","rows":[0,120,204,6,254,198,108,56],"ink":null,"paper":null},{"ch":"Ɛ","rows":[0,124,198,96,56,96,198,124],"ink":null,"paper":null},{"ch":"Ƒ","rows":[0,126,96,124,96,96,96,224],"ink":null,"paper":null},{"ch":"ƒ","rows":[0,14,24,126,24,24,48,224],"ink":null,"paper":null},{"ch":"Ɠ","rows":[0,126,194,192,222,198,198,126],"ink":null,"paper":null},{"ch":"Ɣ","rows":[0,130,198,108,56,56,108,56],"ink":null,"paper":null},{"ch":"Ɨ","rows":[0,126,24,24,60,24,24,126],"ink":null,"paper":null},{"ch":"Ƙ","rows":[0,206,218,208,240,216,204,198],"ink":null,"paper":null},{"ch":"ƙ","rows":[0,224,192,198,204,248,204,198],"ink":null,"paper":null},{"ch":"ƚ","rows":[0,96,96,96,240,96,56,14],"ink":null,"paper":null},{"ch":"Ɲ","rows":[0,102,102,118,126,110,102,230],"ink":null,"paper":null},{"ch":"ƞ","rows":[0,0,0,252,198,198,198,6],"ink":null,"paper":null},{"ch":"Ơ","rows":[0,122,206,204,204,204,204,120],"ink":null,"paper":null},{"ch":"ơ","rows":[0,0,0,122,206,204,204,120],"ink":null,"paper":null},{"ch":"Ƣ","rows":[0,118,154,146,146,146,114,2],"ink":null,"paper":null},{"ch":"ƣ","rows":[0,0,0,118,154,146,114,2],"ink":null,"paper":null},{"ch":"Ƨ","rows":[0,124,198,6,124,192,198,124],"ink":null,"paper":null},{"ch":"ƨ","rows":[0,0,0,124,6,254,192,124],"ink":null,"paper":null},{"ch":"Ʃ","rows":[0,254,96,48,24,48,96,254],"ink":null,"paper":null},{"ch":"Ƭ","rows":[0,126,216,152,24,24,24,24],"ink":null,"paper":null},{"ch":"ƭ","rows":[0,30,48,254,48,48,48,62],"ink":null,"paper":null},{"ch":"Ư","rows":[0,2,206,204,204,204,204,120],"ink":null,"paper":null},{"ch":"ư","rows":[0,0,2,206,204,204,204,120],"ink":null,"paper":null},{"ch":"Ʊ","rows":[0,238,108,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Ʋ","rows":[0,220,206,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Ƴ","rows":[0,206,204,204,120,48,48,48],"ink":null,"paper":null},{"ch":"ƴ","rows":[0,0,0,206,204,104,56,240],"ink":null,"paper":null},{"ch":"Ʒ","rows":[0,252,12,24,28,198,198,124],"ink":null,"paper":null},{"ch":"Ƹ","rows":[0,126,96,48,112,198,198,124],"ink":null,"paper":null},{"ch":"ƹ","rows":[0,0,0,126,32,112,198,124],"ink":null,"paper":null},{"ch":"ǀ","rows":[0,254,56,56,56,56,56,254],"ink":null,"paper":null},{"ch":"ǁ","rows":[0,238,238,238,238,238,238,238],"ink":null,"paper":null},{"ch":"ǂ","rows":[0,56,56,254,56,254,56,56],"ink":null,"paper":null},{"ch":"ǃ","rows":[0,254,254,124,56,0,56,56],"ink":null,"paper":null},{"ch":"Ǉ","rows":[0,134,130,130,130,130,138,228],"ink":null,"paper":null},{"ch":"ǈ","rows":[0,198,192,198,198,246,6,28],"ink":null,"paper":null},{"ch":"ǉ","rows":[0,198,192,198,198,118,6,28],"ink":null,"paper":null},{"ch":"Ǌ","rows":[0,150,146,210,178,146,154,148],"ink":null,"paper":null},{"ch":"ǋ","rows":[0,202,232,186,154,138,2,12],"ink":null,"paper":null},{"ch":"ǌ","rows":[0,242,136,138,138,138,2,12],"ink":null,"paper":null},{"ch":"Ǎ","rows":[0,40,16,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ǎ","rows":[0,40,16,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ǐ","rows":[0,40,16,254,56,56,56,254],"ink":null,"paper":null},{"ch":"ǐ","rows":[0,40,16,120,24,24,24,254],"ink":null,"paper":null},{"ch":"Ǒ","rows":[0,40,16,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ǒ","rows":[0,40,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ǔ","rows":[0,40,16,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ǔ","rows":[0,40,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ǝ","rows":[0,0,0,124,6,254,198,124],"ink":null,"paper":null},{"ch":"Ǥ","rows":[0,124,192,220,204,222,204,124],"ink":null,"paper":null},{"ch":"ǥ","rows":[0,0,124,204,124,12,254,120],"ink":null,"paper":null},{"ch":"Ǧ","rows":[0,40,16,126,192,222,198,126],"ink":null,"paper":null},{"ch":"ǧ","rows":[0,40,16,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ǩ","rows":[0,40,16,198,204,248,204,198],"ink":null,"paper":null},{"ch":"ǩ","rows":[0,40,16,0,198,204,248,206],"ink":null,"paper":null},{"ch":"Ǫ","rows":[0,124,198,198,198,124,8,4],"ink":null,"paper":null},{"ch":"ǫ","rows":[0,0,124,198,198,124,8,4],"ink":null,"paper":null},{"ch":"ǰ","rows":[0,10,4,0,6,6,198,124],"ink":null,"paper":null},{"ch":"Ǵ","rows":[0,8,16,126,192,222,198,126],"ink":null,"paper":null},{"ch":"ǵ","rows":[0,8,16,126,198,126,6,124],"ink":null,"paper":null},{"ch":"Ǹ","rows":[0,32,16,198,230,214,206,198],"ink":null,"paper":null},{"ch":"ǹ","rows":[0,32,16,252,198,198,198,198],"ink":null,"paper":null},{"ch":"Ȍ","rows":[0,216,108,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ȍ","rows":[0,216,108,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ș","rows":[0,254,192,254,6,254,16,16],"ink":null,"paper":null},{"ch":"ș","rows":[0,124,192,124,6,124,16,16],"ink":null,"paper":null},{"ch":"Ț","rows":[0,254,56,56,56,56,16,16],"ink":null,"paper":null},{"ch":"ț","rows":[0,48,254,48,48,62,16,16],"ink":null,"paper":null},{"ch":"Ȟ","rows":[0,40,16,198,198,254,198,198],"ink":null,"paper":null},{"ch":"ȟ","rows":[0,40,16,192,192,252,198,198],"ink":null,"paper":null},{"ch":"Ƞ","rows":[0,252,198,198,198,198,198,6],"ink":null,"paper":null},{"ch":"Ȣ","rows":[0,12,102,198,124,198,198,124],"ink":null,"paper":null},{"ch":"ȣ","rows":[0,0,0,198,124,198,198,124],"ink":null,"paper":null},{"ch":"Ȧ","rows":[0,16,0,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ȧ","rows":[0,16,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ȩ","rows":[0,254,192,248,192,254,16,32],"ink":null,"paper":null},{"ch":"ȩ","rows":[0,124,198,254,192,124,16,32],"ink":null,"paper":null},{"ch":"Ȯ","rows":[0,16,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ȯ","rows":[0,0,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ȳ","rows":[0,124,0,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ȳ","rows":[0,124,0,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ƚ","rows":[0,96,96,96,240,96,96,126],"ink":null,"paper":null},{"ch":"Ɂ","rows":[0,124,198,6,6,60,48,48],"ink":null,"paper":null},{"ch":"ɂ","rows":[0,0,0,124,198,6,60,48],"ink":null,"paper":null},{"ch":"Ƀ","rows":[0,124,102,124,102,246,102,124],"ink":null,"paper":null},{"ch":"Ʉ","rows":[0,108,108,254,108,108,108,56],"ink":null,"paper":null},{"ch":"Ʌ","rows":[0,16,56,108,198,198,198,198],"ink":null,"paper":null},{"ch":"ɑ","rows":[0,0,0,118,206,206,206,118],"ink":null,"paper":null},{"ch":"ɒ","rows":[0,0,0,220,230,230,230,220],"ink":null,"paper":null},{"ch":"ɓ","rows":[0,224,192,252,198,198,198,252],"ink":null,"paper":null},{"ch":"ɔ","rows":[0,0,0,124,198,6,198,124],"ink":null,"paper":null},{"ch":"ɖ","rows":[0,12,124,204,204,124,12,14],"ink":null,"paper":null},{"ch":"ɗ","rows":[0,14,12,124,204,204,204,124],"ink":null,"paper":null},{"ch":"ɘ","rows":[0,0,0,124,198,254,6,124],"ink":null,"paper":null},{"ch":"ə","rows":[0,0,0,252,6,254,198,124],"ink":null,"paper":null},{"ch":"ɛ","rows":[0,0,0,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ɠ","rows":[0,0,2,126,198,126,6,124],"ink":null,"paper":null},{"ch":"ɣ","rows":[0,0,0,198,108,56,108,56],"ink":null,"paper":null},{"ch":"ɨ","rows":[0,24,0,120,24,124,24,254],"ink":null,"paper":null},{"ch":"ɪ","rows":[0,0,0,126,24,24,24,126],"ink":null,"paper":null},{"ch":"ɲ","rows":[0,0,0,124,102,102,102,230],"ink":null,"paper":null},{"ch":"ɸ","rows":[0,0,16,124,214,214,124,16],"ink":null,"paper":null},{"ch":"ʃ","rows":[0,14,24,24,24,24,24,112],"ink":null,"paper":null},{"ch":"ʉ","rows":[0,0,0,108,254,108,108,56],"ink":null,"paper":null},{"ch":"ʋ","rows":[0,0,0,220,206,198,198,124],"ink":null,"paper":null},{"ch":"ʌ","rows":[0,0,0,16,56,108,198,198],"ink":null,"paper":null},{"ch":"ʒ","rows":[0,0,0,252,8,28,198,124],"ink":null,"paper":null},{"ch":"ʔ","rows":[0,124,198,6,6,60,48,48],"ink":null,"paper":null},{"ch":"ʕ","rows":[0,124,198,192,192,120,24,24],"ink":null,"paper":null},{"ch":"ʖ","rows":[0,48,48,60,6,6,198,124],"ink":null,"paper":null},{"ch":"ʬ","rows":[0,214,254,108,0,214,254,108],"ink":null,"paper":null},{"ch":"ʭ","rows":[0,124,68,68,0,124,68,68],"ink":null,"paper":null},{"ch":"ʹ","rows":[0,48,48,16,32,0,0,0],"ink":null,"paper":null},{"ch":"ʺ","rows":[0,108,108,36,72,0,0,0],"ink":null,"paper":null},{"ch":"ʻ","rows":[0,16,32,48,48,0,0,0],"ink":null,"paper":null},{"ch":"ʼ","rows":[0,48,48,16,32,0,0,0],"ink":null,"paper":null},{"ch":"ʽ","rows":[0,48,48,32,16,0,0,0],"ink":null,"paper":null},{"ch":"ˆ","rows":[0,16,40,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˇ","rows":[0,40,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˈ","rows":[0,16,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˉ","rows":[0,124,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˊ","rows":[0,8,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˋ","rows":[0,32,16,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ˌ","rows":[0,0,0,0,0,0,16,16],"ink":null,"paper":null},{"ch":"ˍ","rows":[0,0,0,0,0,0,0,124],"ink":null,"paper":null},{"ch":"ˎ","rows":[0,0,0,0,0,0,32,16],"ink":null,"paper":null},{"ch":"ˏ","rows":[0,0,0,0,0,0,8,16],"ink":null,"paper":null},{"ch":"ː","rows":[0,0,0,56,16,0,16,56],"ink":null,"paper":null},{"ch":"ˑ","rows":[0,0,0,56,16,0,0,0],"ink":null,"paper":null},{"ch":"ˮ","rows":[0,108,108,36,72,0,0,0],"ink":null,"paper":null},{"ch":"Ͱ","rows":[0,192,192,192,254,192,192,192],"ink":null,"paper":null},{"ch":"ͱ","rows":[0,0,0,112,176,190,48,48],"ink":null,"paper":null},{"ch":"Ͳ","rows":[0,254,146,146,146,16,16,16],"ink":null,"paper":null},{"ch":"ͳ","rows":[0,124,84,84,16,16,16,16],"ink":null,"paper":null},{"ch":"Ͷ","rows":[0,198,206,222,214,246,230,198],"ink":null,"paper":null},{"ch":"ͷ","rows":[0,0,0,136,152,184,234,196],"ink":null,"paper":null},{"ch":"ͺ","rows":[0,0,0,0,0,0,16,16],"ink":null,"paper":null},{"ch":"ͻ","rows":[0,0,0,124,198,6,198,124],"ink":null,"paper":null},{"ch":"ͼ","rows":[0,0,0,124,198,208,198,124],"ink":null,"paper":null},{"ch":"ͽ","rows":[0,0,0,124,198,22,198,124],"ink":null,"paper":null},{"ch":"Ϳ","rows":[0,30,6,6,6,198,198,124],"ink":null,"paper":null},{"ch":"Ά","rows":[0,152,188,102,102,126,102,102],"ink":null,"paper":null},{"ch":"Έ","rows":[0,190,176,48,60,48,48,62],"ink":null,"paper":null},{"ch":"Ή","rows":[0,182,182,54,62,54,54,54],"ink":null,"paper":null},{"ch":"Ί","rows":[0,190,152,24,24,24,24,126],"ink":null,"paper":null},{"ch":"Ό","rows":[0,156,182,54,54,54,54,28],"ink":null,"paper":null},{"ch":"Ύ","rows":[0,182,182,54,28,8,8,8],"ink":null,"paper":null},{"ch":"Ώ","rows":[0,156,182,54,54,54,20,54],"ink":null,"paper":null},{"ch":"ΐ","rows":[0,16,84,0,120,24,24,30],"ink":null,"paper":null},{"ch":"Α","rows":[0,56,108,198,198,254,198,198],"ink":null,"paper":null},{"ch":"Β","rows":[0,252,198,198,252,198,198,252],"ink":null,"paper":null},{"ch":"Γ","rows":[0,254,192,192,192,192,192,192],"ink":null,"paper":null},{"ch":"Δ","rows":[0,56,108,108,108,198,198,254],"ink":null,"paper":null},{"ch":"Ε","rows":[0,254,192,192,252,192,192,254],"ink":null,"paper":null},{"ch":"Ζ","rows":[0,254,14,28,56,112,224,254],"ink":null,"paper":null},{"ch":"Η","rows":[0,198,198,198,254,198,198,198],"ink":null,"paper":null},{"ch":"Θ","rows":[0,124,198,198,214,198,198,124],"ink":null,"paper":null},{"ch":"Ι","rows":[0,126,24,24,24,24,24,126],"ink":null,"paper":null},{"ch":"Κ","rows":[0,198,204,216,240,216,204,198],"ink":null,"paper":null},{"ch":"Λ","rows":[0,56,56,108,108,198,198,198],"ink":null,"paper":null},{"ch":"Μ","rows":[0,198,238,254,214,198,198,198],"ink":null,"paper":null},{"ch":"Ν","rows":[0,198,230,246,222,206,198,198],"ink":null,"paper":null},{"ch":"Ξ","rows":[0,254,0,0,124,0,0,254],"ink":null,"paper":null},{"ch":"Ο","rows":[0,124,198,198,198,198,198,124],"ink":null,"paper":null},{"ch":"Π","rows":[0,254,198,198,198,198,198,198],"ink":null,"paper":null},{"ch":"Ρ","rows":[0,252,198,198,252,192,192,192],"ink":null,"paper":null},{"ch":"Σ","rows":[0,254,96,48,24,48,96,254],"ink":null,"paper":null},{"ch":"Τ","rows":[0,126,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"Υ","rows":[0,102,102,102,60,24,24,24],"ink":null,"paper":null},{"ch":"Φ","rows":[0,16,124,214,214,214,124,16],"ink":null,"paper":null},{"ch":"Χ","rows":[0,198,238,124,56,124,238,198],"ink":null,"paper":null},{"ch":"Ψ","rows":[0,214,214,214,124,56,16,16],"ink":null,"paper":null},{"ch":"Ω","rows":[0,124,198,198,198,198,108,238],"ink":null,"paper":null},{"ch":"Ϊ","rows":[0,108,0,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Ϋ","rows":[0,108,0,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ά","rows":[0,8,16,0,122,198,198,122],"ink":null,"paper":null},{"ch":"έ","rows":[0,8,16,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ή","rows":[0,8,16,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ί","rows":[0,8,16,0,120,24,24,30],"ink":null,"paper":null},{"ch":"ΰ","rows":[0,16,84,0,198,198,198,124],"ink":null,"paper":null},{"ch":"α","rows":[0,0,0,122,198,198,198,122],"ink":null,"paper":null},{"ch":"β","rows":[0,124,198,220,198,198,252,192],"ink":null,"paper":null},{"ch":"γ","rows":[0,0,0,198,198,124,56,56],"ink":null,"paper":null},{"ch":"δ","rows":[0,252,96,48,124,198,198,124],"ink":null,"paper":null},{"ch":"ε","rows":[0,0,0,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ζ","rows":[0,248,24,112,192,252,6,28],"ink":null,"paper":null},{"ch":"η","rows":[0,0,0,252,198,198,198,6],"ink":null,"paper":null},{"ch":"θ","rows":[0,0,0,124,198,254,198,124],"ink":null,"paper":null},{"ch":"ι","rows":[0,0,0,120,24,24,24,30],"ink":null,"paper":null},{"ch":"κ","rows":[0,0,0,198,204,248,204,198],"ink":null,"paper":null},{"ch":"λ","rows":[0,192,96,48,56,108,198,198],"ink":null,"paper":null},{"ch":"μ","rows":[0,0,0,198,198,198,252,192],"ink":null,"paper":null},{"ch":"ν","rows":[0,0,0,198,198,108,56,16],"ink":null,"paper":null},{"ch":"ξ","rows":[0,120,192,112,192,124,6,12],"ink":null,"paper":null},{"ch":"ο","rows":[0,0,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"π","rows":[0,0,0,254,108,108,108,108],"ink":null,"paper":null},{"ch":"ρ","rows":[0,0,0,124,198,198,252,192],"ink":null,"paper":null},{"ch":"ς","rows":[0,0,0,126,192,124,6,28],"ink":null,"paper":null},{"ch":"σ","rows":[0,0,0,126,204,204,204,120],"ink":null,"paper":null},{"ch":"τ","rows":[0,0,0,126,24,24,24,24],"ink":null,"paper":null},{"ch":"υ","rows":[0,0,0,198,198,198,198,124],"ink":null,"paper":null},{"ch":"φ","rows":[0,0,0,92,214,214,124,16],"ink":null,"paper":null},{"ch":"χ","rows":[0,0,0,238,124,56,124,238],"ink":null,"paper":null},{"ch":"ψ","rows":[0,0,0,214,214,124,16,16],"ink":null,"paper":null},{"ch":"ω","rows":[0,0,0,68,214,214,124,40],"ink":null,"paper":null},{"ch":"ϊ","rows":[0,108,0,120,24,24,24,30],"ink":null,"paper":null},{"ch":"ϋ","rows":[0,0,108,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ό","rows":[0,8,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ύ","rows":[0,8,16,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ώ","rows":[0,8,16,68,214,214,124,40],"ink":null,"paper":null},{"ch":"Ϗ","rows":[0,198,204,248,204,198,2,4],"ink":null,"paper":null},{"ch":"ϐ","rows":[0,56,108,248,192,252,102,60],"ink":null,"paper":null},{"ch":"ϑ","rows":[0,28,54,54,30,198,76,120],"ink":null,"paper":null},{"ch":"ϒ","rows":[0,206,204,204,120,48,48,48],"ink":null,"paper":null},{"ch":"ϓ","rows":[0,86,148,20,28,8,8,8],"ink":null,"paper":null},{"ch":"ϔ","rows":[0,108,0,206,204,120,48,48],"ink":null,"paper":null},{"ch":"ϕ","rows":[0,0,16,124,214,214,124,16],"ink":null,"paper":null},{"ch":"ϖ","rows":[0,0,0,254,68,146,146,108],"ink":null,"paper":null},{"ch":"ϗ","rows":[0,102,44,56,104,206,2,4],"ink":null,"paper":null},{"ch":"Ϙ","rows":[0,124,198,198,198,198,124,16],"ink":null,"paper":null},{"ch":"ϙ","rows":[0,0,0,124,198,198,124,16],"ink":null,"paper":null},{"ch":"Ϛ","rows":[0,124,198,192,192,120,24,24],"ink":null,"paper":null},{"ch":"ϛ","rows":[0,0,0,124,194,120,12,120],"ink":null,"paper":null},{"ch":"Ϝ","rows":[0,254,192,192,252,196,192,192],"ink":null,"paper":null},{"ch":"ϝ","rows":[0,124,96,96,120,104,96,96],"ink":null,"paper":null},{"ch":"Ϟ","rows":[0,128,68,76,84,100,68,2],"ink":null,"paper":null},{"ch":"ϟ","rows":[0,48,96,192,254,6,12,24],"ink":null,"paper":null},{"ch":"Ϡ","rows":[0,240,72,76,20,34,34,12],"ink":null,"paper":null},{"ch":"ϡ","rows":[0,192,48,24,44,84,34,2],"ink":null,"paper":null},{"ch":"Ϣ","rows":[0,214,214,214,214,110,2,252],"ink":null,"paper":null},{"ch":"ϣ","rows":[0,0,0,214,214,110,2,252],"ink":null,"paper":null},{"ch":"Ϥ","rows":[0,118,198,198,126,6,6,6],"ink":null,"paper":null},{"ch":"ϥ","rows":[0,118,198,198,198,126,6,6],"ink":null,"paper":null},{"ch":"Ϧ","rows":[0,192,192,252,198,198,6,252],"ink":null,"paper":null},{"ch":"ϧ","rows":[0,58,108,220,118,6,108,184],"ink":null,"paper":null},{"ch":"Ϩ","rows":[0,124,198,6,124,192,198,124],"ink":null,"paper":null},{"ch":"ϩ","rows":[0,124,198,6,124,192,192,126],"ink":null,"paper":null},{"ch":"Ϫ","rows":[0,108,146,16,40,68,130,254],"ink":null,"paper":null},{"ch":"ϫ","rows":[0,0,0,108,146,40,68,124],"ink":null,"paper":null},{"ch":"Ϭ","rows":[0,126,192,252,198,198,198,124],"ink":null,"paper":null},{"ch":"ϭ","rows":[0,0,0,126,192,220,198,124],"ink":null,"paper":null},{"ch":"Ϯ","rows":[0,16,16,124,146,16,16,16],"ink":null,"paper":null},{"ch":"ϯ","rows":[0,24,16,254,144,16,16,48],"ink":null,"paper":null},{"ch":"ϰ","rows":[0,0,0,102,44,56,104,204],"ink":null,"paper":null},{"ch":"ϱ","rows":[0,60,102,102,124,96,60,2],"ink":null,"paper":null},{"ch":"ϲ","rows":[0,0,0,124,198,192,198,124],"ink":null,"paper":null},{"ch":"ϳ","rows":[0,6,0,6,6,6,198,124],"ink":null,"paper":null},{"ch":"ϴ","rows":[0,124,198,198,254,198,198,124],"ink":null,"paper":null},{"ch":"ϵ","rows":[0,0,0,126,192,248,192,126],"ink":null,"paper":null},{"ch":"Ϸ","rows":[0,192,252,198,198,198,252,192],"ink":null,"paper":null},{"ch":"ϸ","rows":[0,192,192,252,198,252,192,192],"ink":null,"paper":null},{"ch":"Ϲ","rows":[0,124,198,192,192,192,198,124],"ink":null,"paper":null},{"ch":"Ϻ","rows":[0,238,254,214,198,198,198,198],"ink":null,"paper":null},{"ch":"ϻ","rows":[0,0,198,238,254,214,198,192],"ink":null,"paper":null},{"ch":"ϼ","rows":[0,60,102,102,124,96,240,96],"ink":null,"paper":null},{"ch":"Ͻ","rows":[0,124,198,6,6,6,198,124],"ink":null,"paper":null},{"ch":"Ͼ","rows":[0,124,198,192,208,192,198,124],"ink":null,"paper":null},{"ch":"Ͽ","rows":[0,124,198,6,22,6,198,124],"ink":null,"paper":null},{"ch":"Ѐ","rows":[0,32,16,254,192,252,192,254],"ink":null,"paper":null},{"ch":"Ё","rows":[0,108,0,254,192,252,192,254],"ink":null,"paper":null},{"ch":"Ђ","rows":[0,248,96,124,102,102,102,108],"ink":null,"paper":null},{"ch":"Ѓ","rows":[0,8,16,254,192,192,192,192],"ink":null,"paper":null},{"ch":"Є","rows":[0,124,198,192,240,192,198,124],"ink":null,"paper":null},{"ch":"Ѕ","rows":[0,124,198,192,124,6,198,124],"ink":null,"paper":null},{"ch":"І","rows":[0,126,24,24,24,24,24,126],"ink":null,"paper":null},{"ch":"Ї","rows":[0,108,0,254,56,56,56,254],"ink":null,"paper":null},{"ch":"Ј","rows":[0,30,6,6,6,198,198,124],"ink":null,"paper":null},{"ch":"Љ","rows":[0,120,216,216,220,218,218,220],"ink":null,"paper":null},{"ch":"Њ","rows":[0,216,216,216,252,218,218,220],"ink":null,"paper":null},{"ch":"Ћ","rows":[0,248,96,124,102,102,102,102],"ink":null,"paper":null},{"ch":"Ќ","rows":[0,8,16,198,204,248,204,198],"ink":null,"paper":null},{"ch":"Ѝ","rows":[0,32,16,198,206,222,246,230],"ink":null,"paper":null},{"ch":"Ў","rows":[0,40,16,198,108,60,24,240],"ink":null,"paper":null},{"ch":"Џ","rows":[0,198,198,198,198,254,56,56],"ink":null,"paper":null},{"ch":"А","rows":[0,56,108,198,198,254,198,198],"ink":null,"paper":null},{"ch":"Б","rows":[0,252,192,192,252,198,198,252],"ink":null,"paper":null},{"ch":"В","rows":[0,252,198,198,252,198,198,252],"ink":null,"paper":null},{"ch":"Г","rows":[0,254,192,192,192,192,192,192],"ink":null,"paper":null},{"ch":"Д","rows":[0,124,108,108,108,108,254,198],"ink":null,"paper":null},{"ch":"Е","rows":[0,254,192,192,252,192,192,254],"ink":null,"paper":null},{"ch":"Ж","rows":[0,214,214,124,56,124,214,214],"ink":null,"paper":null},{"ch":"З","rows":[0,124,198,6,28,6,198,124],"ink":null,"paper":null},{"ch":"И","rows":[0,198,206,222,214,246,230,198],"ink":null,"paper":null},{"ch":"Й","rows":[0,40,16,198,206,222,246,230],"ink":null,"paper":null},{"ch":"К","rows":[0,198,204,216,240,216,204,198],"ink":null,"paper":null},{"ch":"Л","rows":[0,62,102,102,102,102,102,198],"ink":null,"paper":null},{"ch":"М","rows":[0,198,238,254,214,198,198,198],"ink":null,"paper":null},{"ch":"Н","rows":[0,198,198,198,254,198,198,198],"ink":null,"paper":null},{"ch":"О","rows":[0,124,198,198,198,198,198,124],"ink":null,"paper":null},{"ch":"П","rows":[0,254,198,198,198,198,198,198],"ink":null,"paper":null},{"ch":"Р","rows":[0,252,198,198,252,192,192,192],"ink":null,"paper":null},{"ch":"С","rows":[0,124,198,192,192,192,198,124],"ink":null,"paper":null},{"ch":"Т","rows":[0,126,24,24,24,24,24,24],"ink":null,"paper":null},{"ch":"У","rows":[0,198,198,108,60,24,48,224],"ink":null,"paper":null},{"ch":"Ф","rows":[0,16,124,214,214,214,124,16],"ink":null,"paper":null},{"ch":"Х","rows":[0,198,238,124,56,124,238,198],"ink":null,"paper":null},{"ch":"Ц","rows":[0,204,204,204,204,204,254,6],"ink":null,"paper":null},{"ch":"Ч","rows":[0,198,198,198,254,6,6,6],"ink":null,"paper":null},{"ch":"Ш","rows":[0,214,214,214,214,214,214,254],"ink":null,"paper":null},{"ch":"Щ","rows":[0,214,214,214,214,214,254,6],"ink":null,"paper":null},{"ch":"Ъ","rows":[0,224,96,124,102,102,102,124],"ink":null,"paper":null},{"ch":"Ы","rows":[0,198,198,198,230,214,214,230],"ink":null,"paper":null},{"ch":"Ь","rows":[0,192,192,192,252,198,198,252],"ink":null,"paper":null},{"ch":"Э","rows":[0,124,198,6,30,6,198,124],"ink":null,"paper":null},{"ch":"Ю","rows":[0,156,182,182,246,182,182,156],"ink":null,"paper":null},{"ch":"Я","rows":[0,126,198,198,126,54,102,198],"ink":null,"paper":null},{"ch":"а","rows":[0,0,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"б","rows":[0,124,192,252,198,198,198,124],"ink":null,"paper":null},{"ch":"в","rows":[0,0,0,252,198,252,198,252],"ink":null,"paper":null},{"ch":"г","rows":[0,0,0,254,192,192,192,192],"ink":null,"paper":null},{"ch":"д","rows":[0,0,0,124,108,108,254,198],"ink":null,"paper":null},{"ch":"е","rows":[0,0,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ж","rows":[0,0,0,214,214,124,214,214],"ink":null,"paper":null},{"ch":"з","rows":[0,0,0,124,198,28,198,124],"ink":null,"paper":null},{"ch":"и","rows":[0,0,0,198,206,222,246,230],"ink":null,"paper":null},{"ch":"й","rows":[0,40,16,0,206,222,246,230],"ink":null,"paper":null},{"ch":"к","rows":[0,0,0,198,204,248,204,198],"ink":null,"paper":null},{"ch":"л","rows":[0,0,0,62,102,102,102,198],"ink":null,"paper":null},{"ch":"м","rows":[0,0,0,198,238,254,214,198],"ink":null,"paper":null},{"ch":"н","rows":[0,0,0,198,198,254,198,198],"ink":null,"paper":null},{"ch":"о","rows":[0,0,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"п","rows":[0,0,0,254,198,198,198,198],"ink":null,"paper":null},{"ch":"р","rows":[0,0,0,252,198,252,192,192],"ink":null,"paper":null},{"ch":"с","rows":[0,0,0,124,198,192,198,124],"ink":null,"paper":null},{"ch":"т","rows":[0,0,0,126,24,24,24,24],"ink":null,"paper":null},{"ch":"у","rows":[0,0,0,198,108,60,24,240],"ink":null,"paper":null},{"ch":"ф","rows":[0,0,16,124,214,214,124,16],"ink":null,"paper":null},{"ch":"х","rows":[0,0,0,238,124,56,124,238],"ink":null,"paper":null},{"ch":"ц","rows":[0,0,0,204,204,204,254,6],"ink":null,"paper":null},{"ch":"ч","rows":[0,0,0,198,198,254,6,6],"ink":null,"paper":null},{"ch":"ш","rows":[0,0,0,214,214,214,214,254],"ink":null,"paper":null},{"ch":"щ","rows":[0,0,0,214,214,214,254,6],"ink":null,"paper":null},{"ch":"ъ","rows":[0,0,0,224,96,124,102,124],"ink":null,"paper":null},{"ch":"ы","rows":[0,0,0,198,198,230,214,230],"ink":null,"paper":null},{"ch":"ь","rows":[0,0,0,192,192,252,198,252],"ink":null,"paper":null},{"ch":"э","rows":[0,0,0,124,198,30,198,124],"ink":null,"paper":null},{"ch":"ю","rows":[0,0,0,156,182,246,182,156],"ink":null,"paper":null},{"ch":"я","rows":[0,0,0,126,198,126,54,102],"ink":null,"paper":null},{"ch":"ѐ","rows":[0,32,16,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ё","rows":[0,108,0,124,198,254,192,124],"ink":null,"paper":null},{"ch":"ђ","rows":[0,240,96,124,102,102,102,12],"ink":null,"paper":null},{"ch":"ѓ","rows":[0,8,16,0,254,192,192,192],"ink":null,"paper":null},{"ch":"є","rows":[0,0,0,124,198,240,198,124],"ink":null,"paper":null},{"ch":"ѕ","rows":[0,0,0,126,192,254,6,252],"ink":null,"paper":null},{"ch":"і","rows":[0,24,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"ї","rows":[0,108,0,120,24,24,24,254],"ink":null,"paper":null},{"ch":"ј","rows":[0,6,0,6,6,6,198,124],"ink":null,"paper":null},{"ch":"љ","rows":[0,0,0,120,216,220,218,220],"ink":null,"paper":null},{"ch":"њ","rows":[0,0,0,216,216,252,218,220],"ink":null,"paper":null},{"ch":"ћ","rows":[0,96,240,96,124,102,102,102],"ink":null,"paper":null},{"ch":"ќ","rows":[0,8,16,0,198,204,248,206],"ink":null,"paper":null},{"ch":"ѝ","rows":[0,32,16,0,206,222,246,230],"ink":null,"paper":null},{"ch":"ў","rows":[0,40,16,0,108,60,24,240],"ink":null,"paper":null},{"ch":"џ","rows":[0,0,0,198,198,198,254,56],"ink":null,"paper":null},{"ch":"Ѡ","rows":[0,108,130,130,186,146,124,40],"ink":null,"paper":null},{"ch":"ѡ","rows":[0,0,0,214,214,214,124,108],"ink":null,"paper":null},{"ch":"Ѣ","rows":[0,32,248,32,60,38,38,60],"ink":null,"paper":null},{"ch":"ѣ","rows":[0,32,32,248,32,60,38,60],"ink":null,"paper":null},{"ch":"Ѥ","rows":[0,204,218,216,252,216,218,204],"ink":null,"paper":null},{"ch":"ѥ","rows":[0,0,0,206,216,252,216,206],"ink":null,"paper":null},{"ch":"Ѧ","rows":[0,16,56,108,198,254,214,214],"ink":null,"paper":null},{"ch":"ѧ","rows":[0,0,0,56,108,198,254,214],"ink":null,"paper":null},{"ch":"Ѩ","rows":[0,136,156,182,162,254,170,170],"ink":null,"paper":null},{"ch":"ѩ","rows":[0,0,0,156,182,162,254,170],"ink":null,"paper":null},{"ch":"Ѫ","rows":[0,254,198,108,16,124,214,214],"ink":null,"paper":null},{"ch":"ѫ","rows":[0,0,0,124,40,16,124,214],"ink":null,"paper":null},{"ch":"Ѭ","rows":[0,190,162,148,136,252,170,170],"ink":null,"paper":null},{"ch":"ѭ","rows":[0,0,0,190,148,136,252,170],"ink":null,"paper":null},{"ch":"Ѵ","rows":[0,198,206,204,204,204,120,48],"ink":null,"paper":null},{"ch":"ѵ","rows":[0,0,0,198,204,204,120,48],"ink":null,"paper":null},{"ch":"Ҁ","rows":[0,124,198,192,192,120,24,24],"ink":null,"paper":null},{"ch":"ҁ","rows":[0,0,0,124,198,192,120,24],"ink":null,"paper":null},{"ch":"Ҍ","rows":[0,96,240,96,124,102,102,124],"ink":null,"paper":null},{"ch":"ҍ","rows":[0,96,96,240,96,124,102,124],"ink":null,"paper":null},{"ch":"Ҏ","rows":[0,252,198,214,252,200,192,192],"ink":null,"paper":null},{"ch":"ҏ","rows":[0,0,0,252,214,252,200,192],"ink":null,"paper":null},{"ch":"Ґ","rows":[0,2,254,192,192,192,192,192],"ink":null,"paper":null},{"ch":"ґ","rows":[0,0,2,254,192,192,192,192],"ink":null,"paper":null},{"ch":"Ғ","rows":[0,126,96,96,248,96,96,96],"ink":null,"paper":null},{"ch":"ғ","rows":[0,0,0,126,96,248,96,96],"ink":null,"paper":null},{"ch":"Ҕ","rows":[0,252,192,252,198,198,6,252],"ink":null,"paper":null},{"ch":"ҕ","rows":[0,0,0,252,192,252,6,252],"ink":null,"paper":null},{"ch":"Җ","rows":[0,214,124,56,124,214,214,2],"ink":null,"paper":null},{"ch":"җ","rows":[0,0,214,214,124,214,214,2],"ink":null,"paper":null},{"ch":"Ҙ","rows":[0,124,198,28,198,124,16,48],"ink":null,"paper":null},{"ch":"ҙ","rows":[0,124,6,28,6,124,16,48],"ink":null,"paper":null},{"ch":"Қ","rows":[0,206,216,240,216,204,198,2],"ink":null,"paper":null},{"ch":"қ","rows":[0,0,198,204,248,204,198,2],"ink":null,"paper":null},{"ch":"Ҝ","rows":[0,134,172,184,240,184,172,134],"ink":null,"paper":null},{"ch":"ҝ","rows":[0,0,0,134,172,248,172,134],"ink":null,"paper":null},{"ch":"Ҟ","rows":[0,70,236,88,112,88,76,70],"ink":null,"paper":null},{"ch":"ҟ","rows":[0,64,224,70,76,120,76,70],"ink":null,"paper":null},{"ch":"Ҡ","rows":[0,230,108,120,112,120,108,102],"ink":null,"paper":null},{"ch":"ҡ","rows":[0,0,0,230,108,120,108,102],"ink":null,"paper":null},{"ch":"Ң","rows":[0,204,204,252,204,204,206,2],"ink":null,"paper":null},{"ch":"ң","rows":[0,0,204,204,252,204,206,2],"ink":null,"paper":null},{"ch":"Ҥ","rows":[0,206,204,204,252,204,204,204],"ink":null,"paper":null},{"ch":"ҥ","rows":[0,0,0,206,204,252,204,204],"ink":null,"paper":null},{"ch":"Ҧ","rows":[0,240,144,156,146,146,146,4],"ink":null,"paper":null},{"ch":"ҧ","rows":[0,0,0,240,156,146,146,4],"ink":null,"paper":null},{"ch":"Ҩ","rows":[0,100,138,138,138,138,132,122],"ink":null,"paper":null},{"ch":"ҩ","rows":[0,0,0,100,138,138,132,122],"ink":null,"paper":null},{"ch":"Ҫ","rows":[0,124,198,192,198,124,16,48],"ink":null,"paper":null},{"ch":"ҫ","rows":[0,0,124,192,192,124,16,48],"ink":null,"paper":null},{"ch":"Ҭ","rows":[0,126,24,24,24,24,28,4],"ink":null,"paper":null},{"ch":"ҭ","rows":[0,0,0,126,24,24,28,4],"ink":null,"paper":null},{"ch":"Ү","rows":[0,102,102,102,60,24,24,24],"ink":null,"paper":null},{"ch":"ү","rows":[0,0,0,102,102,60,24,24],"ink":null,"paper":null},{"ch":"Ұ","rows":[0,198,198,198,108,56,254,56],"ink":null,"paper":null},{"ch":"ұ","rows":[0,0,0,198,108,56,254,56],"ink":null,"paper":null},{"ch":"Ҳ","rows":[0,238,124,56,124,238,198,2],"ink":null,"paper":null},{"ch":"ҳ","rows":[0,0,238,124,56,124,238,2],"ink":null,"paper":null},{"ch":"Ҵ","rows":[0,244,68,68,68,68,126,2],"ink":null,"paper":null},{"ch":"ҵ","rows":[0,0,0,244,68,68,126,2],"ink":null,"paper":null},{"ch":"Ҷ","rows":[0,204,204,252,12,12,14,2],"ink":null,"paper":null},{"ch":"ҷ","rows":[0,0,0,204,252,12,14,2],"ink":null,"paper":null},{"ch":"Ҹ","rows":[0,198,214,214,254,22,22,6],"ink":null,"paper":null},{"ch":"ҹ","rows":[0,0,0,198,214,254,22,6],"ink":null,"paper":null},{"ch":"Һ","rows":[0,192,192,252,198,198,198,198],"ink":null,"paper":null},{"ch":"һ","rows":[0,0,192,192,252,198,198,198],"ink":null,"paper":null},{"ch":"Ҽ","rows":[0,28,54,182,254,48,50,28],"ink":null,"paper":null},{"ch":"ҽ","rows":[0,0,0,28,182,254,48,28],"ink":null,"paper":null},{"ch":"Ҿ","rows":[0,28,54,182,254,48,28,8],"ink":null,"paper":null},{"ch":"ҿ","rows":[0,0,28,182,254,48,28,8],"ink":null,"paper":null},{"ch":"Ӏ","rows":[0,126,24,24,24,24,24,126],"ink":null,"paper":null},{"ch":"Ӂ","rows":[0,40,56,214,214,124,214,214],"ink":null,"paper":null},{"ch":"ӂ","rows":[0,40,56,0,214,124,214,214],"ink":null,"paper":null},{"ch":"Ӌ","rows":[0,198,198,254,6,6,14,8],"ink":null,"paper":null},{"ch":"ӌ","rows":[0,0,0,198,254,6,14,8],"ink":null,"paper":null},{"ch":"ӏ","rows":[0,56,88,24,24,24,24,126],"ink":null,"paper":null},{"ch":"Ӑ","rows":[0,40,56,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ӑ","rows":[0,40,56,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ӓ","rows":[0,108,0,56,108,198,254,198],"ink":null,"paper":null},{"ch":"ӓ","rows":[0,108,0,124,6,126,198,126],"ink":null,"paper":null},{"ch":"Ӕ","rows":[0,62,120,216,222,248,216,222],"ink":null,"paper":null},{"ch":"ӕ","rows":[0,0,0,252,54,254,176,252],"ink":null,"paper":null},{"ch":"Ӗ","rows":[0,40,56,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ӗ","rows":[0,40,56,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ә","rows":[0,120,204,6,254,198,108,56],"ink":null,"paper":null},{"ch":"ә","rows":[0,0,0,252,6,254,198,124],"ink":null,"paper":null},{"ch":"Ӝ","rows":[0,108,0,214,214,124,214,214],"ink":null,"paper":null},{"ch":"ӝ","rows":[0,0,108,0,214,124,214,214],"ink":null,"paper":null},{"ch":"Ӡ","rows":[0,252,12,24,28,198,198,124],"ink":null,"paper":null},{"ch":"ӡ","rows":[0,0,0,252,8,28,198,124],"ink":null,"paper":null},{"ch":"Ӣ","rows":[0,124,0,198,206,222,246,230],"ink":null,"paper":null},{"ch":"ӣ","rows":[0,0,124,0,206,222,246,230],"ink":null,"paper":null},{"ch":"Ӥ","rows":[0,108,0,198,206,222,246,230],"ink":null,"paper":null},{"ch":"ӥ","rows":[0,0,108,0,206,222,246,230],"ink":null,"paper":null},{"ch":"Ӧ","rows":[0,108,0,124,198,198,198,124],"ink":null,"paper":null},{"ch":"ӧ","rows":[0,0,108,0,124,198,198,124],"ink":null,"paper":null},{"ch":"Ө","rows":[0,124,198,198,254,198,198,124],"ink":null,"paper":null},{"ch":"ө","rows":[0,0,0,124,198,254,198,124],"ink":null,"paper":null},{"ch":"Ӯ","rows":[0,124,0,198,108,60,24,240],"ink":null,"paper":null},{"ch":"ӯ","rows":[0,0,124,0,198,108,56,240],"ink":null,"paper":null},{"ch":"Ӱ","rows":[0,108,0,198,108,60,24,240],"ink":null,"paper":null},{"ch":"ӱ","rows":[0,0,108,0,198,108,56,240],"ink":null,"paper":null},{"ch":"Ӳ","rows":[0,40,40,198,108,60,24,240],"ink":null,"paper":null},{"ch":"ӳ","rows":[0,40,40,0,108,60,24,240],"ink":null,"paper":null},{"ch":"Ӵ","rows":[0,108,0,198,198,254,6,6],"ink":null,"paper":null},{"ch":"ӵ","rows":[0,0,108,0,198,254,6,6],"ink":null,"paper":null},{"ch":"Ӷ","rows":[0,254,192,192,192,192,224,32],"ink":null,"paper":null},{"ch":"ӷ","rows":[0,0,0,254,192,192,224,32],"ink":null,"paper":null},{"ch":"Ԁ","rows":[0,6,6,6,126,198,198,126],"ink":null,"paper":null},{"ch":"ԁ","rows":[0,6,6,126,198,198,198,126],"ink":null,"paper":null},{"ch":"Ԍ","rows":[0,124,198,192,198,198,198,124],"ink":null,"paper":null},{"ch":"ԍ","rows":[0,0,0,124,192,198,198,124],"ink":null,"paper":null},{"ch":"Ԏ","rows":[0,252,48,48,48,50,54,28],"ink":null,"paper":null},{"ch":"ԏ","rows":[0,0,0,252,48,48,50,28],"ink":null,"paper":null},{"ch":"Ԑ","rows":[0,124,198,192,112,192,198,124],"ink":null,"paper":null},{"ch":"ԑ","rows":[0,0,0,124,198,112,198,124],"ink":null,"paper":null},{"ch":"Ԥ","rows":[0,252,204,204,204,204,206,2],"ink":null,"paper":null},{"ch":"ԥ","rows":[0,0,0,252,204,204,206,2],"ink":null,"paper":null},{"ch":"א","rows":[0,194,98,54,124,216,140,134],"ink":null,"paper":null},{"ch":"ב","rows":[0,240,24,12,12,12,12,254],"ink":null,"paper":null},{"ch":"ג","rows":[0,240,24,12,12,124,204,198],"ink":null,"paper":null},{"ch":"ד","rows":[0,254,12,12,12,12,12,12],"ink":null,"paper":null},{"ch":"ה","rows":[0,248,12,6,198,198,198,198],"ink":null,"paper":null},{"ch":"ו","rows":[0,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"ז","rows":[0,254,12,24,48,48,48,48],"ink":null,"paper":null},{"ch":"ח","rows":[0,248,204,198,198,198,198,198],"ink":null,"paper":null},{"ch":"ט","rows":[0,204,214,198,198,198,108,56],"ink":null,"paper":null},{"ch":"י","rows":[0,48,48,48,48,0,0,0],"ink":null,"paper":null},{"ch":"ך","rows":[0,120,140,6,6,6,6,6],"ink":null,"paper":null},{"ch":"כ","rows":[0,248,12,6,6,6,12,248],"ink":null,"paper":null},{"ch":"ל","rows":[0,192,192,254,6,12,24,24],"ink":null,"paper":null},{"ch":"ם","rows":[0,248,204,198,198,198,198,254],"ink":null,"paper":null},{"ch":"מ","rows":[0,152,252,102,198,198,198,222],"ink":null,"paper":null},{"ch":"ן","rows":[0,48,48,48,48,48,48,48],"ink":null,"paper":null},{"ch":"נ","rows":[0,248,12,6,6,6,6,254],"ink":null,"paper":null},{"ch":"ס","rows":[0,124,198,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ע","rows":[0,198,198,198,102,102,60,240],"ink":null,"paper":null},{"ch":"ף","rows":[0,248,204,198,102,6,6,6],"ink":null,"paper":null},{"ch":"פ","rows":[0,248,204,198,102,6,12,248],"ink":null,"paper":null},{"ch":"ץ","rows":[0,198,102,60,24,24,24,24],"ink":null,"paper":null},{"ch":"צ","rows":[0,140,204,120,48,24,12,254],"ink":null,"paper":null},{"ch":"ק","rows":[0,254,6,12,216,216,192,192],"ink":null,"paper":null},{"ch":"ר","rows":[0,248,12,6,6,6,6,6],"ink":null,"paper":null},{"ch":"ש","rows":[0,214,214,214,230,198,108,56],"ink":null,"paper":null},{"ch":"ת","rows":[0,248,108,102,102,102,102,198],"ink":null,"paper":null},{"ch":"װ","rows":[0,108,108,108,108,108,108,108],"ink":null,"paper":null},{"ch":"ױ","rows":[0,108,108,108,108,12,12,12],"ink":null,"paper":null},{"ch":"ײ","rows":[0,108,108,108,108,0,0,0],"ink":null,"paper":null},{"ch":"Ḃ","rows":[0,16,0,252,198,252,198,252],"ink":null,"paper":null},{"ch":"ḃ","rows":[0,208,192,252,198,198,198,252],"ink":null,"paper":null},{"ch":"Ḋ","rows":[0,32,0,248,204,198,204,248],"ink":null,"paper":null},{"ch":"ḋ","rows":[0,22,6,126,198,198,198,126],"ink":null,"paper":null},{"ch":"Ḍ","rows":[0,248,204,198,204,248,0,32],"ink":null,"paper":null},{"ch":"ḍ","rows":[0,6,126,198,198,126,0,16],"ink":null,"paper":null},{"ch":"Ḑ","rows":[0,248,204,198,204,248,32,64],"ink":null,"paper":null},{"ch":"ḑ","rows":[0,6,126,198,198,126,16,32],"ink":null,"paper":null},{"ch":"Ḟ","rows":[0,16,0,254,192,248,192,192],"ink":null,"paper":null},{"ch":"ḟ","rows":[0,16,0,60,48,254,48,48],"ink":null,"paper":null},{"ch":"Ḥ","rows":[0,198,198,254,198,198,0,16],"ink":null,"paper":null},{"ch":"ḥ","rows":[0,192,192,252,198,198,0,16],"ink":null,"paper":null},{"ch":"Ḧ","rows":[0,108,0,198,198,254,198,198],"ink":null,"paper":null},{"ch":"ḧ","rows":[0,108,0,192,192,252,198,198],"ink":null,"paper":null},{"ch":"Ḩ","rows":[0,198,198,254,198,198,16,32],"ink":null,"paper":null},{"ch":"ḩ","rows":[0,192,192,252,198,198,16,32],"ink":null,"paper":null},{"ch":"Ḱ","rows":[0,8,16,198,204,248,204,198],"ink":null,"paper":null},{"ch":"ḱ","rows":[0,8,16,0,198,204,248,206],"ink":null,"paper":null},{"ch":"Ḷ","rows":[0,192,192,192,192,254,0,16],"ink":null,"paper":null},{"ch":"ḷ","rows":[0,192,192,192,224,62,0,16],"ink":null,"paper":null},{"ch":"Ḻ","rows":[0,192,192,192,192,254,0,124],"ink":null,"paper":null},{"ch":"ḻ","rows":[0,192,192,192,224,62,0,124],"ink":null,"paper":null},{"ch":"Ḿ","rows":[0,8,16,198,238,254,214,198],"ink":null,"paper":null},{"ch":"ḿ","rows":[0,8,16,252,214,214,214,214],"ink":null,"paper":null},{"ch":"Ṁ","rows":[0,16,198,238,254,214,198,198],"ink":null,"paper":null},{"ch":"ṁ","rows":[0,16,0,252,214,214,214,214],"ink":null,"paper":null},{"ch":"Ṅ","rows":[0,16,0,198,230,214,206,198],"ink":null,"paper":null},{"ch":"ṅ","rows":[0,16,0,252,198,198,198,198],"ink":null,"paper":null},{"ch":"Ṉ","rows":[0,198,230,214,206,198,0,124],"ink":null,"paper":null},{"ch":"ṉ","rows":[0,252,198,198,198,198,0,124],"ink":null,"paper":null},{"ch":"Ṕ","rows":[0,8,16,252,198,252,192,192],"ink":null,"paper":null},{"ch":"ṕ","rows":[0,8,16,0,252,198,252,192],"ink":null,"paper":null},{"ch":"Ṗ","rows":[0,16,0,252,198,252,192,192],"ink":null,"paper":null},{"ch":"ṗ","rows":[0,0,16,0,252,198,252,192],"ink":null,"paper":null},{"ch":"Ṛ","rows":[0,252,198,252,216,206,0,16],"ink":null,"paper":null},{"ch":"ṛ","rows":[0,220,230,192,192,192,0,16],"ink":null,"paper":null},{"ch":"Ṡ","rows":[0,16,0,254,192,254,6,254],"ink":null,"paper":null},{"ch":"ṡ","rows":[0,16,0,124,192,124,6,124],"ink":null,"paper":null},{"ch":"Ṣ","rows":[0,254,192,254,6,254,0,16],"ink":null,"paper":null},{"ch":"ṣ","rows":[0,124,192,124,6,124,0,16],"ink":null,"paper":null},{"ch":"Ṫ","rows":[0,16,0,254,56,56,56,56],"ink":null,"paper":null},{"ch":"ṫ","rows":[0,16,0,48,254,48,48,62],"ink":null,"paper":null},{"ch":"Ṭ","rows":[0,254,56,56,56,56,0,16],"ink":null,"paper":null},{"ch":"ṭ","rows":[0,48,254,48,48,62,0,16],"ink":null,"paper":null},{"ch":"Ṽ","rows":[0,20,40,198,198,108,56,16],"ink":null,"paper":null},{"ch":"ṽ","rows":[0,20,40,0,198,108,56,16],"ink":null,"paper":null},{"ch":"Ẁ","rows":[0,32,16,198,214,254,238,198],"ink":null,"paper":null},{"ch":"ẁ","rows":[0,32,16,198,214,214,254,108],"ink":null,"paper":null},{"ch":"Ẃ","rows":[0,8,16,198,214,254,238,198],"ink":null,"paper":null},{"ch":"ẃ","rows":[0,8,16,198,214,214,254,108],"ink":null,"paper":null},{"ch":"Ẅ","rows":[0,108,0,198,214,254,238,198],"ink":null,"paper":null},{"ch":"ẅ","rows":[0,108,0,198,214,214,254,108],"ink":null,"paper":null},{"ch":"Ẑ","rows":[0,16,40,254,28,56,112,254],"ink":null,"paper":null},{"ch":"ẑ","rows":[0,16,40,0,254,56,112,254],"ink":null,"paper":null},{"ch":"Ẓ","rows":[0,254,28,56,112,254,0,16],"ink":null,"paper":null},{"ch":"ẓ","rows":[0,254,56,112,254,0,0,16],"ink":null,"paper":null},{"ch":"ẛ","rows":[0,4,0,30,48,48,48,48],"ink":null,"paper":null},{"ch":"ẜ","rows":[0,30,48,48,48,120,48,48],"ink":null,"paper":null},{"ch":"ẝ","rows":[0,30,48,120,48,48,48,48],"ink":null,"paper":null},{"ch":"ẞ","rows":[0,60,102,204,220,198,198,220],"ink":null,"paper":null},{"ch":"Ạ","rows":[0,56,108,198,254,198,0,16],"ink":null,"paper":null},{"ch":"ạ","rows":[0,124,6,126,198,126,0,16],"ink":null,"paper":null},{"ch":"Ẹ","rows":[0,254,192,248,192,254,0,16],"ink":null,"paper":null},{"ch":"ẹ","rows":[0,124,198,254,192,124,0,16],"ink":null,"paper":null},{"ch":"Ẽ","rows":[0,20,40,254,192,248,192,254],"ink":null,"paper":null},{"ch":"ẽ","rows":[0,20,40,124,198,254,192,124],"ink":null,"paper":null},{"ch":"Ỉ","rows":[0,48,16,0,254,56,56,254],"ink":null,"paper":null},{"ch":"ỉ","rows":[0,48,16,0,120,24,24,254],"ink":null,"paper":null},{"ch":"Ị","rows":[0,254,56,56,56,254,0,16],"ink":null,"paper":null},{"ch":"ị","rows":[0,120,24,24,24,254,0,16],"ink":null,"paper":null},{"ch":"Ọ","rows":[0,124,198,198,198,124,0,16],"ink":null,"paper":null},{"ch":"ọ","rows":[0,0,124,198,198,124,0,16],"ink":null,"paper":null},{"ch":"Ớ","rows":[0,16,32,122,206,204,204,120],"ink":null,"paper":null},{"ch":"ớ","rows":[0,16,32,0,122,206,204,120],"ink":null,"paper":null},{"ch":"Ờ","rows":[0,32,16,122,206,204,204,120],"ink":null,"paper":null},{"ch":"ờ","rows":[0,32,16,0,122,206,204,120],"ink":null,"paper":null},{"ch":"Ỡ","rows":[0,20,40,122,206,204,204,120],"ink":null,"paper":null},{"ch":"ỡ","rows":[0,20,40,0,122,206,204,120],"ink":null,"paper":null},{"ch":"Ụ","rows":[0,198,198,198,198,124,0,16],"ink":null,"paper":null},{"ch":"ụ","rows":[0,0,198,198,198,124,0,16],"ink":null,"paper":null},{"ch":"Ủ","rows":[0,48,16,198,198,198,198,124],"ink":null,"paper":null},{"ch":"ủ","rows":[0,48,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ứ","rows":[0,16,34,206,204,204,204,120],"ink":null,"paper":null},{"ch":"ứ","rows":[0,16,32,2,206,204,204,120],"ink":null,"paper":null},{"ch":"Ừ","rows":[0,32,18,206,204,204,204,120],"ink":null,"paper":null},{"ch":"ừ","rows":[0,32,16,2,206,204,204,120],"ink":null,"paper":null},{"ch":"Ữ","rows":[0,20,40,2,206,204,204,120],"ink":null,"paper":null},{"ch":"ữ","rows":[0,20,40,0,2,206,204,120],"ink":null,"paper":null},{"ch":"Ỳ","rows":[0,32,16,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ỳ","rows":[0,32,16,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ỵ","rows":[0,198,198,124,56,56,0,16],"ink":null,"paper":null},{"ch":"ỵ","rows":[0,0,0,198,198,108,56,242],"ink":null,"paper":null},{"ch":"Ỷ","rows":[0,48,16,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ỷ","rows":[0,48,16,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ỹ","rows":[0,20,40,198,198,124,56,56],"ink":null,"paper":null},{"ch":"ỹ","rows":[0,20,40,198,198,108,56,240],"ink":null,"paper":null},{"ch":"Ỻ","rows":[0,216,216,216,216,216,216,254],"ink":null,"paper":null},{"ch":"ỻ","rows":[0,108,254,108,108,108,108,108],"ink":null,"paper":null},{"ch":"ἀ","rows":[0,48,16,0,122,198,198,122],"ink":null,"paper":null},{"ch":"ἄ","rows":[0,100,40,0,122,198,198,122],"ink":null,"paper":null},{"ch":"ἅ","rows":[0,100,72,0,122,198,198,122],"ink":null,"paper":null},{"ch":"Ἀ","rows":[0,200,92,54,54,62,54,54],"ink":null,"paper":null},{"ch":"ἐ","rows":[0,48,16,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ἑ","rows":[0,24,16,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ἔ","rows":[0,100,40,124,198,112,198,124],"ink":null,"paper":null},{"ch":"ἕ","rows":[0,52,40,124,198,112,198,124],"ink":null,"paper":null},{"ch":"Ἐ","rows":[0,222,88,24,30,24,24,30],"ink":null,"paper":null},{"ch":"ἠ","rows":[0,48,16,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ἡ","rows":[0,24,16,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ἢ","rows":[0,104,36,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ἣ","rows":[0,104,68,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ἤ","rows":[0,100,40,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ἰ","rows":[0,24,8,0,120,24,24,30],"ink":null,"paper":null},{"ch":"ἵ","rows":[0,100,72,0,120,24,24,30],"ink":null,"paper":null},{"ch":"ὀ","rows":[0,48,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ὁ","rows":[0,24,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ὄ","rows":[0,100,40,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ὐ","rows":[0,48,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ὑ","rows":[0,24,16,0,198,198,198,124],"ink":null,"paper":null},{"ch":"Ὧ","rows":[0,80,160,28,182,182,20,54],"ink":null,"paper":null},{"ch":"ὰ","rows":[0,32,16,0,122,198,198,122],"ink":null,"paper":null},{"ch":"ὴ","rows":[0,32,16,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ὶ","rows":[0,32,16,0,120,24,24,30],"ink":null,"paper":null},{"ch":"ὸ","rows":[0,32,16,0,124,198,198,124],"ink":null,"paper":null},{"ch":"ῆ","rows":[0,20,40,0,252,198,198,6],"ink":null,"paper":null},{"ch":"ῖ","rows":[0,20,40,0,120,24,24,30],"ink":null,"paper":null},{"ch":"ῦ","rows":[0,20,40,0,198,198,198,124],"ink":null,"paper":null},{"ch":"ῶ","rows":[0,20,40,0,68,214,124,40],"ink":null,"paper":null},{"ch":"ℓ","rows":[0,48,104,104,112,224,98,60],"ink":null,"paper":null},{"ch":"ⅎ","rows":[0,0,0,6,6,62,6,254],"ink":null,"paper":null},{"ch":"ↄ","rows":[0,0,0,124,198,6,198,124],"ink":null,"paper":null},{"ch":"Ɑ","rows":[0,118,206,206,206,206,206,118],"ink":null,"paper":null},{"ch":"Ɒ","rows":[0,220,230,230,230,230,230,220],"ink":null,"paper":null},{"ch":"元","rows":[0,124,0,254,40,40,74,132],"ink":null,"paper":null},{"ch":"円","rows":[0,254,146,146,254,130,130,132],"ink":null,"paper":null},{"ch":"Ꙅ","rows":[0,124,198,6,124,192,198,124],"ink":null,"paper":null},{"ch":"ꙅ","rows":[0,0,0,252,6,254,192,126],"ink":null,"paper":null},{"ch":"Ꙕ","rows":[0,114,218,218,222,218,218,114],"ink":null,"paper":null},{"ch":"ꙕ","rows":[0,0,0,114,218,222,218,114],"ink":null,"paper":null},{"ch":"Ꙩ","rows":[0,124,198,198,214,198,198,124],"ink":null,"paper":null},{"ch":"ꙩ","rows":[0,0,0,124,198,214,198,124],"ink":null,"paper":null},{"ch":"ꜛ","rows":[0,16,56,84,16,16,0,0],"ink":null,"paper":null},{"ch":"ꜜ","rows":[0,16,16,84,56,16,0,0],"ink":null,"paper":null},{"ch":"ꜝ","rows":[0,16,16,16,0,16,0,0],"ink":null,"paper":null},{"ch":"ꜞ","rows":[0,16,0,16,16,16,0,0],"ink":null,"paper":null},{"ch":"ꜟ","rows":[0,0,0,16,0,16,16,16],"ink":null,"paper":null},{"ch":"Ꞌ","rows":[0,48,120,120,120,120,48,0],"ink":null,"paper":null},{"ch":"ꞌ","rows":[0,48,120,120,120,48,0,0],"ink":null,"paper":null},{"ch":"ﬁ","rows":[0,118,96,246,102,102,102,102],"ink":null,"paper":null},{"ch":"ﬂ","rows":[0,118,102,246,102,102,102,102],"ink":null,"paper":null},{"ch":"יִ","rows":[0,0,0,48,48,32,0,48],"ink":null,"paper":null},{"ch":"ײַ","rows":[0,0,0,108,108,72,0,124],"ink":null,"paper":null},{"ch":"שׁ","rows":[0,4,0,214,230,198,108,56],"ink":null,"paper":null},{"ch":"שׂ","rows":[0,64,0,214,230,198,108,56],"ink":null,"paper":null},{"ch":"שּׁ","rows":[0,4,0,214,230,214,108,56],"ink":null,"paper":null},{"ch":"שּׂ","rows":[0,64,0,214,230,214,108,56],"ink":null,"paper":null},{"ch":"אַ","rows":[0,98,54,124,216,140,0,112],"ink":null,"paper":null},{"ch":"אָ","rows":[0,98,54,124,216,140,112,32],"ink":null,"paper":null},{"ch":"אּ","rows":[0,194,98,54,124,216,140,32],"ink":null,"paper":null},{"ch":"בּ","rows":[0,240,24,12,76,12,12,254],"ink":null,"paper":null},{"ch":"גּ","rows":[0,240,24,76,12,124,204,198],"ink":null,"paper":null},{"ch":"דּ","rows":[0,254,12,12,76,12,12,12],"ink":null,"paper":null},{"ch":"הּ","rows":[0,248,12,6,214,198,198,198],"ink":null,"paper":null},{"ch":"וּ","rows":[0,24,24,24,88,24,24,24],"ink":null,"paper":null},{"ch":"זּ","rows":[0,254,12,24,176,48,48,48],"ink":null,"paper":null},{"ch":"טּ","rows":[0,204,214,198,214,198,108,56],"ink":null,"paper":null},{"ch":"יּ","rows":[0,24,24,88,24,0,0,0],"ink":null,"paper":null},{"ch":"ךּ","rows":[0,120,140,6,38,6,6,6],"ink":null,"paper":null},{"ch":"כּ","rows":[0,248,12,6,70,6,12,248],"ink":null,"paper":null},{"ch":"לּ","rows":[0,192,192,254,6,76,24,24],"ink":null,"paper":null},{"ch":"מּ","rows":[0,152,252,102,198,214,198,222],"ink":null,"paper":null},{"ch":"נּ","rows":[0,248,12,6,38,6,6,254],"ink":null,"paper":null},{"ch":"סּ","rows":[0,124,198,198,214,198,198,124],"ink":null,"paper":null},{"ch":"ףּ","rows":[0,248,204,134,86,6,6,6],"ink":null,"paper":null},{"ch":"פּ","rows":[0,248,204,134,86,6,12,248],"ink":null,"paper":null},{"ch":"צּ","rows":[0,140,204,120,48,152,12,254],"ink":null,"paper":null},{"ch":"קּ","rows":[0,254,6,20,204,216,216,192],"ink":null,"paper":null},{"ch":"רּ","rows":[0,248,12,6,38,6,6,6],"ink":null,"paper":null},{"ch":"שּ","rows":[0,198,214,214,230,214,68,56],"ink":null,"paper":null},{"ch":"תּ","rows":[0,248,76,70,86,70,70,198],"ink":null,"paper":null},{"ch":"וֹ","rows":[0,48,0,48,48,48,48,48],"ink":null,"paper":null},{"ch":"בֿ","rows":[0,56,0,240,24,12,12,254],"ink":null,"paper":null},{"ch":"כֿ","rows":[0,56,0,248,12,6,12,248],"ink":null,"paper":null},{"ch":"פֿ","rows":[0,56,0,248,204,102,12,248],"ink":null,"paper":null},{"ch":"ﭏ","rows":[0,194,226,54,124,216,140,134],"ink":null,"paper":null},{"ch":"𝕏","rows":[0,194,162,84,40,84,138,134],"ink":null,"paper":null},{"ch":"ぁ","rows":[0,16,60,16,60,90,50,0],"ink":null,"paper":null},{"ch":"あ","rows":[32,124,32,60,106,178,100,0],"ink":null,"paper":null},{"ch":"ぃ","rows":[0,0,72,68,68,80,32,0],"ink":null,"paper":null},{"ch":"い","rows":[0,136,132,130,130,80,32,0],"ink":null,"paper":null},{"ch":"ぅ","rows":[0,56,0,56,68,8,48,0],"ink":null,"paper":null},{"ch":"う","rows":[60,0,60,66,2,4,56,0],"ink":null,"paper":null},{"ch":"ぇ","rows":[0,56,0,120,16,48,76,0],"ink":null,"paper":null},{"ch":"え","rows":[60,0,124,8,24,40,70,0],"ink":null,"paper":null},{"ch":"ぉ","rows":[0,32,116,32,56,100,40,0],"ink":null,"paper":null},{"ch":"お","rows":[32,244,34,60,98,162,108,0],"ink":null,"paper":null},{"ch":"か","rows":[32,32,244,42,74,72,176,0],"ink":null,"paper":null},{"ch":"が","rows":[42,32,244,42,74,72,176,0],"ink":null,"paper":null},{"ch":"き","rows":[16,124,8,126,36,64,60,0],"ink":null,"paper":null},{"ch":"ぎ","rows":[20,124,8,126,36,64,60,0],"ink":null,"paper":null},{"ch":"く","rows":[4,8,48,64,48,8,4,0],"ink":null,"paper":null},{"ch":"ぐ","rows":[4,8,52,64,48,8,4,0],"ink":null,"paper":null},{"ch":"け","rows":[136,136,190,136,136,136,16,0],"ink":null,"paper":null},{"ch":"げ","rows":[138,136,190,136,136,136,16,0],"ink":null,"paper":null},{"ch":"こ","rows":[0,60,0,0,32,64,62,0],"ink":null,"paper":null},{"ch":"ご","rows":[10,60,0,0,32,64,62,0],"ink":null,"paper":null},{"ch":"さ","rows":[8,8,126,4,36,64,60,0],"ink":null,"paper":null},{"ch":"ざ","rows":[10,8,126,4,36,64,60,0],"ink":null,"paper":null},{"ch":"し","rows":[32,32,32,32,32,34,28,0],"ink":null,"paper":null},{"ch":"じ","rows":[42,32,32,32,32,34,28,0],"ink":null,"paper":null},{"ch":"す","rows":[8,254,24,40,24,8,16,0],"ink":null,"paper":null},{"ch":"ず","rows":[10,254,24,40,24,8,16,0],"ink":null,"paper":null},{"ch":"せ","rows":[36,36,254,36,44,32,30,0],"ink":null,"paper":null},{"ch":"ぜ","rows":[42,36,254,36,44,32,30,0],"ink":null,"paper":null},{"ch":"そ","rows":[60,8,16,126,16,16,12,0],"ink":null,"paper":null},{"ch":"ぞ","rows":[60,10,16,126,16,16,12,0],"ink":null,"paper":null},{"ch":"た","rows":[32,240,46,64,72,80,142,0],"ink":null,"paper":null},{"ch":"だ","rows":[42,240,46,64,72,80,142,0],"ink":null,"paper":null},{"ch":"ち","rows":[8,126,16,28,34,2,28,0],"ink":null,"paper":null},{"ch":"ぢ","rows":[10,126,16,28,34,2,28,0],"ink":null,"paper":null},{"ch":"っ","rows":[0,0,0,24,100,4,24,0],"ink":null,"paper":null},{"ch":"つ","rows":[0,60,194,2,2,28,0,0],"ink":null,"paper":null},{"ch":"づ","rows":[10,60,194,2,2,28,0,0],"ink":null,"paper":null},{"ch":"て","rows":[14,116,8,16,16,8,6,0],"ink":null,"paper":null},{"ch":"で","rows":[14,116,10,16,16,8,6,0],"ink":null,"paper":null},{"ch":"と","rows":[32,32,36,24,32,64,62,0],"ink":null,"paper":null},{"ch":"ど","rows":[42,32,36,24,32,64,62,0],"ink":null,"paper":null},{"ch":"な","rows":[32,244,34,68,156,38,24,0],"ink":null,"paper":null},{"ch":"に","rows":[128,156,128,128,144,160,158,0],"ink":null,"paper":null},{"ch":"ぬ","rows":[8,72,92,106,178,166,86,0],"ink":null,"paper":null},{"ch":"ね","rows":[32,44,242,34,102,170,38,0],"ink":null,"paper":null},{"ch":"の","rows":[0,56,84,146,162,68,24,0],"ink":null,"paper":null},{"ch":"は","rows":[132,132,190,132,156,164,154,0],"ink":null,"paper":null},{"ch":"ば","rows":[138,132,190,132,156,164,154,0],"ink":null,"paper":null},{"ch":"ぱ","rows":[132,138,190,132,156,164,154,0],"ink":null,"paper":null},{"ch":"ひ","rows":[40,228,38,68,68,68,56,0],"ink":null,"paper":null},{"ch":"び","rows":[42,228,38,68,68,68,56,0],"ink":null,"paper":null},{"ch":"ぴ","rows":[44,234,38,68,68,68,56,0],"ink":null,"paper":null},{"ch":"ふ","rows":[16,8,16,16,76,74,178,0],"ink":null,"paper":null},{"ch":"ぶ","rows":[16,10,16,16,76,74,178,0],"ink":null,"paper":null},{"ch":"ぷ","rows":[20,10,20,16,76,74,178,0],"ink":null,"paper":null},{"ch":"へ","rows":[0,32,80,136,6,0,0,0],"ink":null,"paper":null},{"ch":"べ","rows":[10,32,80,136,6,0,0,0],"ink":null,"paper":null},{"ch":"ぺ","rows":[4,42,84,136,6,0,0,0],"ink":null,"paper":null},{"ch":"ほ","rows":[128,190,136,190,136,188,186,0],"ink":null,"paper":null},{"ch":"ぼ","rows":[138,190,136,190,136,188,186,0],"ink":null,"paper":null},{"ch":"ぽ","rows":[132,186,140,190,136,188,186,0],"ink":null,"paper":null},{"ch":"ま","rows":[8,126,8,126,8,124,122,0],"ink":null,"paper":null},{"ch":"み","rows":[112,16,36,124,166,196,24,0],"ink":null,"paper":null},{"ch":"む","rows":[32,244,34,96,160,98,60,0],"ink":null,"paper":null},{"ch":"め","rows":[8,72,92,106,178,162,84,0],"ink":null,"paper":null},{"ch":"も","rows":[16,124,32,124,34,34,28,0],"ink":null,"paper":null},{"ch":"ゃ","rows":[0,40,44,114,20,16,8,0],"ink":null,"paper":null},{"ch":"や","rows":[72,92,226,36,32,16,16,0],"ink":null,"paper":null},{"ch":"ゅ","rows":[0,16,88,116,84,24,32,0],"ink":null,"paper":null},{"ch":"ゆ","rows":[16,188,210,146,188,16,32,0],"ink":null,"paper":null},{"ch":"ょ","rows":[0,8,8,12,56,72,52,0],"ink":null,"paper":null},{"ch":"よ","rows":[8,8,14,8,56,76,50,0],"ink":null,"paper":null},{"ch":"ら","rows":[48,8,64,92,98,2,60,0],"ink":null,"paper":null},{"ch":"り","rows":[88,100,68,68,4,8,48,0],"ink":null,"paper":null},{"ch":"る","rows":[60,8,16,60,66,50,60,0],"ink":null,"paper":null},{"ch":"れ","rows":[32,44,244,36,100,164,34,0],"ink":null,"paper":null},{"ch":"ろ","rows":[60,8,16,60,66,2,60,0],"ink":null,"paper":null},{"ch":"ゎ","rows":[0,16,20,122,50,82,20,0],"ink":null,"paper":null},{"ch":"わ","rows":[32,44,242,34,98,162,44,0],"ink":null,"paper":null},{"ch":"ゐ","rows":[112,16,60,82,150,170,70,0],"ink":null,"paper":null},{"ch":"ゑ","rows":[56,16,56,68,24,108,146,0],"ink":null,"paper":null},{"ch":"を","rows":[16,124,32,118,152,40,30,0],"ink":null,"paper":null},{"ch":"ん","rows":[16,16,32,32,80,82,140,0],"ink":null,"paper":null},{"ch":"゛","rows":[160,80,0,0,0,0,0,0],"ink":null,"paper":null},{"ch":"゜","rows":[64,160,64,0,0,0,0,0],"ink":null,"paper":null},{"ch":"ゝ","rows":[0,32,16,8,12,48,0,0],"ink":null,"paper":null},{"ch":"ゞ","rows":[10,32,16,8,12,48,0,0],"ink":null,"paper":null},{"ch":"ァ","rows":[0,0,124,20,24,16,32,0],"ink":null,"paper":null},{"ch":"ア","rows":[126,2,20,24,16,16,32,0],"ink":null,"paper":null},{"ch":"ィ","rows":[0,0,4,8,24,104,8,0],"ink":null,"paper":null},{"ch":"イ","rows":[2,4,8,24,104,8,8,0],"ink":null,"paper":null},{"ch":"ゥ","rows":[0,0,16,124,68,8,48,0],"ink":null,"paper":null},{"ch":"ウ","rows":[16,126,66,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ェ","rows":[0,0,0,56,16,16,124,0],"ink":null,"paper":null},{"ch":"エ","rows":[0,124,16,16,16,254,0,0],"ink":null,"paper":null},{"ch":"ォ","rows":[0,0,8,124,24,104,24,0],"ink":null,"paper":null},{"ch":"オ","rows":[8,254,8,24,40,200,24,0],"ink":null,"paper":null},{"ch":"カ","rows":[16,126,18,18,18,34,70,0],"ink":null,"paper":null},{"ch":"ガ","rows":[20,126,18,18,18,34,70,0],"ink":null,"paper":null},{"ch":"キ","rows":[16,124,16,16,126,8,8,0],"ink":null,"paper":null},{"ch":"ギ","rows":[20,124,16,16,126,8,8,0],"ink":null,"paper":null},{"ch":"ク","rows":[16,30,34,66,4,8,48,0],"ink":null,"paper":null},{"ch":"グ","rows":[20,30,34,66,4,8,48,0],"ink":null,"paper":null},{"ch":"ケ","rows":[64,126,72,136,8,16,32,0],"ink":null,"paper":null},{"ch":"ゲ","rows":[74,126,72,136,8,16,32,0],"ink":null,"paper":null},{"ch":"コ","rows":[0,126,2,2,2,2,126,0],"ink":null,"paper":null},{"ch":"ゴ","rows":[10,126,2,2,2,2,126,0],"ink":null,"paper":null},{"ch":"サ","rows":[36,254,36,36,4,8,48,0],"ink":null,"paper":null},{"ch":"ザ","rows":[42,254,36,36,4,8,48,0],"ink":null,"paper":null},{"ch":"シ","rows":[64,32,66,34,4,8,112,0],"ink":null,"paper":null},{"ch":"ジ","rows":[74,32,66,34,4,8,112,0],"ink":null,"paper":null},{"ch":"ス","rows":[0,124,4,8,8,52,194,0],"ink":null,"paper":null},{"ch":"ズ","rows":[10,124,4,8,8,52,194,0],"ink":null,"paper":null},{"ch":"セ","rows":[32,32,254,34,36,32,30,0],"ink":null,"paper":null},{"ch":"ゼ","rows":[42,32,254,34,36,32,30,0],"ink":null,"paper":null},{"ch":"ソ","rows":[66,34,34,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ゾ","rows":[74,32,34,2,4,8,48,0],"ink":null,"paper":null},{"ch":"タ","rows":[16,30,34,90,4,8,48,0],"ink":null,"paper":null},{"ch":"ダ","rows":[20,30,34,90,4,8,48,0],"ink":null,"paper":null},{"ch":"チ","rows":[12,112,16,254,16,16,32,0],"ink":null,"paper":null},{"ch":"ヂ","rows":[10,112,16,254,16,16,32,0],"ink":null,"paper":null},{"ch":"ッ","rows":[0,0,0,84,84,8,48,0],"ink":null,"paper":null},{"ch":"ツ","rows":[0,162,82,82,4,8,48,0],"ink":null,"paper":null},{"ch":"ヅ","rows":[10,160,82,82,4,8,48,0],"ink":null,"paper":null},{"ch":"テ","rows":[124,0,254,16,16,16,32,0],"ink":null,"paper":null},{"ch":"デ","rows":[122,0,254,16,16,16,32,0],"ink":null,"paper":null},{"ch":"ト","rows":[32,32,32,56,36,32,32,0],"ink":null,"paper":null},{"ch":"ド","rows":[42,32,32,56,36,32,32,0],"ink":null,"paper":null},{"ch":"ナ","rows":[16,16,254,16,16,32,64,0],"ink":null,"paper":null},{"ch":"ニ","rows":[0,124,0,0,0,254,0,0],"ink":null,"paper":null},{"ch":"ヌ","rows":[124,4,52,8,24,36,192,0],"ink":null,"paper":null},{"ch":"ネ","rows":[16,124,8,16,52,210,16,0],"ink":null,"paper":null},{"ch":"ノ","rows":[4,4,4,8,16,32,192,0],"ink":null,"paper":null},{"ch":"ハ","rows":[0,40,36,36,66,66,130,0],"ink":null,"paper":null},{"ch":"バ","rows":[10,32,36,36,66,66,130,0],"ink":null,"paper":null},{"ch":"パ","rows":[4,42,36,36,66,66,130,0],"ink":null,"paper":null},{"ch":"ヒ","rows":[64,64,70,120,64,64,62,0],"ink":null,"paper":null},{"ch":"ビ","rows":[74,64,70,120,64,64,62,0],"ink":null,"paper":null},{"ch":"ピ","rows":[68,74,70,120,64,64,62,0],"ink":null,"paper":null},{"ch":"フ","rows":[0,126,2,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ブ","rows":[10,126,2,2,4,8,48,0],"ink":null,"paper":null},{"ch":"プ","rows":[4,122,6,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ヘ","rows":[0,32,80,136,4,2,0,0],"ink":null,"paper":null},{"ch":"ベ","rows":[10,32,80,136,4,2,0,0],"ink":null,"paper":null},{"ch":"ペ","rows":[4,42,84,136,4,2,0,0],"ink":null,"paper":null},{"ch":"ホ","rows":[16,16,254,16,84,146,48,0],"ink":null,"paper":null},{"ch":"ボ","rows":[26,16,254,16,84,146,48,0],"ink":null,"paper":null},{"ch":"ポ","rows":[20,26,244,16,84,146,48,0],"ink":null,"paper":null},{"ch":"マ","rows":[0,254,2,4,40,16,8,0],"ink":null,"paper":null},{"ch":"ミ","rows":[112,12,32,24,0,112,12,0],"ink":null,"paper":null},{"ch":"ム","rows":[16,16,32,32,72,68,250,0],"ink":null,"paper":null},{"ch":"メ","rows":[4,4,116,8,20,36,192,0],"ink":null,"paper":null},{"ch":"モ","rows":[60,16,16,126,16,16,14,0],"ink":null,"paper":null},{"ch":"ャ","rows":[0,0,32,60,100,16,16,0],"ink":null,"paper":null},{"ch":"ヤ","rows":[32,46,242,36,16,16,16,0],"ink":null,"paper":null},{"ch":"ュ","rows":[0,0,0,56,8,8,124,0],"ink":null,"paper":null},{"ch":"ユ","rows":[0,120,8,8,8,254,0,0],"ink":null,"paper":null},{"ch":"ョ","rows":[0,0,60,4,28,4,60,0],"ink":null,"paper":null},{"ch":"ヨ","rows":[0,126,2,62,2,2,126,0],"ink":null,"paper":null},{"ch":"ラ","rows":[60,0,126,2,4,8,48,0],"ink":null,"paper":null},{"ch":"リ","rows":[68,68,68,68,4,8,48,0],"ink":null,"paper":null},{"ch":"ル","rows":[8,40,40,40,42,76,136,0],"ink":null,"paper":null},{"ch":"レ","rows":[32,32,32,34,36,40,48,0],"ink":null,"paper":null},{"ch":"ロ","rows":[0,126,66,66,66,66,126,0],"ink":null,"paper":null},{"ch":"ヮ","rows":[0,0,124,68,4,8,48,0],"ink":null,"paper":null},{"ch":"ワ","rows":[0,126,66,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ヰ","rows":[4,126,36,36,254,4,4,0],"ink":null,"paper":null},{"ch":"ヱ","rows":[0,124,8,16,16,254,0,0],"ink":null,"paper":null},{"ch":"ヲ","rows":[126,2,62,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ン","rows":[64,32,2,2,4,8,112,0],"ink":null,"paper":null},{"ch":"ヴ","rows":[20,126,66,2,4,8,48,0],"ink":null,"paper":null},{"ch":"ヵ","rows":[0,0,16,124,20,36,76,0],"ink":null,"paper":null},{"ch":"ヶ","rows":[0,0,32,60,72,8,16,0],"ink":null,"paper":null},{"ch":"・","rows":[0,0,0,48,48,0,0,0],"ink":null,"paper":null},{"ch":"ー","rows":[0,0,128,126,0,0,0,0],"ink":null,"paper":null},{"ch":"ヽ","rows":[0,0,32,16,8,8,0,0],"ink":null,"paper":null},{"ch":"ヾ","rows":[10,0,32,16,8,8,0,0],"ink":null,"paper":null}];

  // ---- sound: the score is compiled by Playload's own compileScore; the chip itself is native.
  const OPS = { repeat: 0, T: 1, M: 2, V: 3, W: 4, X: 5, U: 6, H: 7, note: 8 };
  const flatScores = new WeakMap();
  function flatten(score) {
    let flat = flatScores.get(score);
    if (!flat) {
      const code = score.code;
      flat = new Float64Array(1 + code.length * 3);
      flat[0] = score.fixedVolume ? 1 : 0;
      for (let i = 0; i < code.length; i++) {
        const event = code[i],
          at = 1 + i * 3;
        flat[at] = OPS[event.op];
        if (event.op === 'repeat') {
          flat[at + 1] = event.start;
          flat[at + 2] = event.count;
        } else if (event.op === 'note') {
          flat[at + 1] = event.frequency;
          flat[at + 2] = event.beats;
        } else flat[at + 1] = event.value ?? 0;
      }
      flatScores.set(score, flat);
    }
    return flat;
  }

  // ---- the same wider engine draws the game list: 40 x 30 characters instead of 20 x 18.
  const createMenuEngine = function createMenuEngine(presets = [], compileScore = (s) => s) {
  const width = 320, height = 240, columns = 40, lines = 30;
  const pixels = new Uint8Array(width * height),
    glitches = new Uint8Array(width * height);
  const characters = Object.create(null),
    cache = new Map(),
    patterns = new WeakMap(),
    modifiedPcg = new Set();
  const MAX_SPRITES = 1024,
    SLOTS = 65536,
    cells = columns * lines;
  // one slot per character ever looked up: 8 pattern bytes and its two standard colors
  const glyphBytes = new Uint8Array(SLOTS * 8),
    glyphCols = new Uint8Array(SLOTS * 2),
    slotOfChr = new Map(),
    slotChr = [],
    presetData = new Map(),
    unmade = new Uint8Array(SLOTS),
    keyCache = new Map(),
    textCache = new Map();
  let slotCount = 0,
    unmadeCount = 0,
    bound = false;
  // the text screen: character, its slot, and two colors (-1 = use the character's own)
  const cellChr = new Array(cells).fill(' '),
    cellSlot = new Int32Array(cells),
    cellCol1 = new Int8Array(cells).fill(-1),
    cellCol2 = new Int8Array(cells).fill(-1);
  // this frame's sprites: x, y, slot, color
  const sprData = new Int32Array(MAX_SPRITES * 4);
  let sprCount = 0;
  const far = (value) => (value < -100000 ? -100000 : value > 100000 ? 100000 : value);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  // Capture before game code can replace Math.random().
  const random = Math.random;
  let held = 0,
    pressed = 0,
    pcgBytes = 0,
    firstFrame = true,
    spriteOverflow = false,
    pcgOverflow = false,
    sounds = [];
  const color = (col) => {
    if (!Number.isInteger(col) || col < 0 || col > 7) throw new RangeError('Color must be 0–7');
    return col;
  };
  const coordinate = (value) => {
    if (!Number.isFinite(value)) throw new TypeError('Coordinates must be finite numbers');
    return Math.trunc(value);
  };

  const characterKey = (chr) => {
    if (typeof chr !== 'string') throw new TypeError('Character must be a string');
    // cls() writes 360 spaces per tick. ASCII needs no Unicode normalization
    // or grapheme segmentation; keep the same newline rejection as below.
    if (chr.length === 1 && chr.charCodeAt(0) < 128 && chr !== '\r' && chr !== '\n') return chr;
    const known = keyCache.get(chr);
    if (known !== undefined) return known;
    const normalized = chr.normalize('NFC').replace(/[\ufe0e\ufe0f]/g, '');
    if (
      !normalized ||
      /[\r\n]/.test(normalized) ||
      [...segmenter.segment(normalized)].length !== 1
    ) {
      throw new TypeError('Character must contain one grapheme');
    }
    if (chr.length <= 16) {
      if (keyCache.size >= 8192) keyCache.clear();
      keyCache.set(chr, normalized);
    }
    return normalized;
  };

  const button = (id) => {
    if (!Number.isInteger(id) || id < 0 || id > 5)
      throw new RangeError('Button must be 0–5 (UDLRAB)');
    return 1 << id;
  };

  function randomNoise(range) {
    return (random() * range) | 0;
  }

  function glitch(x, y, w, h) {
    const mask = [3, 4, 6, 7][randomNoise(4)];
    for (let row = 0; row < h; row++) {
      const py = y + row;
      for (let col = 0; col < w; col++) {
        const px = x + col;
        if (randomNoise(4) && px >= 0 && px < width && py >= 0 && py < height)
          glitches[py * width + px] ^= mask;
      }
    }
  }

  function glitchSprite(x, y) {
    spriteOverflow = true;
    glitch(x + randomNoise(33) - 16, y + randomNoise(33) - 16, 8, 8);
  }

  // Character data

  function colorPair(initial, inherit = false, owner = null, mirror = null) {
    const validate = (value) => (inherit && value == null ? null : color(value));
    const values = initial.map(validate);
    const pair = new Proxy(values, {
      set(target, index, value) {
        if (index !== '0' && index !== '1') throw new RangeError('Colors have two entries');
        const next = target.slice();
        next[index] = validate(value);
        if (owner) writePcg(owner, target, next, Number(index), Number(index) + 1);
        else target[index] = next[index];
        if (mirror) mirror(target);
        return true;
      },
      deleteProperty() {
        throw new TypeError('Colors have two entries');
      },
      defineProperty() {
        throw new TypeError('Set col[0] or col[1]');
      },
    });
    return {
      enumerable: true,
      get: () => pair,
      set(value) {
        if (!Array.isArray(value) || value.length !== 2)
          throw new TypeError('Colors need [col1, col2]');
        const next = Array.from(value, validate);
        if (next.length !== 2) throw new TypeError('Colors need [col1, col2]');
        if (owner) writePcg(owner, values, next);
        else {
          values[0] = next[0];
          values[1] = next[1];
        }
        if (mirror) mirror(values);
      },
    };
  }

  // The two colors of one screen cell. Same behaviour as colorPair(..., true), but the
  // values live in cellCol so that cls() and put() need not go through 360 setters.
  function cellPair(index) {
    const validate = (value) => (value == null ? null : color(value));
    const values = [null, null];
    const sync = () => {
      const a = cellCol1[index],
        b = cellCol2[index];
      values[0] = a < 0 ? null : a;
      values[1] = b < 0 ? null : b;
    };
    const store = (i, value) => {
      values[i] = value;
      (i ? cellCol2 : cellCol1)[index] = value == null ? -1 : value;
    };
    const pair = new Proxy(values, {
      get(target, key, receiver) {
        sync();
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        sync();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, index, value) {
        if (index !== '0' && index !== '1') throw new RangeError('Colors have two entries');
        store(Number(index), validate(value));
        return true;
      },
      deleteProperty() {
        throw new TypeError('Colors have two entries');
      },
      defineProperty() {
        throw new TypeError('Set col[0] or col[1]');
      },
    });
    return {
      enumerable: true,
      get: () => pair,
      set(value) {
        if (!Array.isArray(value) || value.length !== 2)
          throw new TypeError('Colors need [col1, col2]');
        const next = Array.from(value, validate);
        if (next.length !== 2) throw new TypeError('Colors need [col1, col2]');
        store(0, next[0]);
        store(1, next[1]);
      },
    };
  }

  // Count writes, including unchanged bytes. A bulk edit uses the remaining
  // budget before dropping its excess bytes. Patterns and colors share both limits.
  // The first accepted write reserves a character for the rest of this run.
  function writePcg(owner, target, next, start = 0, end = next.length) {
    const length = Math.max(0, end - start),
      count =
        modifiedPcg.has(owner) || modifiedPcg.size < 256 ? Math.min(length, 256 - pcgBytes) : 0;
    if (count) modifiedPcg.add(owner);
    for (let i = start; i < start + count; i++) target[i] = next[i];
    pcgBytes += count;
    if (count < length) pcgOverflow = true;
    for (let i = count; i < length; i++) glitch(0, randomNoise(height), width, 1);
  }

  const integer = (value) => Math.trunc(+value) || 0;

  const arrayIndex = (value, length) => {
    const index = integer(value);
    return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
  };

  // Saved references and subarrays share the byte budget. Rendering reads the
  // private bytes directly; only the range written by each method is copied back.
  function patternView(pattern, owner, base = pattern.byteOffset) {
    const mutators = ['set', 'fill', 'copyWithin', 'reverse', 'sort'];
    const view = new Proxy(pattern, {
      get(target, key) {
        // Exposing the backing buffer would allow writes outside the budget.
        if (key === 'buffer') return target.slice().buffer;
        if (key === 'byteOffset') return target.byteOffset - base;
        if (key === 'subarray') return (...args) => patternView(target.subarray(...args), owner, base);
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function' || key === 'constructor') return value;
        return (...args) => {
          if (mutators.includes(key)) {
            const next = target.slice();
            let start = 0,
              end = target.length;
            if (key === 'set') {
              start = integer(args[1]);
              args[1] = start;
              // Let the native method validate the source and offset. Capture
              // its length once, including array-like sources with getters.
              if (args[0] != null) {
                const source = Object(args[0]);
                args[0] = new Proxy(
                  {},
                  {
                    get(_, name) {
                      const value = Reflect.get(source, name, source);
                      if (name !== 'length') return value;
                      const length = Math.min(Math.max(integer(value), 0), Number.MAX_SAFE_INTEGER);
                      end = start + length;
                      return length;
                    },
                  },
                );
              }
            } else if (key === 'fill') {
              args[0] = +args[0];
              start = arrayIndex(args[1], target.length);
              end = args[2] === undefined ? target.length : arrayIndex(args[2], target.length);
              args[1] = start;
              args[2] = end;
            } else if (key === 'copyWithin') {
              start = arrayIndex(args[0], target.length);
              const from = arrayIndex(args[1], target.length),
                to = args[2] === undefined ? target.length : arrayIndex(args[2], target.length);
              end = start + Math.max(0, Math.min(to - from, target.length - start));
              args = [start, from, to];
            }
            const result = value.apply(next, args);
            if (key === 'reverse') {
              // Reverse writes both ends of each pair, but not an odd middle byte.
              for (let i = 0; i < Math.floor(target.length / 2); i++) {
                writePcg(owner, target, next, i, i + 1);
                writePcg(owner, target, next, target.length - i - 1, target.length - i);
              }
            } else writePcg(owner, target, next, start, end);
            return result === next ? view : result;
          }
          // Array callbacks must receive the guarded view as their array argument.
          if (typeof args[0] === 'function') {
            const callback = args[0];
            args[0] = function (...values) {
              return callback.apply(
                this,
                values.map((item) => (item === target ? view : item)),
              );
            };
          }
          const result = value.apply(target, args);
          return result === target ? view : result;
        };
      },
      set(target, key, value) {
        const next = target.slice();
        const result = Reflect.set(next, key, value);
        if (result && Object.hasOwn(target, key))
          writePcg(owner, target, next, Number(key), Number(key) + 1);
        return result;
      },
      defineProperty(target, key, descriptor) {
        const next = target.slice();
        const result = Reflect.defineProperty(next, key, descriptor);
        if (result && Object.hasOwn(target, key) && Object.hasOwn(descriptor, 'value'))
          writePcg(owner, target, next, Number(key), Number(key) + 1);
        return result;
      },
    });
    return view;
  }

  class PcgElem {
    constructor(rows = new Uint8Array(8), col = [7, 0], chr) {
      const slot = slotFor(chr),
        pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8),
        owner = this;
      pattern.set(new Uint8Array(rows));
      if (unmade[slot]) {
        unmade[slot] = 0;
        unmadeCount--;
      }
      patterns.set(this, pattern);
      const view = patternView(pattern, owner);
      Object.defineProperties(this, {
        pat: {
          enumerable: true,
          get: () => view,
          set(value) {
            if (typeof value === 'string') {
              if (!/^[0-9a-f]{16}$/i.test(value))
                throw new TypeError('Pattern needs 16 hex digits');
              value = Array.from({ length: 8 }, (_, i) =>
                parseInt(value.slice(i * 2, i * 2 + 2), 16),
              );
            }
            if (!value || value.length !== 8) throw new TypeError('Pattern needs 8 row bytes');
            const next = Array.from(value);
            if (
              next.length !== 8 ||
              !next.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
            ) {
              throw new TypeError('Pattern needs 8 row bytes');
            }
            writePcg(owner, pattern, next);
          },
        },
        col: colorPair(col, false, owner, (values) => {
          glyphCols[slot * 2] = values[0];
          glyphCols[slot * 2 + 1] = values[1];
        }),
      });
      glyphCols[slot * 2] = color(col[0]);
      glyphCols[slot * 2 + 1] = color(col[1]);
      Object.preventExtensions(this);
    }
  }

  class ScrElem {
    constructor(index) {
      Object.defineProperties(this, {
        chr: {
          enumerable: true,
          get: () => cellChr[index],
          set(value) {
            const key = characterKey(value);
            cellChr[index] = key;
            cellSlot[index] = slotFor(key);
          },
        },
        col: cellPair(index),
      });
      Object.preventExtensions(this);
    }
  }

  function lookup(chr) {
    return (characters[chr] ??= new PcgElem(undefined, undefined, chr));
  }

  // The slot of a character. This does not create its PCG element: as in the original,
  // that happens when the game reads pcg[chr] or when the character is first drawn.
  function slotFor(chr) {
    let slot = slotOfChr.get(chr);
    if (slot === undefined) {
      if (slotCount >= SLOTS) throw new RangeError('Too many characters');
      slot = slotCount++;
      slotOfChr.set(chr, slot);
      slotChr[slot] = chr;
      const preset = presetData.get(chr);
      if (preset) glyphBytes.set(preset.rows, slot * 8);
      glyphCols[slot * 2] = preset ? preset.col[0] : 7;
      glyphCols[slot * 2 + 1] = preset ? preset.col[1] : 0;
      if (!(chr in characters)) {
        unmade[slot] = 1;
        unmadeCount++;
      }
    }
    return slot;
  }

  // A string as put() and spr() see it: its characters (null = new line) and their slots.
  // Only strings whose every character is valid are kept, so errors still come from the original loops.
  function textOf(str) {
    let text = textCache.get(str);
    if (text !== undefined) return text;
    const keys = [],
      at = [],
      cellKeys = [],
      cellAt = [];
    try {
      for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
        if (segment === '\n') {
          keys.push(null);
          at.push(0);
          cellKeys.push(null);
          cellAt.push(0);
        } else {
          const key = characterKey(segment);
          keys.push(key);
          at.push(slotFor(key));
          // put() hands the character to the cell's own setter, which normalizes it once more
          const cellKey = characterKey(key);
          cellKeys.push(cellKey);
          cellAt.push(slotFor(cellKey));
        }
      }
    } catch {
      return null;
    }
    text = { keys, at, cellKeys, cellAt };
    if (str.length <= 64) {
      if (textCache.size >= 2048) textCache.clear();
      textCache.set(str, text);
    }
    return text;
  }

  for (const preset of presets) {
    // Copy source data; create editable patterns lazily for each game.
    const rows = Uint8Array.from(preset.rows),
      col = [preset.ink ?? 7, preset.paper ?? 0];
    const chr = characterKey(preset.ch);
    presetData.set(chr, { rows, col });
    Object.defineProperty(characters, chr, {
      configurable: true,
      enumerable: true,
      get() {
        const element = new PcgElem(rows, col, chr);
        Object.defineProperty(characters, chr, {
          value: element,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        return element;
      },
    });
  }
  const pcg = new Proxy(characters, {
    get: (target, chr) =>
      typeof chr === 'string' ? lookup(characterKey(chr)) : Reflect.get(target, chr),
    set() {
      throw new TypeError('Set pcg[chr].pat or pcg[chr].col');
    },
    deleteProperty() {
      throw new TypeError('PCG elements cannot be deleted');
    },
    defineProperty() {
      throw new TypeError('Set pcg[chr].pat or pcg[chr].col');
    },
  });
  cellSlot.fill(slotFor(' '));
  const scr = Object.freeze(
    Array.from({ length: lines }, (_, cy) =>
      Object.freeze(Array.from({ length: columns }, (_, cx) => new ScrElem(cy * columns + cx))),
    ),
  );

  // Game API

  function cls(col) {
    col = color(col);
    cellChr.fill(' ');
    cellSlot.fill(slotFor(' '));
    cellCol1.fill(-1);
    cellCol2.fill(col);
  }

  function put(cx, cy, str, col1, col2) {
    const origin = coordinate(cx);
    cx = origin;
    cy = coordinate(cy);
    if (typeof str !== 'string') throw new TypeError('Text must be a string');
    const pair = [col1 == null ? null : color(col1), col2 == null ? null : color(col2)];

    const text = textOf(str);
    if (text) {
      const keys = text.cellKeys,
        at = text.cellAt,
        c1 = pair[0] == null ? -1 : pair[0],
        c2 = pair[1] == null ? -1 : pair[1];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === null) {
          cx = origin;
          cy++;
          continue;
        }
        if (cx >= 0 && cx < columns && cy >= 0 && cy < lines) {
          const index = cy * columns + cx;
          cellChr[index] = keys[i];
          cellSlot[index] = at[i];
          cellCol1[index] = c1;
          cellCol2[index] = c2;
        }
        cx++;
      }
      return;
    }

    // Check every character before writing, so an invalid one leaves the screen intact.
    const writes = [];
    for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
      if (segment === '\n') {
        cx = origin;
        cy++;
        continue;
      }
      const chr = characterKey(segment);
      if (cx >= 0 && cx < columns && cy >= 0 && cy < lines) writes.push(scr[cy][cx], chr);
      cx++;
    }

    for (let i = 0; i < writes.length; i += 2) {
      writes[i].chr = writes[i + 1];
      writes[i].col = pair;
    }
  }

  function spr(x, y, str, col) {
    const origin = coordinate(x);
    x = origin;
    y = coordinate(y);
    if (typeof str !== 'string') throw new TypeError('Text must be a string');
    col = color(col);

    // Keep individual ASCII, kana and emoji sprites on the existing fast path.
    if (
      (str.length === 1 || (str.length === 2 && str.codePointAt(0) > 0xffff)) &&
      str !== '\r' &&
      str !== '\n'
    ) {
      if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(str), col);
      else glitchSprite(x, y);
      return;
    }

    const text = textOf(str);
    if (text) {
      const keys = text.keys,
        at = text.at;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === null) {
          x = origin;
          y += 8;
          continue;
        }
        if (sprCount < MAX_SPRITES) {
          const base = sprCount++ * 4;
          sprData[base] = far(x);
          sprData[base + 1] = far(y);
          sprData[base + 2] = at[i];
          sprData[base + 3] = col;
        } else glitchSprite(x, y);
        x += 8;
      }
      return;
    }

    const start = sprCount;
    try {
      for (const { segment } of segmenter.segment(str.replace(/\r\n/g, '\n'))) {
        if (segment === '\n') {
          x = origin;
          y += 8;
          continue;
        }
        if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(segment), col);
        else glitchSprite(x, y);
        x += 8;
      }
    } catch (error) {
      sprCount = start;
      throw error;
    }
  }

  function pushSprite(x, y, chr, col) {
    const slot = slotFor(chr),
      base = sprCount++ * 4;
    sprData[base] = far(x);
    sprData[base + 1] = far(y);
    sprData[base + 2] = slot;
    sprData[base + 3] = col;
  }

  function play(ch, str) {
    if (!Number.isInteger(ch) || ch < 0 || ch > 2)
      throw new RangeError('Sound channel must be 0–2');
    if (typeof str !== 'string') throw new TypeError('Sound must be a string');
    // The player accepts 256 sounds per tick; top-level code counts with the first tick.
    if (sounds.length >= 256) throw new RangeError('A tick can play at most 256 sounds');
    if (!cache.has(str)) {
      const compiled = compileScore(str);
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(str, compiled);
    }
    sounds.push({ ch, score: cache.get(str) });
  }

  // Rasterization

  function draw(slot, x, y, col1, col2) {
    const pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8);
    for (let row = 0; row < 8; row++) {
      const py = y + row;
      if (py < 0 || py >= height) continue;
      for (let bit = 0; bit < 8; bit++) {
        const px = x + bit;
        if (px < 0 || px >= width) continue;
        if (pattern[row] & (128 >> bit)) pixels[py * width + px] = col1;
        else if (col2 >= 0) pixels[py * width + px] = col2;
      }
    }
  }

  function render() {
    if (unmadeCount) {
      for (let index = 0; index < cells && unmadeCount; index++)
        if (unmade[cellSlot[index]]) lookup(cellChr[index]);
      for (let i = 0; i < sprCount && unmadeCount; i++)
        if (unmade[sprData[i * 4 + 2]]) lookup(slotChr[sprData[i * 4 + 2]]);
    }
    if (hostRender) {
      // the arrays never move: hand them over once, then only say how many sprites there are
      if (!bound) {
        hostBind(pixels, glyphBytes, glyphCols, cellSlot, cellCol1, cellCol2, sprData, columns);
        bound = true;
      }
      hostRender(sprCount);
    } else {
      for (let index = 0; index < cells; index++) {
        const slot = cellSlot[index],
          c1 = cellCol1[index],
          c2 = cellCol2[index];
        draw(
          slot,
          (index % columns) * 8,
          Math.floor(index / columns) * 8,
          c1 < 0 ? glyphCols[slot * 2] : c1,
          c2 < 0 ? glyphCols[slot * 2 + 1] : c2,
        );
      }
      for (let i = 0; i < sprCount; i++)
        draw(sprData[i * 4 + 2], sprData[i * 4], sprData[i * 4 + 1], sprData[i * 4 + 3], -1);
    }
    if (spriteOverflow || pcgOverflow)
      for (let i = 0; i < pixels.length; i++) pixels[i] ^= glitches[i];
    return pixels;
  }

  const api = {
    cls,
    put,
    spr,
    btn: (id) => !!(held & button(id)),
    btnp: (id) => !!(pressed & button(id)),
    play,
    scr,
    pcg,
  };
  return {
    api,
    get pixels() {
      return render();
    },
    input(mask) {
      mask &= 63;
      pressed |= mask & ~held;
      held = mask;
    },
    step(tick) {
      // Setup and the first tick are drawn together and share the same budgets.
      if (!firstFrame) {
        sprCount = 0;
        if (spriteOverflow || pcgOverflow) {
          glitches.fill(0);
          spriteOverflow = pcgOverflow = false;
        }
      }
      firstFrame = false;
      try {
        tick();
      } finally {
        pressed = 0;
        // Top-level setup shares the first frame's budget, as sound commands do.
        pcgBytes = 0;
      }
      return Number(spriteOverflow) + Number(pcgOverflow);
    },
    sounds() {
      const result = sounds;
      sounds = [];
      return result;
    },
  };
};

  const hostPlay = host.play,
    evaluate = Function;

  // start(source, wide, ...what the game list needs) -> { frame(mask) -> frames to wait, pixels() -> Uint8Array }
  return function start(source, wide, gamesJson, arcade, tab, sel, error, head) {
    const engine = (wide ? createMenuEngine : createEngine)(glyphs, compileScore);
    let api = engine.api;
    if (wide) {
      let all = {};
      try {
        all = JSON.parse(gamesJson);
      } catch {}
      api = {
        ...engine.api,
        games: all.games ?? [],
        plain: all.plain ?? {},
        heavy: (host.engine === 'JavaScriptCore' ? all.heavyJit : all.heavy) ?? [],
        arcade,
        state: { version: all.version ?? '', engine: host.engine === 'JavaScriptCore' ? 'JIT' : '', tab, sel, error, head },
        decode: host.decode,
        launch: host.launch,
        quit: host.quit,
        raw: host.raw,
        remember: host.remember,
        update: host.update,
        serve: host.serve,
        addr: host.addr,
        inbox: host.inbox,
        mine: host.mine,
        ui: host.ui,
      };
    }
    const tick = new evaluate(
      ...Object.keys(api),
      source + '\n;return typeof tick === "function" ? tick : null;\n//# sourceURL=playload-game.js',
    )(...Object.values(api));
    if (!tick) throw new Error('Define function tick()');
    return {
      frame(mask) {
        engine.input(mask);
        let wait;
        try {
          wait = engine.step(tick);
        } finally {
          for (const sound of engine.sounds()) hostPlay(sound.ch, flatten(sound.score));
        }
        return wait;
      },
      pixels() {
        return engine.pixels;
      },
    };
  };
});

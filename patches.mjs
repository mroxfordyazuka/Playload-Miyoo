// Speed changes to Playload's engine.js for a device with no JIT (QuickJS on a Cortex-A7).
// Behaviour is meant to be identical; test/fuzz.mjs and test/games.sh check that against the untouched engine.
// What changes: the text screen, the sprite list and the character patterns live in typed arrays,
// cls/put/spr write them directly, and one native call paints the frame.
// Every "old" snippet must occur exactly once in engine.js, so an upstream change stops the build.
export const patches = [
  // ---- storage
  [
    `  const characters = Object.create(null),
    sprites = [],
    cache = new Map(),
    patterns = new WeakMap(),
    modifiedPcg = new Set();`,
    `  const characters = Object.create(null),
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
  const far = (value) => (value < -100000 ? -100000 : value > 100000 ? 100000 : value);`,
  ],
  // ---- characterKey: remember answers for short strings (it is a pure function)
  [
    `    if (chr.length === 1 && chr.charCodeAt(0) < 128 && chr !== '\\r' && chr !== '\\n') return chr;
    const normalized = chr.normalize('NFC').replace(/[\\ufe0e\\ufe0f]/g, '');`,
    `    if (chr.length === 1 && chr.charCodeAt(0) < 128 && chr !== '\\r' && chr !== '\\n') return chr;
    const known = keyCache.get(chr);
    if (known !== undefined) return known;
    const normalized = chr.normalize('NFC').replace(/[\\ufe0e\\ufe0f]/g, '');`,
  ],
  [
    `      throw new TypeError('Character must contain one grapheme');
    }
    return normalized;
  };`,
    `      throw new TypeError('Character must contain one grapheme');
    }
    if (chr.length <= 16) {
      if (keyCache.size >= 8192) keyCache.clear();
      keyCache.set(chr, normalized);
    }
    return normalized;
  };`,
  ],
  // ---- pcg colors are mirrored into glyphCols
  [
    `  function colorPair(initial, inherit = false, owner = null) {`,
    `  function colorPair(initial, inherit = false, owner = null, mirror = null) {`,
  ],
  [
    `        if (owner) writePcg(owner, target, next, Number(index), Number(index) + 1);
        else target[index] = next[index];
        return true;`,
    `        if (owner) writePcg(owner, target, next, Number(index), Number(index) + 1);
        else target[index] = next[index];
        if (mirror) mirror(target);
        return true;`,
  ],
  [
    `        if (owner) writePcg(owner, values, next);
        else {
          values[0] = next[0];
          values[1] = next[1];
        }
      },
    };
  }`,
    `        if (owner) writePcg(owner, values, next);
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
  }`,
  ],
  // ---- patterns are views into glyphBytes
  [
    `    constructor(rows = new Uint8Array(8), col = [7, 0]) {`,
    `    constructor(rows = new Uint8Array(8), col = [7, 0], chr) {`,
  ],
  [
    `    const chr = characterKey(preset.ch);
    Object.defineProperty(characters, chr, {`,
    `    const chr = characterKey(preset.ch);
    presetData.set(chr, { rows, col });
    Object.defineProperty(characters, chr, {`,
  ],
  [
    `        const element = new PcgElem(rows, col);`,
    `        const element = new PcgElem(rows, col, chr);`,
  ],
  [
    `        if (key === 'buffer') return target.buffer.slice(0);`,
    `        if (key === 'buffer') return target.slice().buffer;
        if (key === 'byteOffset') return target.byteOffset - base;`,
  ],
  [
    `  function patternView(pattern, owner) {`,
    `  function patternView(pattern, owner, base = pattern.byteOffset) {`,
  ],
  [
    `return (...args) => patternView(target.subarray(...args), owner);`,
    `return (...args) => patternView(target.subarray(...args), owner, base);`,
  ],
  [
    `      const pattern = new Uint8Array(rows),
        owner = this;
      patterns.set(this, pattern);`,
    `      const slot = slotFor(chr),
        pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8),
        owner = this;
      pattern.set(new Uint8Array(rows));
      if (unmade[slot]) {
        unmade[slot] = 0;
        unmadeCount--;
      }
      patterns.set(this, pattern);`,
  ],
  [
    `        col: colorPair(col, false, owner),`,
    `        col: colorPair(col, false, owner, (values) => {
          glyphCols[slot * 2] = values[0];
          glyphCols[slot * 2 + 1] = values[1];
        }),`,
  ],
  [
    `      });
      Object.preventExtensions(this);
    }
  }

  class ScrElem {
    constructor() {
      let chr = ' ';
      Object.defineProperties(this, {
        chr: {
          enumerable: true,
          get: () => chr,
          set(value) {
            chr = characterKey(value);
          },
        },
        col: colorPair([null, null], true),
      });
      Object.preventExtensions(this);
    }
  }

  function lookup(chr) {
    return (characters[chr] ??= new PcgElem());
  }`,
    `      });
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
      for (const { segment } of segmenter.segment(str.replace(/\\r\\n/g, '\\n'))) {
        if (segment === '\\n') {
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
  }`,
  ],
  [
    `  const scr = Object.freeze(
    Array.from({ length: lines }, () =>
      Object.freeze(Array.from({ length: columns }, () => new ScrElem())),
    ),
  );`,
    `  cellSlot.fill(slotFor(' '));
  const scr = Object.freeze(
    Array.from({ length: lines }, (_, cy) =>
      Object.freeze(Array.from({ length: columns }, (_, cx) => new ScrElem(cy * columns + cx))),
    ),
  );`,
  ],
  // ---- cls
  [
    `    col = color(col);
    for (const row of scr)
      for (const element of row) {
        element.chr = ' ';
        element.col = [null, col];
      }
  }`,
    `    col = color(col);
    cellChr.fill(' ');
    cellSlot.fill(slotFor(' '));
    cellCol1.fill(-1);
    cellCol2.fill(col);
  }`,
  ],
  // ---- put
  [
    `    const pair = [col1 == null ? null : color(col1), col2 == null ? null : color(col2)];

    // Check every character before writing, so an invalid one leaves the screen intact.`,
    `    const pair = [col1 == null ? null : color(col1), col2 == null ? null : color(col2)];

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

    // Check every character before writing, so an invalid one leaves the screen intact.`,
  ],
  // ---- spr
  [
    `      if (sprites.length < 128) sprites.push({ x, y, chr: characterKey(str), col });
      else glitchSprite(x, y);
      return;
    }

    const start = sprites.length;
    try {`,
    `      if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(str), col);
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
    try {`,
  ],
  [
    `        if (sprites.length < 128) sprites.push({ x, y, chr: characterKey(segment), col });
        else glitchSprite(x, y);
        x += 8;
      }
    } catch (error) {
      sprites.length = start;
      throw error;
    }
  }`,
    `        if (sprCount < MAX_SPRITES) pushSprite(x, y, characterKey(segment), col);
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
  }`,
  ],
  // ---- rasterization
  [
    `  function draw(chr, x, y, col1, col2) {
    const pattern = patterns.get(lookup(chr));
    for (let row = 0; row < 8; row++) {`,
    `  function draw(slot, x, y, col1, col2) {
    const pattern = glyphBytes.subarray(slot * 8, slot * 8 + 8);
    for (let row = 0; row < 8; row++) {`,
  ],
  [
    `        else if (col2 !== null) pixels[py * width + px] = col2;`,
    `        else if (col2 >= 0) pixels[py * width + px] = col2;`,
  ],
  [
    `  function render() {
    for (let cy = 0; cy < lines; cy++)
      for (let cx = 0; cx < columns; cx++) {
        const element = scr[cy][cx],
          standard = lookup(element.chr).col;
        draw(
          element.chr,
          cx * 8,
          cy * 8,
          element.col[0] ?? standard[0],
          element.col[1] ?? standard[1],
        );
      }

    for (const sprite of sprites) {
      draw(sprite.chr, sprite.x, sprite.y, sprite.col, null);
    }`,
    `  function render() {
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
    }`,
  ],
  [
    `      if (!firstFrame) {
        sprites.length = 0;`,
    `      if (!firstFrame) {
        sprCount = 0;`,
  ],
];

export function patchEngine(source) {
  for (const [from, to] of patches) {
    const first = source.indexOf(from);
    if (first < 0 || source.indexOf(from, first + 1) >= 0)
      throw new Error('engine.js changed; this patch no longer fits:\n' + from.slice(0, 200));
    source = source.replace(from, () => to);
  }
  if (/\bsprites\b[.\[)]/.test(source)) throw new Error('a use of "sprites" is left over');
  return source;
}

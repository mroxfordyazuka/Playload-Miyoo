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

  /*__ENGINE__*/

  /*__SOUND__*/

  /*__GLYPHS__*/

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
  const createMenuEngine = /*__MENU_ENGINE__*/ null;

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

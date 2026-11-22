// Runs a game on Playload's untouched engine in Node and prints the same frame hashes as `playload hash`.
import fs from 'node:fs';
import zlib from 'node:zlib';
const [repo, file, framesArg] = process.argv.slice(2);
let s = 12345;
Math.random = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
let t = 0; Date.now = () => 1700000000000 + (t += 16);
const { createEngine } = await import(`${repo}/src/engine/engine.js`);
const { compileScore } = await import(`${repo}/src/engine/sound.js`);
const { glyphs } = await import(`${repo}/src/engine/glyphs.js`);
let text = fs.readFileSync(file, 'utf8');
const m = /#(?:v1|1)\.([A-Za-z0-9_-]+)/.exec(text.slice(0, 300));
if (m) text = zlib.inflateRawSync(Buffer.from(m[1], 'base64url')).toString('utf8');
const autoMask = (frame) => {
  let v = Math.imul(Math.floor(frame / 12), 2654435761) >>> 0; v ^= v >>> 15;
  let mask = v & 63;
  if (Math.floor(frame / 12) % 3 === 0) mask &= 48;
  if (frame < 30) mask = 0;
  if (frame >= 30 && frame < 36) mask = 16;
  return mask;
};
const engine = createEngine(glyphs, compileScore);
const api = engine.api;
let h = 2166136261;
const frames = Number(framesArg);
try {
  const tick = new Function(...Object.keys(api), text + '\n;return typeof tick === "function" ? tick : null;')(...Object.values(api));
  if (!tick) throw new Error('Define function tick()');
  for (let f = 0; f < frames; f++) {
    try { engine.input(autoMask(f)); engine.step(tick); engine.sounds(); } catch (e) { console.log(`frame ${f} ERROR`); break; }
    const px = engine.pixels;
    for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 16777619) >>> 0; }
    if (f % 60 === 59 || f === frames - 1) console.log(`frame ${f} ${h.toString(16).padStart(8, '0')}`);
  }
} catch (e) { console.log('START ERROR'); }

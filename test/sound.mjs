// The C sound chip against Playload's JavaScript one: same game, same frames, compare the samples.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [repo, game, framesArg] = process.argv.slice(2);
const frames = Number(framesArg ?? 600);
let s = 12345; Math.random = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
let t = 0; Date.now = () => 1700000000000 + (t += 16);
const { createEngine } = await import(`${repo}/src/engine/engine.js`);
const { compileScore, AY } = await import(`${repo}/src/engine/sound.js`);
const { glyphs } = await import(`${repo}/src/engine/glyphs.js`);
const autoMask = (frame) => { let v = Math.imul(Math.floor(frame / 12), 2654435761) >>> 0; v ^= v >>> 15; let m = v & 63; if (Math.floor(frame / 12) % 3 === 0) m &= 48; if (frame < 30) m = 0; if (frame >= 30 && frame < 36) m = 16; return m; };
const engine = createEngine(glyphs, compileScore), api = engine.api;
const tick = new Function(...Object.keys(api), fs.readFileSync(game, 'utf8') + '\n;return tick;')(...Object.values(api));
const ay = new AY(44100), ref = [];
for (let f = 0; f < frames; f++) {
  engine.input(autoMask(f)); engine.step(tick);
  for (const c of engine.sounds()) ay.play(c.ch, c.score);
  for (let i = 0; i < 735; i++) ref.push(ay.sample());
}
execFileSync('build/host/playload', ['out', 'wav', game, String(frames), '/tmp/cmp.wav']);
const wav = fs.readFileSync('/tmp/cmp.wav'), got = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
let worst = 0, energy = 0, err = 0;
for (let i = 0; i < ref.length; i++) { const a = Math.max(-32768, Math.min(32767, ref[i] * 32767)), d = got[i] - a; worst = Math.max(worst, Math.abs(d)); energy += a * a; err += d * d; }
console.log(`${game.split('/').pop()}: ${ref.length} samples, loudest ${Math.round(Math.sqrt(energy / ref.length))} rms, worst difference ${worst.toFixed(1)} of 32767, error ${(10 * Math.log10(err / energy)).toFixed(1)} dB`);

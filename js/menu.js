// The list and settings screens. Logic in JavaScript, drawing by the app's UI kit (ArchiveTV's), reached through
// ui(op, text, text, n, n, n, n). Other names from the app: games, plain, heavy, arcade, state, decode, launch,
// raw, remember, update (fetch the Arcade list), serve / addr / inbox (links from a phone), mine.
const FRAME = 0, TABS = 1, HEADER = 2, LIST = 3, FOOTER = 4, TOAST = 5, PANEL = 6, TEXT = 7, QR = 8, GET = 9, SET = 10, ROWS = 11, THEMES = 12, MENU = 13, FAVS = 14, FAV = 15, FORGET = 16;
const get = (key) => ui(GET, key), set = (key, value) => ui(SET, key, String(value));

// ---- Japanese. Playload's 8x8 characters have kana but no kanji, so it is written the way 8-bit games were:
// kana with spaces between the words. t() looks a phrase up; U() is ui() with its texts looked up on the way.
const JA = {
  Arcade: 'アーケード', Favorites: 'おきにいり', 'My Games': 'マイゲーム', Dev: 'かいはつ',
  Play: 'あそぶ', Update: 'こうしん', Tab: 'タブ', Remove: 'はずす', Delete: 'けす', Open: 'ひらく', Start: 'かいし', Change: 'かえる', Back: 'もどる', Done: 'おわる', Cancel: 'やめる',
  HEAVY: 'おもい', On: 'オン', Off: 'オフ', Dark: 'ダーク', None: 'なし', Small: 'ちいさい', 'JIT (fast)': 'JIT (はやい)', Stock: 'ひょうじゅん',
  Language: 'ことば (Language)', Scanlines: 'スキャンライン', 'Frame around games': 'ゲームの わく', Theme: 'テーマ', Letters: 'もじ', Volume: 'おんりょう', Engine: 'エンジン', 'CPU speed': 'CPU そくど',
  'Look for new games at start': 'きどうじに しんさくを さがす', 'Update the Arcade list...': 'アーケードを こうしんする...', 'Add a game from your phone...': 'スマホから ゲームを ついか...',
  'About Playload': 'Playload に ついて', 'Start the dev panel...': 'かいはつパネルを ひらく...',
  'From the next start': 'つぎの きどうから', 'Added to favorites': 'おきにいりに ついか', 'Removed from favorites': 'おきにいりから はずした',
  'Remove this favorite?': 'おきにいりから はずす?', 'Delete this game?': 'この ゲームを けす?',
  'No favorites yet.\nPress Y on a game to keep it here.': 'おきにいりは まだ ありません\nゲームで Y を おすと ここに はいります', 'Nothing here.': 'なにも ありません',
  'Updating the Arcade list': 'アーケードを こうしんちゅう', 'Fetching it from Playload over Wi-Fi.': 'Wi-Fi で Playload から とりこみます', 'This can take up to a minute.': 'さいだい 1ぷん ほど かかります',
  About: 'Playload に ついて', 'Playload, a tiny game engine whose': 'Playload は リンク ひとつに', 'games fit in a link.': 'おさまる ちいさな ゲームエンジン',
  'Engine and examples by Takashi Kitao.': 'エンジンと サンプル: Takashi Kitao', 'Arcade games by their authors.': 'アーケードの ゲーム: それぞれの さくしゃ', 'Miyoo version by 0kCyb0rg.': 'Miyoo ばん: 0kCyb0rg',
  'Dev panel': 'かいはつパネル', 'No Wi-Fi address.': 'Wi-Fi の アドレスが ありません', "Turn Wi-Fi on in the Miyoo's": 'Miyoo の せっていで Wi-Fi を', 'settings, then try again.': 'オンにして もういちど どうぞ',
  'On your computer, open': 'パソコンで ひらく', 'Write a game, press Run:': 'ゲームを かいて Run を おすと', 'it plays here. MENU': 'ここで うごきます', 'comes back to this.': 'MENU で ここに もどります',
  'Add from phone': 'スマホから ついか', 'Scan with your phone': 'スマホで よみとる', '(same Wi-Fi), or open': '(おなじ Wi-Fi) または', 'Then paste a Playload': 'Playload の リンクを', 'link and press Send.': 'はりつけて そうしん', 'Waiting...': 'まっています...',
  'GAME STOPPED': 'ゲームが とまりました', 'UPDATE FAILED': 'こうしん しっぱい', 'ARCADE UPDATED': 'アーケード こうしん', 'DEV PANEL': 'かいはつパネル',
  'The game stopped responding.': 'ゲームが おうとう しなくなりました', 'No connection. Is Wi-Fi on?': 'つながりません  Wi-Fi は オンですか?', 'The download timed out.': 'ダウンロードが じかんぎれに なりました',
  'Arcade list updated': 'アーケードを こうしんしました', 'Invalid game URL': 'ゲームの リンクが ただしくありません',
  "No Wi-Fi address. Turn Wi-Fi on in the Miyoo's settings, then try again.": 'Wi-Fi の アドレスが ありません  Miyoo の せっていで Wi-Fi を オンにして もういちど どうぞ',
};
const JA_FORMS = [
  [/^(\d+) games in the Arcade list now\.$/, 'アーケードは いま $1 ゲーム です'],
  [/^(\d+) new games? in the Arcade$/, 'アーケードに しんさく $1 ほん'],
  [/^(\d+) received$/, '$1 けん とどいた'],
  [/^(\d+) games? received$/, '$1 ゲーム とどきました'],
];
let ja = get('lang') === '1';
const t = (text) => {
  if (!ja || !text) return text;
  if (JA[text]) return JA[text];
  for (const [form, to] of JA_FORMS) if (form.test(text)) return text.replace(form, to);
  return text;
};
const hintsIn = (hints) => hints.split('  ').map((h) => { const i = h.indexOf(':'); return i < 0 ? t(h) : h.slice(0, i + 1) + t(h.slice(i + 1)); }).join('  ');
function U(op, a = '', b = '', ...rest) {
  if (op === TABS || op === MENU) return ui(op, op === MENU ? t(a) : a.split('\t').map(t).join('\t'), op === MENU ? b.split('\t').map(t).join('\t') : b, ...rest);
  if (op === FOOTER) return ui(op, hintsIn(a), t(b), ...rest);
  if (op === HEADER) return ui(op, t(a), t(b), ...rest);
  if (op === TEXT || op === TOAST) return ui(op, t(a), b, ...rest);
  if (op === LIST) return ui(op, a, t(b), ...rest);
  return ui(op, a, b, ...rest);
}
const VIS = +ui(ROWS) || 8;
const themes = ui(THEMES).split('\t');
const jit = get('running') === 'JavaScriptCore';

// tabs: 0 Arcade, 1 Favorites, 2 My Games, 3 Dev (a row that starts the dev panel, then Kitao's examples), 4 Settings
const lists = [[], [], []], examples = [];
for (const g of games) {
  if (jit) g.heavy = g.heavyJit; // the JIT engine copes with more of them
  (g.tab === 1 ? examples : lists[0]).push(g);
}

const LINK = /#(?:v1|1)\.[A-Za-z0-9_-]+/;
// can the list write this? Latin letters come from the UI font, the rest from Playload's own 8x8 characters
const drawable = (text) => {
  try {
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 256 || (code >= 0xfe00 && code <= 0xfe0f)) continue;
      if (!pcg[ch].pat.some((row) => row)) return false;
    }
    return true;
  } catch {
    return false;
  }
};
const clean = (text) => text.replace(/[\t\n\r]/g, ' ');

// ARCADE: the list fetched over Wi-Fi (arcade.json, as Playload publishes it) replaces the built-in one
function fromArcade(text) {
  try {
    const bundled = new Set(lists[0].map((g) => g.hash));
    const out = [];
    for (const g of JSON.parse(text)) {
      const m = LINK.exec(String(g.url ?? ''));
      if (!m || typeof g.title !== 'string') continue;
      let title = g.title, by = String(g.author ?? '');
      if (!drawable(title))
        title = plain[g.title] ?? (/([^/]+)\.png$/.exec(String(g.image ?? ''))?.[1] ?? 'game').replace(/-/g, ' ').toUpperCase();
      if (!drawable(by)) by = '@' + String(g.authorUrl ?? '').split('/').pop();
      out.push({ tab: 0, title, by, note: String(g.publishedAt ?? '').slice(0, 10), fresh: !bundled.has(m[0]), hash: m[0], heavy: heavy.includes(g.title) ? 1 : 0 });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
if (arcade) lists[0] = fromArcade(arcade) ?? lists[0];

// MY GAMES: one Playload link per line in mygames.txt, optionally "Name | link"
function readMine(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINK.exec(line);
    if (!m || /^\s*(\/\/|;)/.test(line)) continue;
    let title = line.slice(0, m.index).replace(/https?:\/\/\S*$/i, '').replace(/[\s|:=,-]+$/, '').trim();
    if (!title) {
      const source = decode(m[0]);
      title = (source && /@title[ \t]+(.+)/.exec(source)?.[1].trim()) || 'Game ' + (out.length + 1);
    }
    if (!drawable(title)) title = 'Game ' + (out.length + 1);
    out.push({ tab: 2, title, by: '', note: '', hash: m[0] });
  }
  return out;
}
lists[2] = readMine(mine());

// FAVORITES: favorites.txt, same form. Y on a game adds or removes it; so does the pause menu in a game
const START_DEV = { action: 'dev', title: 'Start the dev panel...' }, ADD_PHONE = { action: 'phone', title: 'Add a game from your phone...' };
let favorite = new Set();
function readFavorites() {
  const known = new Map();
  for (const g of [...lists[0], ...examples]) known.set(g.hash, g);
  lists[1] = readMine(ui(FAVS)).map((g) => ({ ...g, by: known.get(g.hash)?.by ?? '', heavy: known.get(g.hash)?.heavy ?? 0 }));
  favorite = new Set(lists[1].map((g) => g.hash));
}
readFavorites();
// what a tab shows, row by row
const rowsOf = (t) => (t === 2 ? [ADD_PHONE, ...lists[2]] : t === 3 ? [START_DEV, ...examples] : t === 4 ? settings : lists[t]);

const kb = (hash) => {
  const n = hash.length - hash.indexOf('.') - 1;
  return (Math.ceil(Math.floor((n * 3) / 4) / 10) / 100).toFixed(2) + ' KB';
};

// ---- settings
const VOLUMES = [50, 100, 150, 200, 300];
const settings = [
  { name: 'Language', value: () => (ja ? 'にほんご' : 'English'), act: () => { set('lang', ja ? 0 : 1); ja = !ja; } },
  { name: 'Scanlines', value: () => (get('effect') === '1' ? 'On' : 'Off'), act: () => set('effect', get('effect') === '1' ? 0 : 1) },
  { name: 'Frame around games', value: () => (get('bezel') === '1' ? 'Dark' : 'None'), act: () => set('bezel', get('bezel') === '1' ? 0 : 1) },
  { name: 'Theme', value: () => themes[+get('theme')] ?? '', act: () => set('theme', (+get('theme') + 1) % themes.length) },
  { name: 'Letters', value: () => (get('font') === '1' && !ja ? 'Soft' : 'Playload'), act: () => { if (!ja) set('font', get('font') === '1' ? 0 : 1); } }, // Japanese is always in Playload's letters
  { name: 'Volume', value: () => get('volume') + '%', act: () => { set('volume', VOLUMES[(VOLUMES.indexOf(+get('volume')) + 1) % VOLUMES.length]); play(0, 'T240V12O5N3c'); } },
  { name: 'Engine', value: () => (get('engine') === 'small' ? 'Small' : 'JIT (fast)'), act: () => { set('engine', get('engine') === 'small' ? 'jit' : 'small'); say('From the next start'); } },
  { name: 'CPU speed', value: () => (+get('overclock') ? get('overclock') + ' MHz' : 'Stock'), act: () => { set('overclock', +get('overclock') ? 0 : 1600); say('From the next start'); } },
  { name: 'Look for new games at start', value: () => (get('autoupdate') === '1' ? 'On' : 'Off'), act: () => set('autoupdate', get('autoupdate') === '1' ? 0 : 1) },
  { name: 'Update the Arcade list...', more: 1, act: () => startUpdate() },
  { name: 'Add a game from your phone...', more: 1, act: () => startPhone() },
  { name: 'About Playload', more: 1, act: () => { mode = 'about'; } },
];

const T_DEV = 3, T_SET = 4, NTABS = 5;
let tab = Math.min(T_SET, Math.max(0, state.tab)), sel = state.sel, top = 0, heldFor = 0, last = raw(), selAt = performance.now();
const note = state.head === 'NOTE' ? state.error : '';
if (note) state.error = '';
let mode = state.head === 'DEV' ? 'dev' : state.error ? 'message' : 'list', seen = -1, where = state.head === 'DEV' ? addr() : '', toast = '', toastUntil = 0;
const say = (text) => { toast = text; toastUntil = performance.now() + 1800; };
if (note) { toast = note; toastUntil = performance.now() + 4000; }
const count = () => rowsOf(tab).length;
let ask = null, askSel = 0; // "delete this?" over the list

function startUpdate() { mode = 'updating'; seen = 0; }
function startDev() { mode = 'dev'; state.error = ''; where = serve(2) ? addr() : ''; }
function startPhone() { mode = 'phone'; seen = -1; where = serve(true) ? addr() : ''; }

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines;
}

function paint() {
  U(FRAME);
  if (mode === 'updating') {
    U(HEADER, 'Arcade', '');
    U(PANEL);
    U(TEXT, 'Updating the Arcade list', '', -1, 86, 5);
    U(TEXT, 'Fetching it from Playload over Wi-Fi.', '', -1, 110, 0);
    U(TEXT, 'This can take up to a minute.', '', -1, 128, 1);
    U(FOOTER, '', '');
    return;
  }
  if (mode === 'message') {
    U(HEADER, state.head, '');
    U(PANEL);
    const lines = wrap(t(state.error.replace(/[^\x20-\x7e]/g, '?')), 30).slice(0, 6);
    lines.forEach((line, i) => ui(TEXT, line, '', -1, 112 - lines.length * 9 + i * 18, i ? 0 : 5));
    U(FOOTER, 'A:OK', '');
    return;
  }
  if (mode === 'about') {
    U(HEADER, 'About', 'v' + state.version);
    U(PANEL);
    ['Playload, a tiny game engine whose', 'games fit in a link.', 'kitao.dev/playload', '', 'Engine and examples by Takashi Kitao.', 'Arcade games by their authors.', 'Miyoo version by 0kCyb0rg.'].forEach(
      (line, i) => U(TEXT, line, '', -1, 52 + i * 18, i === 2 ? 5 : i > 3 ? 1 : 0),
    );
    U(FOOTER, 'B:Back', jit ? 'JIT' : '');
    return;
  }
  if (mode === 'dev') {
    U(HEADER, 'Dev panel', '');
    U(PANEL);
    if (!where) {
      U(TEXT, 'No Wi-Fi address.', '', -1, 92, 4);
      U(TEXT, "Turn Wi-Fi on in the Miyoo's", '', -1, 116, 0);
      U(TEXT, 'settings, then try again.', '', -1, 134, 0);
    } else {
      U(QR, 'http://' + where + '/dev', '', 14, 50, 4);
      const x = 104;
      U(TEXT, 'On your computer, open', '', x, 48, 5);
      U(TEXT, where + '/dev', '', x, 66, 3);
      U(TEXT, 'Write a game, press Run:', '', x, 92, 0);
      U(TEXT, 'it plays here. MENU', '', x, 110, 0);
      U(TEXT, 'comes back to this.', '', x, 128, 0);
      const lines = state.error ? wrap(state.error.replace(/[^\x20-\x7e]/g, '?'), 34).slice(0, 2) : [];
      lines.forEach((line, i) => U(TEXT, line, '', 14, 154 + i * 16, 4));
    }
    U(FOOTER, 'B:Done', '');
    return;
  }
  if (mode === 'phone') {
    const n = inbox();
    U(HEADER, 'Add from phone', n ? n + ' received' : '');
    U(PANEL);
    if (!where) {
      U(TEXT, 'No Wi-Fi address.', '', -1, 92, 4);
      U(TEXT, "Turn Wi-Fi on in the Miyoo's", '', -1, 116, 0);
      U(TEXT, 'settings, then try again.', '', -1, 134, 0);
    } else {
      U(QR, 'http://' + where, '', 14, 50, 5);
      const x = 112;
      U(TEXT, 'Scan with your phone', '', x, 48, 5);
      U(TEXT, '(same Wi-Fi), or open', '', x, 66, 0);
      U(TEXT, where, '', x, 84, 3);
      U(TEXT, 'Then paste a Playload', '', x, 110, 0);
      U(TEXT, 'link and press Send.', '', x, 128, 0);
      U(TEXT, n ? n + (n === 1 ? ' game' : ' games') + ' received' : 'Waiting...', '', x, 154, n ? 3 : 1);
    }
    U(FOOTER, 'B:Done', '');
    return;
  }

  U(TABS, 'Arcade\tFavorites\tMy Games\tDev\t\x01', '', tab);
  const all = rowsOf(tab), n = all.length;
  sel = Math.max(0, Math.min(n - 1, sel));
  if (sel < top) top = sel;
  if (sel >= top + VIS) top = sel - VIS + 1;
  let rows = '', badge = '', hints;
  if (tab === T_SET) {
    rows = settings.slice(top, top + VIS).map((s) => t(s.name) + '\t' + (s.value ? t(s.value()) : '') + '\t' + (s.more ? 4 : 0)).join('\n');
    hints = 'A:Change  L/R:Tab';
  } else {
    const heart = (g) => (tab !== 1 && favorite.has(g.hash) ? '\u2665 ' : '');
    rows = all.slice(top, top + VIS).map((g) => (g.action ? t(g.title) + '\t\t4' : heart(g) + clean(g.title) + '\t' + clean(g.by) + '\t' + (g.heavy ? 3 : g.fresh ? 1 : 0))).join('\n');
    const g = all[sel];
    if (g && !g.action) badge = g.heavy ? 'HEAVY' : g.fresh ? 'NEW' : kb(g.hash);
    const fav = g && !g.action && favorite.has(g.hash) ? 'Y:\u2661' : 'Y:\u2665';
    hints = g?.action ? 'A:Open  L/R:Tab' : tab === 0 ? 'A:Play  ' + fav + '  X:Update' : tab === 1 ? 'A:Play  X:Remove  L/R:Tab' : tab === 2 ? 'A:Play  ' + fav + '  X:Delete' : 'A:Play  ' + fav + '  L/R:Tab';
    if (tab === 1 && !n) hints = 'L/R:Tab';
  }
  const empty = tab === 1 ? 'No favorites yet.\nPress Y on a game to keep it here.' : 'Nothing here.';
  U(LIST, rows, empty, n, sel, top, Math.floor(performance.now() - selAt));
  U(FOOTER, hints, badge);
  if (ask) U(MENU, ask.question, 'Cancel\t' + ask.yes, askSel);
  else if (toast && performance.now() < toastUntil) U(TOAST, toast);
}

function tick() {
  const pad = raw(), fresh = pad & ~last;
  last = pad;
  const A = fresh & 16, Bk = fresh & 32;

  if (mode === 'updating') {
    paint();
    if (++seen === 3) update(); // the notice has been on screen: now fetch (this blocks)
    return;
  }
  if (mode === 'message') {
    if (A || Bk) { state.error = ''; mode = 'list'; }
  } else if (mode === 'about') {
    if (A || Bk) mode = 'list';
  } else if (mode === 'dev') {
    if (Bk) { serve(false); state.error = ''; mode = 'list'; tab = T_DEV; sel = 0; top = 0; lists[2] = readMine(mine()); }
  } else if (ask) {
    if (btnp(0) || btnp(1)) askSel = 1 - askSel;
    if (Bk || (A && !askSel)) ask = null;
    else if (A) { const act = ask.act; ask = null; act(); play(0, 'T240V8O4N1c'); }
  } else if (mode === 'phone') {
    const n = inbox();
    if (n !== seen) { if (seen >= 0 && n) play(0, 'T240V10O6N1cEG'); seen = n; }
    if (A || Bk) {
      serve(false);
      mode = 'list';
      lists[2] = readMine(mine());
      if (n) { tab = 2; sel = lists[2].length; top = 0; selAt = performance.now(); }
    }
  } else {
    const before = tab * 10000 + sel;
    const dir = btn(1) - btn(0);
    let move = 0;
    if (dir) {
      if (heldFor === 0 || (heldFor > 18 && heldFor % 4 === 0)) move = dir;
      heldFor++;
    } else heldFor = 0;
    const n = count();
    if (move && n) sel = (sel + move + n) % n;
    if (btnp(2)) sel = Math.max(0, sel - VIS);
    if (btnp(3)) sel = Math.min(n - 1, sel + VIS);
    if (fresh & 64) { tab = (tab + NTABS - 1) % NTABS; sel = 0; top = 0; }
    if (fresh & 128) { tab = (tab + 1) % NTABS; sel = 0; top = 0; }
    if (before !== tab * 10000 + sel) { selAt = performance.now(); play(2, 'T240V5O7N1c'); }
    remember(tab, sel);
    const g = rowsOf(tab)[sel], game = g && !g.action && tab !== T_SET ? g : null;
    if (fresh & 256 && tab === 0) startUpdate();
    else if (fresh & 256 && tab === 1 && game) {
      askSel = 0;
      ask = { question: 'Remove this favorite?', yes: 'Remove', act: () => { ui(FAV, game.hash, '', 0); readFavorites(); } };
    } else if (fresh & 256 && tab === 2 && game) {
      askSel = 0;
      ask = { question: 'Delete this game?', yes: 'Delete', act: () => { ui(FORGET, game.hash); lists[2] = readMine(mine()); } };
    } else if (fresh & 512 && game && tab !== 1) {
      const on = !favorite.has(game.hash);
      ui(FAV, game.hash, game.title, on ? 1 : 0);
      readFavorites();
      say(on ? 'Added to favorites' : 'Removed from favorites');
      play(0, on ? 'T240V10O6N1cE' : 'T240V8O5N1c');
    } else if (A && g?.action === 'dev') startDev();
    else if (A && g?.action === 'phone') startPhone();
    else if (A && tab === T_SET) settings[sel]?.act();
    else if (A && game) {
      play(0, 'T240V10O6N1cG');
      launch(game.hash, game.title);
    }
  }
  paint();
}

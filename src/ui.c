/* The list and settings screens: ArchiveTV's GBA-style UI kit, with Playload's logo where the little TV was,
   a Playload theme, and text that can also write kana and symbols using Playload's own 8x8 characters.
   Pure drawing code (no SDL): everything goes to a 640x480 buffer of 0xRRGGBB pixels. */
#include <string.h>
#include <stdio.h>
#include "ui.h"
#include "font_m5x7.h"
#include "glyphs8.h"
#include "logo8.h"
#include <math.h>

static int RW = 640, RH = 480;
int UW = 320, UH = 240, UVIS = 9;
#define OY ((UH - 240) / 2)   /* centres the fixed-layout screens on taller displays */
#define C(r, g, b) ((uint32_t)(((r) << 16) | ((g) << 8) | (b)))

/* ---------------- themes ---------------- */
typedef struct {
    const char *name;
    uint32_t outline, text, ink, dim, win, panel, rim, rowalt, hilite, hiedge, hitext;
    uint32_t accent, accentd, accentl, yellow, toast, sky, skyl, teal, lav, mint, shadow, bg1, bg2, good, warn, track, scrtv, pilltext;
    uint32_t bars[7];
    int anim;
    uint32_t limb;      /* antennas; 0 = outline colour */
    uint32_t feet;      /* feet fill with an outline stroke; 0 = plain outline-coloured feet */
    uint32_t more;      /* colour of action rows ("Search videos...", "More..."); 0 = accentd */
    uint32_t tab;       /* selected tab pill; 0 = accent */
    /* the frame around a game: body, weave, light edge, dark edge, power light, pressed lettering, the logo's two colours */
    uint32_t fbody, fweave, fedge, fdeep, flight, fink, flogoa, flogob;
    unsigned motif;     /* a Playload character scattered on the background (0 = dots) */
    int hearts;         /* the frame wears hearts */
    unsigned chars[6];  /* characters pressed into the "Tiles" frame: three left, three right */
} Theme;
#define PL_CHARS { 0x1f47e, 0x1f48e, 0x1f3c6, 0x1f47b, 0x1f344, 0x1f6f8 }
static const Theme THEMES[] = {
    { "Playload",     /* Playload's own eight colors (DawnBringer's DB8) on a dark screen */
      C(0,0,0), C(220,245,255), C(200,224,236), C(132,138,140), C(44,34,50), C(26,20,30), C(85,65,95), C(34,26,40), C(80,140,215), C(52,96,160), C(255,255,255),
      C(215,115,85), C(160,80,60), C(236,170,150), C(230,200,110), C(85,65,95), C(80,140,215), C(160,200,240), C(100,185,100), C(150,170,190), C(100,185,100), C(0,0,0), C(20,15,24), C(26,20,31), C(100,185,100), C(215,115,85), C(60,46,68), C(80,140,215), C(20,15,24),
      { C(215,115,85), C(230,200,110), C(100,185,100), C(80,140,215), C(85,65,95), C(100,105,100), C(220,245,255) }, 1, 0, 0, C(230,200,110), C(230,200,110),
      C(38,29,44), C(44,34,51), C(85,65,95), C(20,15,24), C(230,200,110), C(85,65,95), C(85,65,95), C(230,200,110), 0x1f47e, 0, PL_CHARS },
    { "Cute",
      C(44,48,92), C(44,48,92), C(60,58,104), C(150,140,170), C(255,246,226), C(255,252,244), C(255,252,244), C(250,244,236), C(255,214,92), C(236,186,60), C(44,48,92),
      C(244,104,136), C(206,70,108), C(255,170,186), C(255,214,92), C(255,236,160), C(150,210,246), C(206,236,255), C(76,190,172), C(182,160,232), C(150,226,170), C(214,178,150), C(250,226,200), C(244,212,182), C(40,160,110), C(226,140,40), C(236,228,220), C(150,210,246), C(255,255,255),
      { C(236,236,236), C(255,222,110), C(130,218,224), C(140,220,140), C(234,140,214), C(244,112,120), C(120,140,226) }, 1, 0, 0, 0, 0,
      C(255,246,226), C(250,236,212), C(255,255,255), C(214,178,150), C(244,104,136), C(214,178,150), C(44,48,92), C(255,214,92), 0, 0, { 0x1f408, 0x2605, 0x1f34e, 0x1f407, 0x266a, 0x1f98b } },
    { "Night",
      C(10,10,24), C(232,232,250), C(200,200,230), C(130,130,170), C(40,42,78), C(30,32,62), C(70,74,120), C(36,38,72), C(120,90,220), C(80,60,170), C(255,255,255),
      C(255,110,160), C(200,70,130), C(255,170,210), C(255,214,92), C(70,60,120), C(110,200,255), C(180,230,255), C(80,220,200), C(150,130,230), C(120,255,180), C(8,8,20), C(22,22,44), C(28,28,54), C(110,230,160), C(255,190,90), C(60,62,100), C(110,200,255), C(255,255,255),
      { C(90,90,120), C(160,140,60), C(60,140,150), C(60,140,80), C(150,70,140), C(160,60,70), C(60,70,160) }, 1, C(160,160,214), C(150,44,96), C(140,205,255), C(120,90,220),
      C(30,32,62), C(36,38,72), C(70,74,120), C(10,10,24), C(255,110,160), C(70,74,120), C(120,90,220), C(255,214,92), 0x2605, 0, { 0x2605, 0x1fa90, 0x2604, 0x1f6f8, 0x1f47d, 0x2606 } },
    { "Game Boy",
      C(15,56,15), C(15,56,15), C(15,56,15), C(48,98,48), C(155,188,15), C(155,188,15), C(139,172,15), C(145,180,15), C(48,98,48), C(15,56,15), C(155,188,15),
      C(48,98,48), C(15,56,15), C(139,172,15), C(139,172,15), C(139,172,15), C(139,172,15), C(155,188,15), C(48,98,48), C(48,98,48), C(155,188,15), C(15,56,15), C(139,172,15), C(130,162,15), C(15,56,15), C(15,56,15), C(139,172,15), C(139,172,15), C(155,188,15),
      { C(155,188,15), C(139,172,15), C(48,98,48), C(15,56,15), C(48,98,48), C(139,172,15), C(155,188,15) }, 0, 0, 0, 0, 0,
      C(15,56,15), C(22,66,20), C(48,98,48), C(8,36,8), C(155,188,15), C(48,98,48), C(48,98,48), C(155,188,15), 0, 0, PL_CHARS },
    { "Plain",
      C(70,70,80), C(30,30,36), C(60,60,70), C(130,130,140), C(240,240,244), C(255,255,255), C(255,255,255), C(246,246,250), C(60,120,230), C(40,90,190), C(255,255,255),
      C(60,120,230), C(40,90,190), C(160,190,240), C(230,190,60), C(255,244,200), C(170,200,240), C(220,234,255), C(40,160,150), C(140,140,200), C(120,230,150), C(200,200,206), C(214,214,220), C(214,214,220), C(30,140,80), C(200,110,20), C(224,224,230), C(170,200,240), C(255,255,255),
      { C(214,214,220), C(214,214,220), C(214,214,220), C(214,214,220), C(214,214,220), C(214,214,220), C(214,214,220) }, 0, 0, 0, 0, 0,
      C(214,214,220), C(206,206,212), C(240,240,244), C(150,150,160), C(60,120,230), C(160,160,170), C(70,70,80), C(240,240,244), 0, 0, PL_CHARS },
    { "Dark",         /* near black, one yellow light */
      C(0,0,0), C(230,230,234), C(200,200,206), C(110,110,118), C(22,22,25), C(13,13,15), C(44,44,50), C(18,18,21), C(58,58,66), C(40,40,46), C(255,255,255),
      C(230,200,110), C(170,146,80), C(240,224,170), C(230,200,110), C(44,44,50), C(120,150,190), C(170,190,220), C(100,170,150), C(120,120,140), C(150,220,170), C(0,0,0), C(6,6,7), C(9,9,11), C(110,200,130), C(220,130,90), C(36,36,40), C(120,150,190), C(13,13,15),
      { 0 }, 0, 0, 0, C(230,200,110), 0,
      C(13,13,15), C(16,16,19), C(30,30,34), C(0,0,0), C(230,200,110), C(74,74,80), C(34,34,40), C(86,86,94), 0, 0, PL_CHARS },
    { "Pink",         /* sweet: pinks, white and hearts */
      C(150,50,100), C(130,40,88), C(150,64,108), C(200,124,162), C(255,226,236), C(255,246,250), C(255,255,255), C(255,236,243), C(255,130,170), C(230,90,140), C(255,255,255),
      C(255,105,160), C(214,60,120), C(255,180,206), C(240,150,50), C(255,240,196), C(160,214,250), C(214,236,255), C(120,210,190), C(214,170,240), C(255,214,230), C(240,160,190), C(255,188,210), C(255,200,220), C(50,160,110), C(226,120,60), C(255,214,228), C(160,214,250), C(255,255,255),
      { 0 }, 1, 0, 0, 0, 0,
      C(255,170,200), C(255,182,208), C(255,224,236), C(214,96,146), C(255,255,255), C(232,120,166), C(232,84,144), C(255,244,248), 0x2665, 1, { 0x2665, 0x1f407, 0x2661, 0x2764, 0x1f98b, 0x2665 } },
};
#define NTHEMES ((int)(sizeof THEMES / sizeof THEMES[0]))
static const Theme *TH = &THEMES[0];
int ui_theme_count(void) { return NTHEMES; }
const char *ui_theme_name(int i) { return THEMES[(i % NTHEMES + NTHEMES) % NTHEMES].name; }
void ui_set_theme(int i) { TH = &THEMES[(i % NTHEMES + NTHEMES) % NTHEMES]; }

#define NAVY    (TH->outline)
#define TEXT    (TH->text)
#define INK     (TH->ink)
#define DIM     (TH->dim)
#define CREAM   (TH->win)
#define WHITE   (TH->panel)
#define RIM     (TH->rim)
#define ROWALT  (TH->rowalt)
#define HILITE  (TH->hilite)
#define HIEDGE  (TH->hiedge)
#define HITEXT  (TH->hitext)
#define PINK    (TH->accent)
#define PINKD   (TH->accentd)
#define BLUSH   (TH->accentl)
#define YELLOW  (TH->yellow)
#define YELLOWL (TH->toast)
#define SKY     (TH->sky)
#define SKYL    (TH->skyl)
#define TEAL    (TH->teal)
#define LAV     (TH->lav)
#define MINT    (TH->mint)
#define SHADOW  (TH->shadow)
#define BG1     (TH->bg1)
#define BG2     (TH->bg2)
#define GOOD    (TH->good)
#define WARN    (TH->warn)
#define TRACK   (TH->track)
#define PILLTX  (TH->pilltext)
#define LIMB    (TH->limb ? TH->limb : TH->outline)

static uint32_t *T;   /* 640x480 target */

void ui_init(uint32_t *target, int rw, int rh) {
    T = target; RW = rw; RH = rh; UW = rw / 2; UH = rh / 2;
    UVIS = (UH - 80) / UROWH; if (UVIS > 16) UVIS = 16; if (UVIS < 4) UVIS = 4;
}

/* real-pixel rect */
static void rr(uint32_t *b, int x, int y, int w, int h, uint32_t c) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > RW) w = RW - x;
    if (y + h > RH) h = RH - y;
    if (w <= 0 || h <= 0) return;
    for (int j = 0; j < h; j++) { uint32_t *p = b + (y + j) * RW + x; for (int i = 0; i < w; i++) p[i] = c; }
}
/* virtual-pixel rect */
static uint32_t *B;
static void R(int x, int y, int w, int h, uint32_t c) { rr(B, x * 2, y * 2, w * 2, h * 2, c); }
void ui_rect(int x, int y, int w, int h, uint32_t c) { B = T; R(x, y, w, h, c); }
static void P(int x, int y, uint32_t c) { R(x, y, 1, 1, c); }

/* text: the 8x16 font at 1 virtual px = 2 real px */
/* text: m5x7, each font pixel = 3 real pixels (GBA-like scale). x/y are virtual; widths are returned in virtual px.
   maxch keeps the old meaning of "room for maxch 8-px cells" (maxch * 16 real px). */
#define TS3 3
int ui_font = 0;      /* 0 = Playload's own 8x8 letters, twice their size; 1 = m5x7 (ArchiveTV's), three times */
#define TS (ui_font ? 3 : 2)
#define Y8 15         /* where an 8x8 letter sits below a text line's top, in real px */
static const uint8_t *glyph8(unsigned cp);
static void g8(int rx, int ry, const uint8_t *g, int s, uint32_t c);
static void rglyph(int rx, int ry, unsigned char ch, uint32_t c) {
    if (ch < 32) return;
    if (!ui_font) { const uint8_t *g = glyph8(ch); if (!g && ch != ' ') g = glyph8('?'); if (g) g8(rx, ry + Y8, g, 2, c); return; }
    const unsigned short *g = M5_ROWS[ch - 32];
    for (int j = 0; j < M5_ROWS_N; j++) {
        unsigned short row = g[j];
        if (!row) continue;
        int i = 0;
        while (i < 16) {
            if (row & (0x8000 >> i)) { int st = i; while (i < 16 && (row & (0x8000 >> i))) i++; rr(B, rx + st * TS, ry + j * TS, (i - st) * TS, TS, c); }
            else i++;
        }
    }
}
/* one UTF-8 character; malformed bytes come back as themselves */
static unsigned u8next(const unsigned char **pp) {
    const unsigned char *p = *pp; unsigned c = *p++;
    int more = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0;
    if (more) { unsigned v = c & (0x3f >> more); int k = 0; for (; k < more && (p[k] & 0xc0) == 0x80; k++) v = (v << 6) | (p[k] & 0x3f); if (k == more) { c = v; p += more; } }
    *pp = p; return c;
}
/* Playload's 8x8 character for a code point above Latin-1, or NULL */
static const uint8_t *glyph8(unsigned cp) {
    int lo = 0, hi = G8_N - 1;
    while (lo <= hi) { int mid = (lo + hi) / 2; if (G8_CP[mid] == cp) return G8_ROWS[mid]; if (G8_CP[mid] < cp) lo = mid + 1; else hi = mid - 1; }
    return 0;
}
static void g8(int rx, int ry, const uint8_t *g, int s, uint32_t c) {
    for (int j = 0; j < 8; j++) {
        int i = 0;
        while (i < 8) {
            if (g[j] & (128 >> i)) { int st = i; while (i < 8 && (g[j] & (128 >> i))) i++; rr(B, rx + st * s, ry + j * s, (i - st) * s, s, c); }
            else i++;
        }
    }
}
static int skip_cp(unsigned cp) { return cp < 32 || (cp >= 0xfe00 && cp <= 0xfe0f) || cp == 0x200d; }
static int advc(unsigned cp) {
    if (skip_cp(cp)) return 0;
    if (!ui_font) return 16;
    if (cp < 256) return M5_ADV[cp - 32] * TS;
    return glyph8(cp) ? 8 * TS + TS : M5_ADV['?' - 32] * TS;
}
static void drawc(int rx, int ry, unsigned cp, uint32_t c) {
    if (skip_cp(cp)) return;
    if (cp < 256) { rglyph(rx, ry, (unsigned char)cp, c); return; }
    const uint8_t *g = glyph8(cp);
    if (!g) { rglyph(rx, ry, '?', c); return; }
    if (!ui_font) g8(rx, ry + Y8, g, 2, c); else g8(rx, ry + 12, g, TS, c);
}
static int adv(unsigned char ch) { return ch < 32 ? 0 : !ui_font ? 16 : M5_ADV[ch - 32] * TS; }
/* one character centred in an 8-px cell (button letters) */
static void glyph(int x, int y, unsigned char ch, uint32_t c) { rglyph(x * 2 + (16 - adv(ch) + TS) / 2, y * 2 - 6, ch, c); }
static int txt_real(int rx, int ry, const char *s, uint32_t c, int maxw) {
    int w = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p;) {
        unsigned cp = u8next(&p); int a = advc(cp);
        if (w + a - TS > maxw) break;
        drawc(rx + w, ry, cp, c);
        w += a;
    }
    return w;
}
static int txt(int x, int y, const char *s, uint32_t c, int maxch) {
    int w = txt_real(x * 2, y * 2 - 6, s, c, maxch * 16);
    return (w + 1) / 2;
}
static int txtw(const char *s, int maxch) {
    int w = 0, maxw = maxch * 16;
    for (const unsigned char *p = (const unsigned char *)s; *p;) { int a = advc(u8next(&p)); if (w + a - TS > maxw) break; w += a; }
    return (w > 0 ? w - TS + 1 : 0) / 2 + 1;
}
/* bold-ish text with a soft drop shadow */
static int txt_pop(int x, int y, const char *s, uint32_t c, uint32_t sh, int maxch) {
    txt(x + 1, y + 1, s, sh, maxch);
    return txt(x, y, s, c, maxch);
}
static void txt_center(int cx, int y, const char *s, uint32_t c, int maxch) {
    txt(cx - txtw(s, maxch) / 2, y, s, c, maxch);
}

/* GBA window: rounded navy border, white inner rim, fill, drop shadow */
static void win(int x, int y, int w, int h, uint32_t fill) {
    R(x + 2, y + h, w - 1, 2, SHADOW);
    R(x + w, y + 2, 2, h - 1, SHADOW);
    R(x + 2, y, w - 4, 1, NAVY); R(x + 2, y + h - 1, w - 4, 1, NAVY);
    R(x, y + 2, 1, h - 4, NAVY); R(x + w - 1, y + 2, 1, h - 4, NAVY);
    P(x + 1, y + 1, NAVY); P(x + w - 2, y + 1, NAVY); P(x + 1, y + h - 2, NAVY); P(x + w - 2, y + h - 2, NAVY);
    R(x + 2, y + 1, w - 4, 1, RIM); R(x + 2, y + h - 2, w - 4, 1, RIM);
    R(x + 1, y + 2, 1, h - 4, RIM); R(x + w - 2, y + 2, 1, h - 4, RIM);
    R(x + 2, y + 2, w - 4, h - 4, fill);
}
static void pill(int x, int y, int w, int h, uint32_t fill) {
    R(x + 1, y, w - 2, h, fill); R(x, y + 1, w, h - 2, fill);
}

/* ---------------- Playload's icon: "PL" on purple and yellow halves, a 16x16 design ---------------- */
static const char *const LOGO[16] = {
    "........########",
    "........########",
    "........########",
    "........########",
    "######......####",
    ".##..##.#..#####",
    ".##..##.#..#####",
    ".#####..#..#####",
    ".##.....#..###.#",
    ".##.....#..##..#",
    "####...........#",
    "........########",
    "........########",
    "........########",
    "........########",
    "........########",
};
/* x, y in virtual px; px = size of one design pixel in real px */
static void logo(int x, int y, int px, int frame) {
    const uint32_t purple = C(85,65,95), yellow = C(230,200,110);
    if (frame) rr(B, x * 2 - 2, y * 2 - 2, 16 * px + 4, 16 * px + 4, NAVY);
    for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) rr(B, x * 2 + i * px, y * 2 + j * px, px, px, LOGO[j][i] == '#' ? yellow : purple);
}

/* ---------------- screen furniture ---------------- */
void ui_bg(double t) {
    B = T;
    int off = TH->anim ? (int)(t * 10) % 32 : 0;
    for (int y = -32; y < UH; y += 16)
        for (int x = -32; x < UW; x += 16) {
            int cx = x + off, cy = y + off;
            int odd = ((x + 32) / 16 + (y + 32) / 16) & 1;
            R(cx, cy, 16, 16, odd ? BG1 : BG2);
            if (odd) continue;
            const uint8_t *g = TH->motif ? glyph8(TH->motif) : 0;
            if (g) g8(cx * 2 + 8, cy * 2 + 8, g, 2, BG1); else { P(cx + 7, cy + 7, BG1); P(cx + 8, cy + 8, BG1); }
        }
}
void ui_header(const char *title, const char *right, double t, int mood) {
    B = T;
    win(4, 9, UW - 8, 26, CREAM);
    (void)mood; (void)t;
    logo(9, 14, 2, 1);
    int rw = right && *right ? txtw(right, 16) + 10 : 0;
    txt_pop(32, 14, title, TEXT, SHADOW, (UW - 44 - rw - 8) / 8);
    if (rw) {
        int px = UW - 12 - rw;
        pill(px, 14, rw, 16, NAVY);
        txt(px + 5, 14, right, MINT, 16);
    }
}
static void button_icon(int x, int y, const char *k, int *w) {
    uint32_t c = LAV, tc = PILLTX;
    if (!strcmp(k, "A")) c = PINK;
    if (TH->anim == 0 && TH->outline == C(15,56,15)) tc = C(155,188,15);
    else if (!strcmp(k, "B")) { c = YELLOW; tc = NAVY; }
    else if (!strcmp(k, "X")) c = SKY;
    else if (!strcmp(k, "Y")) c = TEAL;
    int n = (int)strlen(k);
    if (n == 1) {
        R(x + 3, y, 8, 14, NAVY); R(x + 1, y + 1, 12, 12, NAVY); R(x, y + 3, 14, 8, NAVY);
        R(x + 3, y + 1, 8, 12, c); R(x + 1, y + 3, 12, 8, c); R(x + 2, y + 2, 10, 10, c);
        R(x + 4, y + 2, 4, 1, WHITE);
        glyph(x + 3, y - 1, (unsigned char)k[0], tc);
        *w = 14;
    } else {
        int ww = txtw(k, 12) + 6;
        pill(x, y, ww, 14, NAVY); pill(x + 1, y + 1, ww - 2, 12, c);
        txt(x + 3, y - 1, k, tc, 12);
        *w = ww;
    }
}
/* hints like "A:Open  B:Back  MENU:Quit" */
static char foot_badge[24];
void ui_footer_badge(const char *b) { snprintf(foot_badge, sizeof foot_badge, "%s", b ? b : ""); }
void ui_footer(const char *hints) {
    B = T;
    win(4, UH - 26, UW - 8, 22, CREAM);
    int arrow = foot_badge[0] == 2;
    const char *bt = foot_badge + arrow;
    int bw = foot_badge[0] ? txtw(bt, 12) + 8 + (arrow ? 8 : 0) : 0;
    if (bw) {
        int bx = UW - 10 - bw;
        pill(bx, UH - 22, bw, 15, NAVY);
        if (arrow) {   /* small down arrow */
            int ax = bx + 4, ay = UH - 19;
            R(ax + 2, ay, 2, 5, MINT); R(ax, ay + 4, 6, 1, MINT); R(ax + 1, ay + 5, 4, 1, MINT); R(ax + 2, ay + 6, 2, 1, MINT);
        }
        txt(bx + 4 + (arrow ? 8 : 0), UH - 23, bt, MINT, 12);
    }
    if (!hints) return;
    int x = 12, y = UH - 22;
    char tok[64];
    const char *p = hints;
    while (*p) {
        while (*p == ' ') p++;
        if (!*p) break;
        int n = 0;
        while (p[n] && !(p[n] == ' ' && p[n + 1] == ' ') && n < 63) n++;
        memcpy(tok, p, (size_t)n); tok[n] = 0; p += n;
        char *colon = strchr(tok, ':');
        if (colon) {
            *colon = 0; int w = 0;
            button_icon(x, y + 1, tok, &w);
            x += w + 4;
            x += txt(x, y, colon + 1, INK, 20) + 12;
        } else x += txt(x, y, tok, INK, 30) + 12;
        if (x > UW - 20 - bw) break;
    }
}
void ui_toast(const char *msg) {
    B = T;
    if (!msg || !*msg) return;
    int w = txtw(msg, 34) + 20;
    int x = (UW - w) / 2, y = UH - 52;
    win(x, y, w, 22, YELLOWL);
    txt(x + 10, y + 3, msg, TEXT, 34);
}

static void cursor(int x, int y, double t) {
    int dx = ((int)(t * 4) & 1);
    x += dx;
    for (int i = 0; i < 5; i++) R(x + i, y + i, 1, 11 - 2 * i, NAVY);
    for (int i = 0; i < 3; i++) R(x + 1 + i, y + 2 + i, 1, 7 - 2 * i, PINK);
}
int ui_marquee_extra = 0;   /* how many characters the selected title scrolls (set while drawing) */
void ui_list(const URow *rows, int n, int sel, int top, int moff, double t, const char *empty) {
    B = T;
    int x = 4, y = 38, w = UW - 8, h = UVIS * UROWH + 12;
    win(x, y, w, h, WHITE);
    if (!n) {
        /* sleepy TV with one or two lines under it ("\n" splits), centred in the box */
        const char *msg = empty ? empty : "Nothing here.";
        char l1b[80]; const char *nl = strchr(msg, '\n'), *l2 = 0;
        if (nl) { size_t k = (size_t)(nl - msg); if (k >= sizeof l1b) k = sizeof l1b - 1; memcpy(l1b, msg, k); l1b[k] = 0; l2 = nl + 1; msg = l1b; }
        int block = 81 + 6 + (l2 ? 26 : 13);
        int my = y + (h - block) / 2 - 2;
        logo(UW / 2 - 32, my + 8, 4, 1);
        txt_center(UW / 2, my + 85, msg, DIM, 36);
        if (l2) txt_center(UW / 2, my + 98, l2, DIM, 36);
        return;
    }
    for (int i = 0; i < UVIS && top + i < n; i++) {
        int pos = top + i, ry = y + 6 + i * UROWH;
        const URow *r = &rows[i];   /* rows[i] is item top+i */
        int hi = pos == sel;
        if (!hi && (pos & 1)) R(x + 4, ry, w - 16, UROWH, ROWALT);
        if (hi) {
            R(x + 5, ry, w - 18, UROWH, HILITE); R(x + 4, ry + 1, w - 16, UROWH - 2, HILITE);
            R(x + 5, ry + UROWH - 2, w - 18, 1, HIEDGE);
            cursor(x + 7, ry + 3, t);
        }
        int sidew = r->side && *r->side ? txtw(r->side, 14) : 0;
        int mainw = (w - 40) - (sidew ? sidew + 8 : 0);          /* virtual px for the title */
        uint32_t c = r->tone == 1 ? GOOD : r->tone == 2 ? WARN : r->tone == 3 ? DIM : r->tone == 4 ? (TH->more ? TH->more : PINKD) : TEXT;
        if (hi) c = HITEXT;
        const char *m = r->main ? r->main : "";
        if (hi) {   /* moff = ms since this row was selected: scroll long titles */
            int extra = 0; const unsigned char *q = (const unsigned char *)m;
            while (*q && txtw((const char *)q, 100) > mainw) { u8next(&q); extra++; }
            ui_marquee_extra = extra;
            if (extra > 0 && moff > 1000) {
                int step = (moff - 1000) / 200 % (extra + 10); if (step > extra) step = extra;
                q = (const unsigned char *)m; while (step-- > 0 && *q) u8next(&q);
                m = (const char *)q;
            }
        }
        txt_real((x + 18) * 2, (ry + 1) * 2 - 6, m, c, mainw * 2);
        if (sidew) txt(x + w - 12 - sidew, ry + 1, r->side, hi ? HITEXT : DIM, 14);
    }
    /* scrollbar */
    if (n > UVIS) {
        int tx = x + w - 8, ty = y + 6, th = h - 12;
        R(tx, ty, 3, th, TRACK);
        int bh = th * UVIS / n; if (bh < 8) bh = 8;
        int by = ty + (th - bh) * top / (n - UVIS);
        R(tx, by, 3, bh, PINK);
    }
}
/* header with tabs instead of a title (home screen) */
void ui_header_tabs(const char *const *tabs, int n, int sel, const char *right, double t) {
    (void)right;
    ui_header("", "", t, 0);
    B = T;
    int x = 31;
    int avail = UW - 10 - x;
    int total = 0;
#define TABW(i) (tabs[i][0] == 1 ? 14 : txtw(tabs[i], 12) + 5)
    for (int i = 0; i < n; i++) total += TABW(i);
    int gap = n > 1 ? (avail - total) / (n - 1) : 0;
    if (gap > 8) gap = 8;
    if (gap < 0) gap = 0;
    for (int i = 0; i < n; i++) {
        int w = TABW(i);
        if (i == sel) pill(x, 13, w, 18, NAVY), pill(x + 1, 14, w - 2, 16, TH->tab ? TH->tab : PINK);
        uint32_t c = i == sel ? PILLTX : DIM;
        if (tabs[i][0] == 1) {   /* little pixel gear */
            static const char *G[10] = { "...##...", ".#.##.#.", "########", ".##..##.", "##....##", "##....##", ".##..##.", "########", ".#.##.#.", "...##..." };
            int gx = x + (w - 8) / 2, gy = 17;
            for (int j = 0; j < 10; j++) for (int k = 0; k < 8; k++) if (G[j][k] == '#') R(gx + k, gy + j, 1, 1, c);
        } else txt(x + 3, 14, tabs[i], c, 12);
        x += w + gap;
    }
}
/* popup menu over whatever is on screen */
void ui_menu(const char *title, const char *const *items, int n, int sel, double t) {
    B = T;
    int maxl = txtw(title, 30);
    for (int i = 0; i < n; i++) { int l = txtw(items[i], 30) + 10; if (l > maxl) maxl = l; }
    int w = maxl + 40, h = n * UROWH + 34;
    if (w < 160) w = 160;
    int x = (UW - w) / 2, y = (UH - h) / 2;
    win(x, y, w, h, WHITE);
    R(x + 2, y + 2, w - 4, 20, CREAM);
    R(x + 2, y + 22, w - 4, 1, NAVY);
    txt(x + 10, y + 4, title, TEXT, 30);
    for (int i = 0; i < n; i++) {
        int ry = y + 27 + i * UROWH;
        if (i == sel) {
            R(x + 5, ry, w - 10, UROWH, HILITE); R(x + 4, ry + 1, w - 8, UROWH - 2, HILITE);
            cursor(x + 7, ry + 3, t);
        }
        txt(x + 20, ry + 1, items[i], i == sel ? HITEXT : TEXT, 30);
    }
}

/* ---------------- pieces for the screens the kit didn't have ---------------- */
/* the big list window, empty, for free-form screens */
void ui_panel(void) { B = T; win(4, 38, UW - 8, UVIS * UROWH + 12, WHITE); }
/* role: 0 text, 1 dim, 2 accent, 3 good, 4 warn, 5 yellow. centred if x < 0 */
void ui_text(int x, int y, const char *s, int role) {
    B = T;
    uint32_t c = role == 1 ? DIM : role == 2 ? PINK : role == 3 ? GOOD : role == 4 ? WARN : role == 5 ? YELLOW : TEXT;
    y += OY;                                   /* the fixed layouts stay together in the middle of a larger screen */
    if (x < 0) txt_center(UW / 2, y, s, c, 38); else txt(x + (UW - 320) / 2, y, s, c, 38);
}
/* a QR code: modules[n*n] of 0/1, on a white card. x, y virtual (x < 0 = centred), px = real px per module */
void ui_qr(const unsigned char *modules, int n, int x, int y, int px) {
    B = T;
    int size = (n + 8) * px, rx = x < 0 ? (RW - size) / 2 : x * 2 + (RW - 640) / 2, ry = (y + OY) * 2;
    rr(B, rx - 2, ry - 2, size + 4, size + 4, NAVY);
    rr(B, rx, ry, size, size, C(255,255,255));
    for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) if (modules[j * n + i]) rr(B, rx + (i + 4) * px, ry + (j + 4) * px, px, px, C(0,0,0));
}


/* ---------------- the frame around a game, in the theme's colours ----------------
   The game's picture is 480x432 at (80,24). Everything here is in real pixels. */
static uint32_t mix(uint32_t a, uint32_t b, double k) {
    int r = (int)((a >> 16 & 255) + ((int)(b >> 16 & 255) - (int)(a >> 16 & 255)) * k), g = (int)((a >> 8 & 255) + ((int)(b >> 8 & 255) - (int)(a >> 8 & 255)) * k), bl = (int)((a & 255) + ((int)(b & 255) - (int)(a & 255)) * k);
    return C(r, g, bl);
}
static void glow(int cx, int cy, int core, int reach, uint32_t light, uint32_t under) {
    for (int y = cy - reach; y <= cy + reach; y++) for (int x = cx - reach; x <= cx + reach; x++) {
        double d = hypot(x - cx, y - cy);
        if (x < 0 || y < 0 || x >= RW || y >= RH) continue;
        if (d <= core) { double w = 0.55 - d * 0.14; T[y * RW + x] = mix(mix(light, C(0,0,0), d * 0.06), C(255,255,255), w > 0 ? w : 0); }
        else if (d <= reach) { double g = 1 - (d - core) / (reach - core); T[y * RW + x] = mix(under, light, g * g * 0.42); }
    }
}
static void word8(int x, int y, const char *text, uint32_t c) {
    for (int k = 0; text[k]; k++) { const uint8_t *g = glyph8((unsigned char)text[k]); if (g) g8(x + k * 8, y, g, 1, c); }
}
static const uint32_t DB8[8] = { C(0,0,0), C(0x55,0x41,0x5f), C(0x64,0x69,0x64), C(0xd7,0x73,0x55), C(0x50,0x8c,0xd7), C(0x64,0xb9,0x64), C(0xe6,0xc8,0x6e), C(0xdc,0xf5,0xff) };
/* The frame: always the dark one (after the PICO-8 frames that come with Onion), all the way round the game.
   The logo and the power light take the selected theme's colours; on Pink the light is a heart. */
/* the game's picture is 480x432 in the middle of the screen; the light sits in the middle of the left margin */
#define FGX ((RW - 480) / 2)
#define FGY ((RH - 432) / 2)
#define LIGHT_X (FGX / 2)
#define LIGHT_Y (FGY + 128)
static const Theme *dark_theme(void) { for (int i = 0; i < NTHEMES; i++) if (!strcmp(THEMES[i].name, "Dark")) return &THEMES[i]; return &THEMES[0]; }
/* on = 0 (dark, half of a flash) or 1 */
void ui_frame_light(int on) {
    B = T;
    const uint32_t body = dark_theme()->fbody, light = TH->flight;
    rr(B, LIGHT_X - 20, LIGHT_Y - 20, 41, 41, body);
    if (TH->hearts) {
        if (on) glow(LIGHT_X, LIGHT_Y, 0, 20, TH->flogoa, body);
        const uint8_t *h = glyph8(0x2665);
        if (h) g8(LIGHT_X - 12, LIGHT_Y - 12, h, 3, on ? TH->flogoa : mix(body, TH->flogoa, 0.25));
    } else if (on) glow(LIGHT_X, LIGHT_Y, 5, 15, light, body);
    else for (int y = -5; y <= 5; y++) for (int x = -5; x <= 5; x++) if (x * x + y * y <= 25) T[(LIGHT_Y + y) * RW + LIGHT_X + x] = mix(body, light, 0.2);
}
void ui_game_frame(int light_on) {
    B = T;
    const Theme *D = dark_theme();
    const uint32_t body = D->fbody, black = C(0,0,0);
    const int GX = FGX, GY = FGY, GW = 480, GH = 432;
    rr(B, 0, 0, RW, RH, body);                                    /* all four sides, flat, no rim */
    rr(B, GX - 1, GY - 1, GW + 2, GH + 2, D->fdeep); rr(B, GX, GY, GW, GH, black);
    ui_frame_light(light_on);
    word8(LIGHT_X - 20, LIGHT_Y + (TH->hearts ? 18 : 13), "POWER", D->fink);
    if (TH->hearts) for (int k = 0; k < 3; k++) { const uint8_t *h = glyph8(k == 1 ? 0x2661 : 0x2665); if (h) g8(LIGHT_X - 8, LIGHT_Y + 98 + k * 44, h, 2, mix(body, TH->flogoa, 0.55)); }
    /* the logo, three times its size, reading upward, its top level with the light; Playload's colours under it */
    const int ox = GX + GW + GX / 2 - 12, oy = LIGHT_Y - 5;
    for (int i = 0; i < 64; i++) for (int j = 0; j < 8; j++)
        rr(B, ox + j * 3, oy + (63 - i) * 3, 3, 3, mix(body, LOGO8[j][i] == '#' ? TH->flogob : TH->flogoa, 0.62));
    for (int k = 1; k < 8; k++) rr(B, ox + ((k - 1) % 4) * 6, oy + 200 + ((k - 1) / 4) * 6, 5, 5, mix(body, DB8[k], 0.55));
}

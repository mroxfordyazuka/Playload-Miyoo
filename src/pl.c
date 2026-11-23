/* Playload for the Miyoo Mini Plus (Onion OS).
   Runs Playload's own JavaScript engine (github.com/kitao/playload, MIT) inside QuickJS, and gives it
   a screen, buttons and a sound chip.

   Usage on the device:  playload <app_dir> [rotate_180 0|1]
   HOST build (no SDL):  playload <app_dir> shot <game|menu> <frames> <out.ppm> [keys]
                         playload <app_dir> hash <game> <frames>
                         playload <app_dir> bench <game> <frames>
                         playload <app_dir> wav <game> <frames> <out.wav>
                         (<game> is a file holding either a Playload link or plain game source) */
#include "pl.h"
#include "js.h"
#include "ui.h"
#include "version.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <signal.h>
#ifndef HOST
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/fb.h>
#include <SDL/SDL.h>
#endif

#define MAX_FRAME_STEPS 5

static void say(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap); putchar('\n'); fflush(stdout);
}
static double now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}
static char *read_file(const char *dir, const char *name, size_t *len) {
    char path[700]; if (dir) snprintf(path, sizeof path, "%s/%s", dir, name); else snprintf(path, sizeof path, "%s", name);
    FILE *f = fopen(path, "rb"); if (!f) return 0;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 8 * 1024 * 1024) { fclose(f); return 0; }
    char *b = malloc((size_t)n + 1); if (!b) { fclose(f); return 0; }
    size_t got = fread(b, 1, (size_t)n, f); fclose(f);
    b[got] = 0; if (len) *len = got;
    return b;
}

/* ---------------- sound lock ---------------- */
#ifndef HOST
static int g_audio_on;
#define AUDIO_LOCK() do { if (g_audio_on) SDL_LockAudio(); } while (0)
#define AUDIO_UNLOCK() do { if (g_audio_on) SDL_UnlockAudio(); } while (0)
#else
#define AUDIO_LOCK() ((void)0)
#define AUDIO_UNLOCK() ((void)0)
#endif

/* ---------------- the running program (a game, or the game list) ---------------- */
static struct { int live, started, wide, w, h; double deadline; } P;
static char g_dir[512], g_error[400], g_title[160];
static char *g_bundle, *g_menu_src, *g_games_json, *g_mine;
static size_t g_bundle_len;
static int g_tab, g_sel, g_quit, g_raw, g_fixed_random, g_update;
static char g_head[40] = "GAME STOPPED";
static char *g_launch;
static char *g_cur_hash, *g_cur_src;      /* the game being played: its link (NULL for a dev build) and its source */
static int g_keep_error;
static int g_appupdate;                    /* Settings asked to update the app itself */
static char g_new_version[24];             /* a newer version we know is out, or "" */
static int g_offer, g_from_offer;          /* a newer version was just found: show the full-screen offer when the list is up */
static double g_busy_until;                /* the power light flickers until then */
static double g_t0;
static uint8_t g_px[320 * 240];

/* ---- what the JavaScript side can ask for. The engine backends (js_quickjs.c, js_jsc.cpp) only pass these along. ---- */
int h_timed_out(void) { return now_ms() > P.deadline; }
void h_error(const char *msg, const char *stack) {
    int line = 0;
    if (stack) { const char *at = strstr(stack, "<input>:"); if (at) line = atoi(at + 8) - 2; }   /* the game's code is two lines into its wrapper */
    if (msg && (!strcmp(msg, "interrupted") || strstr(msg, "terminated") || strstr(msg, "timed out"))) snprintf(g_error, sizeof g_error, "The game stopped responding.");
    else if (line > 0) snprintf(g_error, sizeof g_error, "Line %d: %s", line, msg ? msg : "Game error");
    else snprintf(g_error, sizeof g_error, "%s", msg && msg[0] ? msg : "Game error");
    say("game error: %s", g_error);
    if (stack && stack[0]) say("%s", stack);
}
/* a compiled score: [fixedVolume, (op, a, b) ...] */
void h_play(int ch, const double *flat, size_t count) {
    if (ch < 0 || ch > 2 || count < 1) return;
    int n = (int)((count - 1) / 3);
    AyEvent *code = n ? malloc(sizeof(AyEvent) * (size_t)n) : 0;
    if (n && !code) return;
    for (int i = 0; i < n; i++) { code[i].op = (int)flat[1 + i * 3]; code[i].a = flat[2 + i * 3]; code[i].b = flat[3 + i * 3]; }
    AUDIO_LOCK(); ay_play(ch, code, n, flat[0] != 0); AUDIO_UNLOCK();
}
static inline void glyph(uint8_t *px, int w, int h, const uint8_t *pat, int x, int y, int c1, int c2) {
    if (x <= -8 || y <= -8 || x >= w || y >= h) return;
    for (int row = 0; row < 8; row++) {
        int py = y + row; if (py < 0 || py >= h) continue;
        uint8_t *d = px + py * w + x; unsigned bits = pat[row];
        if (x >= 0 && x + 8 <= w) {
            if (c2 >= 0) for (int b = 0; b < 8; b++) d[b] = (uint8_t)(bits & (128u >> b) ? c1 : c2);
            else for (int b = 0; b < 8; b++) { if (bits & (128u >> b)) d[b] = (uint8_t)c1; }
        } else for (int b = 0; b < 8; b++) {
            if (x + b < 0 || x + b >= w) continue;
            if (bits & (128u >> b)) d[b] = (uint8_t)c1; else if (c2 >= 0) d[b] = (uint8_t)c2;
        }
    }
}
static struct { uint8_t *p[7]; size_t n[7]; int cols, ok; } R;
void h_bind(uint8_t *const p[7], const size_t n[7], int cols) {
    R.ok = 0;
    for (int i = 0; i < 7; i++) { if (!p[i]) return; R.p[i] = p[i]; R.n[i] = n[i]; }
    int cells = (int)n[4], rows = cols > 0 ? cells / cols : 0, nslot = (int)(n[1] / 8);
    if (cols <= 0 || rows <= 0 || n[0] != (size_t)(cols * 8 * rows * 8) || n[3] < (size_t)cells * 4 || n[5] < (size_t)cells || n[2] < (size_t)nslot * 2) return;
    if (((uintptr_t)p[3] & 3) || ((uintptr_t)p[6] & 3)) return;
    R.cols = cols; R.ok = 1;
}
/* paint the frame: the text screen, then the sprites. the body of the engine's render() */
void h_render(int nspr) {
    if (!R.ok) return;
    uint8_t *px = R.p[0]; const uint8_t *gb = R.p[1], *gc = R.p[2]; const int32_t *cs = (const int32_t *)R.p[3];
    const int8_t *k1 = (const int8_t *)R.p[4], *k2 = (const int8_t *)R.p[5]; const int32_t *sp = (const int32_t *)R.p[6];
    int cols = R.cols, cells = (int)R.n[4], rows = cells / cols, w = cols * 8, h = rows * 8, nslot = (int)(R.n[1] / 8);
    if (nspr < 0 || R.n[6] < (size_t)nspr * 16) return;
    for (int i = 0; i < cells; i++) {
        int slot = cs[i]; if (slot < 0 || slot >= nslot) continue;
        int c1 = k1[i], c2 = k2[i];
        if (c1 < 0) c1 = gc[slot * 2];
        if (c2 < 0) c2 = gc[slot * 2 + 1];
        const uint8_t *pat = gb + slot * 8; uint8_t *d = px + (i / cols) * 8 * w + (i % cols) * 8;
        for (int row = 0; row < 8; row++, d += w) { unsigned bits = pat[row]; for (int b = 0; b < 8; b++) d[b] = (uint8_t)(bits & (128u >> b) ? c1 : c2); }
    }
    for (int i = 0; i < nspr; i++) {
        int slot = sp[i * 4 + 2]; if (slot < 0 || slot >= nslot) continue;
        glyph(px, w, h, gb + slot * 8, sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 3] & 7, -1);
    }
}
double h_now(void) { return now_ms() - g_t0; }
void h_log(const char *text) { say("js: %s", text); }
char *h_decode(const char *hash) { return payload_decode(hash, 0, 0); }
void h_launch(const char *hash, const char *title) { free(g_launch); g_launch = strdup(hash); snprintf(g_title, sizeof g_title, "%s", title ? title : ""); }
void h_quit(void) { g_quit = 1; }
int h_raw(void) { return g_raw; }
void h_remember(int tab, int sel) { g_tab = tab; g_sel = sel; }
void h_update(void) { g_update = 1; }
int h_serve(int on) { if (on) { int ok = srv_start() == 0; srv_dev(ok && on == 2); return ok; } srv_stop(); return 0; }   /* 1 = links from a phone, 2 = that and the dev panel */
const char *h_addr(void) { return srv_addr(); }
int h_inbox(void) { return srv_count(); }
char *h_mine(void) { char *t = read_file(g_dir, "mygames.txt", 0); return t ? t : strdup(""); }

static void prog_free(void) {
    if (!P.live && !P.started) return;
    AUDIO_LOCK(); ay_reset(); AUDIO_UNLOCK();
    js_stop();
    R.ok = 0;
    memset(&P, 0, sizeof P);
}
/* 0 = started; -1 = failed (g_error says why) */
static int prog_start(const char *source, int wide) {
    prog_free();
    P.started = 1; P.wide = wide; P.w = wide ? 320 : 160; P.h = wide ? 240 : 144;
    P.deadline = now_ms() + 8000;
    char *arcade = wide ? read_file(g_dir, "arcade.json", 0) : 0;
    JsMenu m = { g_games_json, arcade ? arcade : "", g_tab, g_sel, g_error, g_head };
    int e = js_start(g_bundle, g_bundle_len, source, wide, &m, g_fixed_random);
    free(arcade);
    if (e) { prog_free(); return -1; }
    P.live = 1;
    return 0;
}
/* one tick. returns how many frames the engine asks us to wait (its overflow penalty), or -1 if the game failed */
static int prog_frame(int mask) {
    P.deadline = now_ms() + 3000;
    int wait = js_frame(mask);
    return wait < 0 ? -1 : wait > 2 ? 2 : wait;
}
static int prog_pixels(void) {
    P.deadline = now_ms() + 3000;
    if (js_pixels()) return -1;
    if (R.ok && R.n[0] == (size_t)(P.w * P.h)) memcpy(g_px, R.p[0], R.n[0]);
    return 0;
}

static int load_app(void) {
    g_bundle = read_file(g_dir, "playload.js", &g_bundle_len);
    g_menu_src = read_file(g_dir, "menu.js", 0);
    g_games_json = read_file(g_dir, "games.json", 0);
    g_mine = read_file(g_dir, "mygames.txt", 0);
    if (!g_bundle || !g_menu_src || !g_games_json) { say("missing playload.js, menu.js or games.json in %s", g_dir); return -1; }
    return 0;
}
static int start_menu(void) {
    char *mine = read_file(g_dir, "mygames.txt", 0);
    if (mine) { free(g_mine); g_mine = mine; }
    if (srv_is_dev()) snprintf(g_head, sizeof g_head, "DEV");      /* a dev session goes back to its own screen, server still up */
    else srv_stop();
    int e = prog_start(g_menu_src, 1);
    g_error[0] = 0; snprintf(g_head, sizeof g_head, "GAME STOPPED");
    return e;
}
/* returns 0 if the game is running, -1 if we are (back) at the list with g_error shown */
static int start_game(const char *hash) {
    const char *why = 0; char *src = payload_decode(hash, 0, &why);
    int e = -1;
    if (!src) snprintf(g_error, sizeof g_error, "%s", why ? why : "Invalid game URL");
    else { e = prog_start(src, 0); free(g_cur_src); g_cur_src = src; free(g_cur_hash); g_cur_hash = strdup(hash); }
    if (e) { say("could not start \"%s\": %s", g_title, g_error); start_menu(); return -1; }
    say("playing \"%s\"", g_title);
    g_busy_until = now_ms() + 900;
    return 0;
}

/* the list asked for the Arcade update: fetch it, then show the list again with the outcome */
static int run_update(void) {
    char msg[200]; g_update = 0;
    say("update: fetching the Arcade list");
    int e = net_update(g_dir, msg, sizeof msg);
    if (e) snprintf(g_error, sizeof g_error, "%s", msg);
    else { snprintf(g_error, sizeof g_error, "%s games in the Arcade list now.", msg); g_tab = 0; g_sel = 0; }
    say("update: %s", g_error);
    snprintf(g_head, sizeof g_head, e ? "UPDATE FAILED" : "ARCADE UPDATED");
    srv_stop();
    int r = prog_start(g_menu_src, 1);
    g_error[0] = 0; snprintf(g_head, sizeof g_head, "GAME STOPPED");
    return r;
}

/* dev panel: source pushed from a browser. 0 = nothing, 1 = it is running now, 2 = it failed and the list is back */
static int dev_take(void) {
    char *src = srv_take_run(); if (!src) return 0;
    snprintf(g_title, sizeof g_title, "Dev build");
    int e = prog_start(src, 0); free(g_cur_src); g_cur_src = src; free(g_cur_hash); g_cur_hash = 0;
    if (e) { say("dev: did not start: %s", g_error); srv_status("error", g_error, 0); start_menu(); return 2; }
    say("dev: running"); srv_status("running", "", 0); g_busy_until = now_ms() + 900;
    return 1;
}

static const uint8_t PALETTE[8][3] = { {0x00,0x00,0x00}, {0x55,0x41,0x5f}, {0x64,0x69,0x64}, {0xd7,0x73,0x55}, {0x50,0x8c,0xd7}, {0x64,0xb9,0x64}, {0xe6,0xc8,0x6e}, {0xdc,0xf5,0xff} };

/* ---------------- settings (settings.txt: "key value" lines; launch.sh reads engine and overclock from it) ---------------- */
static struct { int theme, effect, bezel, volume, overclock, autoupdate, font, lang; char engine[24]; } S = { 5, 1, 1, 150, 1600, 1, 1, -1, "jit" };   /* theme 5 = Dark; bezel: 0 no frame, 1 the dark one; font 1 = soft */
static void settings_load(void) {
    char *t = read_file(g_dir, "settings.txt", 0); if (!t) return;
    for (char *line = strtok(t, "\r\n"); line; line = strtok(0, "\r\n")) {
        char k[24], v[24]; if (sscanf(line, "%23s %23s", k, v) != 2) continue;
        if (!strcmp(k, "theme")) S.theme = atoi(v); else if (!strcmp(k, "effect")) S.effect = atoi(v);
        else if (!strcmp(k, "bezel")) S.bezel = atoi(v); else if (!strcmp(k, "volume")) S.volume = atoi(v);
        else if (!strcmp(k, "overclock")) S.overclock = atoi(v); else if (!strcmp(k, "autoupdate")) S.autoupdate = !!atoi(v); else if (!strcmp(k, "font")) S.font = !!atoi(v); else if (!strcmp(k, "lang")) S.lang = !!atoi(v); else if (!strcmp(k, "engine")) snprintf(S.engine, sizeof S.engine, "%s", v);
    }
    free(t);
    if (S.theme < 0 || S.theme >= ui_theme_count()) S.theme = 5;
    if (S.volume < 25 || S.volume > 400) S.volume = 150;
    S.effect = S.effect < 0 || S.effect > 1 ? 1 : S.effect; S.bezel = S.bezel != 0;
    if (strcmp(S.engine, "small")) snprintf(S.engine, sizeof S.engine, "jit");
    if (S.overclock && (S.overclock < 1000 || S.overclock > 1800)) S.overclock = 1600;
}
static void settings_save(void) {
    char path[700]; snprintf(path, sizeof path, "%s/settings.txt", g_dir);
    FILE *f = fopen(path, "w"); if (!f) return;
    fprintf(f, "theme %d\neffect %d\nbezel %d\nvolume %d\nengine %s\noverclock %d\nautoupdate %d\nfont %d\nlang %d\n", S.theme, S.effect, S.bezel, S.volume, S.engine, S.overclock, S.autoupdate, S.font, S.lang);
    fclose(f);
}

/* ---------------- the picture: one frame of 0xRRGGBB the size of the screen, for the list (drawn by ui.c) and for games.
   640x480 on a Miyoo Mini v1-v3 / Mini Plus; 752x560 on a Mini v4 / Mini Flip (Onion gives the app that when its
   folder has a "full_resolution" file). The game is always three times its size, in the middle. ---------------- */
#define WMAX 800
#define HMAX 600
static int W = 640, H = 480, GX = 80, GY = 24;
static void screen_size(int w, int h) { W = w; H = h; GX = (W - 480) / 2; GY = (H - 432) / 2; }
#define GW 480
#define GH 432
static uint32_t g_frame[WMAX * HMAX];
static uint32_t *g_fx;               /* the screen effect, ready-mixed: 8 colors x GW x GH */
static int g_backdrop = 1;           /* the area around the game needs repainting */
static int g_whole = 1;              /* the next present must send the whole frame, not just the game's window */

/* Scanlines in the style of ArchiveTV's (which came from Onion's RetroArch overlay): every third line at half
   brightness with a little blue, a soft darkening toward the edges, rounded corners. One game pixel is three lines. */
static void effect_build(void) {
    if (!g_fx) g_fx = malloc(sizeof(uint32_t) * 8 * GW * GH);
    if (!g_fx) return;
    for (int y = 0; y < GH; y++) for (int x = 0; x < GW; x++) {
        int dx = x < GW - 1 - x ? x : GW - 1 - x, dy = y < GH - 1 - y ? y : GH - 1 - y;
        int keep = y % 3 == 2 ? 128 : 255, ar = y % 3 == 2 ? 3 : 0, ag = y % 3 == 2 ? 12 : 0, ab = y % 3 == 2 ? 16 : 0;
        int vx = 244 + dx / 6, vy = 214 + dy * 2 / 3; if (vx > 255) vx = 255; if (vy > 255) vy = 255;
        keep = keep * vx / 255 * vy / 255;
        if (dx < 6 && dy < 6 && (6 - dx) * (6 - dx) + (6 - dy) * (6 - dy) > 40) { keep = 0; ar = ag = ab = 0; }
        for (int c = 0; c < 8; c++) {
            int r = (PALETTE[c][0] * keep >> 8) + ar, g = (PALETTE[c][1] * keep >> 8) + ag, b = (PALETTE[c][2] * keep >> 8) + ab;
            g_fx[(size_t)c * GW * GH + (size_t)y * GW + x] = ((uint32_t)(r > 255 ? 255 : r) << 16) | ((uint32_t)(g > 255 ? 255 : g) << 8) | (uint32_t)(b > 255 ? 255 : b);
        }
    }
}
static void pause_draw(void);
static int g_check_pid;
/* loading: a game or dev build has just started (the engine is still warming up), or the Arcade check is on the air */
static int frame_busy(void) { return S.bezel && (g_check_pid > 0 || now_ms() < g_busy_until); }
/* the game's 160x144 picture, three times larger, into the middle of the frame */
static void compose_game(int paused) {
    static int light = 1;
    int want = frame_busy() ? (int)(now_ms() / 130) & 1 : 1;       /* the power light flickers while something is loading */
    if (g_backdrop) {
        if (S.bezel) ui_game_frame(want); else memset(g_frame, 0, sizeof g_frame);
        g_backdrop = 0; g_whole = 1; light = want;
    } else if (S.bezel && want != light) { ui_frame_light(want); light = want; g_whole = 1; }
    static uint32_t pal[8];
    if (!pal[7]) for (int c = 0; c < 8; c++) pal[c] = ((uint32_t)PALETTE[c][0] << 16) | ((uint32_t)PALETTE[c][1] << 8) | PALETTE[c][2];
    int fx = S.effect && g_fx;
    for (int y = 0; y < GH; y++) {
        const uint8_t *src = g_px + (y / 3) * 160; uint32_t *d = g_frame + (GY + y) * W + GX;
        if (fx) { const uint32_t *row = g_fx + (size_t)y * GW; for (int x = 0; x < 160; x++) { const uint32_t *p = row + (size_t)(src[x] & 7) * GW * GH + x * 3; d[x * 3] = p[0]; d[x * 3 + 1] = p[1]; d[x * 3 + 2] = p[2]; } }
        else for (int x = 0; x < 160; x++) { uint32_t v = pal[src[x] & 7]; d[x * 3] = v; d[x * 3 + 1] = v; d[x * 3 + 2] = v; }
        if (paused) for (int x = 0; x < GW; x++) d[x] = (d[x] >> 1) & 0x7f7f7f;
    }
    if (paused) { pause_draw(); g_backdrop = 1; g_whole = 1; }
}

/* ---------------- what the list (menu.js) draws with: one call, ui(op, text, text, n, n, n, n) -> text ---------------- */
enum { UI_FRAME, UI_TABS, UI_HEADER, UI_LIST, UI_FOOTER, UI_TOAST, UI_PANEL, UI_TEXT, UI_QR, UI_GET, UI_SET, UI_ROWS, UI_THEMES, UI_MENU, UI_FAVS, UI_FAV, UI_FORGET };

/* ---- favorites.txt and mygames.txt: one game per line, "Name | https://kitao.dev/playload/app/#v1...." ---- */
static const char *link_in(const char *text, const char *hash) {
    size_t n = strlen(hash); if (!n) return 0;
    for (const char *p = text; (p = strstr(p, hash)); p += n) { unsigned char after = (unsigned char)p[n]; if (!after || after <= ' ') return p; }
    return 0;
}
static int list_has(const char *file, const char *hash) {
    char *t = read_file(g_dir, file, 0); int has = t && link_in(t, hash) != 0; free(t); return has;
}
/* drop every line that holds this link */
static void list_remove(const char *file, const char *hash) {
    char *t = read_file(g_dir, file, 0); if (!t) return;
    char path[700]; snprintf(path, sizeof path, "%s/%s", g_dir, file);
    char *keep = malloc(strlen(t) + 2); size_t k = 0;
    if (keep) {
        for (char *line = t; *line;) {
            char *end = strchr(line, '\n'); size_t n = end ? (size_t)(end - line) + 1 : strlen(line);
            char was = line[n]; line[n] = 0;
            if (!link_in(line, hash)) { memcpy(keep + k, line, n); k += n; }
            line[n] = was; line += n;
        }
        FILE *f = fopen(path, "w"); if (f) { fwrite(keep, 1, k, f); fclose(f); }
        free(keep);
    }
    free(t);
}
static void fav_set(const char *hash, const char *title, int on) {
    if (!hash || (strncmp(hash, "#v1.", 4) && strncmp(hash, "#1.", 3))) return;
    list_remove("favorites.txt", hash);
    if (!on) return;
    char name[160]; snprintf(name, sizeof name, "%s", title && title[0] ? title : "Game");
    for (char *p = name; *p; p++) if (*p == '|' || *p == '#' || *p == '\r' || *p == '\n' || *p == '\t') *p = ' ';
    char path[700]; snprintf(path, sizeof path, "%s/favorites.txt", g_dir);
    FILE *f = fopen(path, "a"); if (!f) return;
    fprintf(f, "%s | https://kitao.dev/playload/app/%s\n", name, hash); fclose(f);
}
static int split(char *text, char sep, char **out, int max) {
    int n = 0;
    for (char *p = text; n < max; ) { out[n++] = p; p = strchr(p, sep); if (!p) break; *p++ = 0; }
    return n;
}
const char *h_ui(int op, const char *s1, const char *s2, int a, int b, int c, int d) {
    static char out[256], buf[8192], buf2[1024]; static char *big;
    double t = h_now() / 1000.0;
    out[0] = 0;
    snprintf(buf, sizeof buf, "%s", s1 ? s1 : ""); snprintf(buf2, sizeof buf2, "%s", s2 ? s2 : "");
    switch (op) {
    case UI_FRAME: ui_bg(t); break;
    case UI_TABS: { char *tabs[8]; int n = split(buf, '\t', tabs, 8); ui_header_tabs((const char *const *)tabs, n, a, "", t); break; }
    case UI_HEADER: ui_header(buf, buf2, t, 0); break;
    case UI_LIST: {                       /* rows "main\tside\ttone" one per line, only the visible ones; a = how many there are in all */
        static URow rows[20]; char *lines[20], *f[3]; int n = buf[0] ? split(buf, '\n', lines, UVIS < 20 ? UVIS : 20) : 0;
        for (int i = 0; i < n; i++) { int k = split(lines[i], '\t', f, 3); rows[i].main = f[0]; rows[i].side = k > 1 ? f[1] : ""; rows[i].tone = k > 2 ? atoi(f[2]) : 0; }
        ui_list(rows, n ? a : 0, b, c, d, t, buf2[0] ? buf2 : 0); break; }
    case UI_FOOTER: ui_footer_badge(buf2); ui_footer(buf); break;
    case UI_TOAST: ui_toast(buf); break;
    case UI_PANEL: ui_panel(); break;
    case UI_TEXT: ui_text(a, b, buf, c); break;
    case UI_QR: { static unsigned char m[37 * 37]; int n = qr_encode(buf, m); if (n) ui_qr(m, n, a, b, c > 0 ? c : 4); snprintf(out, sizeof out, "%d", n); break; }
    case UI_GET:
        if (!strcmp(buf, "theme")) snprintf(out, sizeof out, "%d", S.theme); else if (!strcmp(buf, "effect")) snprintf(out, sizeof out, "%d", S.effect);
        else if (!strcmp(buf, "bezel")) snprintf(out, sizeof out, "%d", S.bezel); else if (!strcmp(buf, "volume")) snprintf(out, sizeof out, "%d", S.volume);
        else if (!strcmp(buf, "overclock")) snprintf(out, sizeof out, "%d", S.overclock); else if (!strcmp(buf, "engine")) snprintf(out, sizeof out, "%s", S.engine);
        else if (!strcmp(buf, "running")) snprintf(out, sizeof out, "%s", js_engine_name());
        else if (!strcmp(buf, "autoupdate")) snprintf(out, sizeof out, "%d", S.autoupdate);
        else if (!strcmp(buf, "font")) snprintf(out, sizeof out, "%d", S.font);
        else if (!strcmp(buf, "lang")) snprintf(out, sizeof out, "%d", S.lang);
        else if (!strcmp(buf, "appversion")) snprintf(out, sizeof out, "%s", APP_VERSION);
        else if (!strcmp(buf, "newversion")) snprintf(out, sizeof out, "%s", g_new_version);
        break;
    case UI_SET:
        if (!strcmp(buf, "appupdate")) { g_appupdate = 1; return ""; }
        if (!strcmp(buf, "theme")) { S.theme = ((atoi(buf2) % ui_theme_count()) + ui_theme_count()) % ui_theme_count(); ui_set_theme(S.theme); }
        else if (!strcmp(buf, "effect")) S.effect = !!atoi(buf2); else if (!strcmp(buf, "bezel")) S.bezel = !!atoi(buf2);
        else if (!strcmp(buf, "volume")) { S.volume = atoi(buf2); if (S.volume < 25) S.volume = 25; if (S.volume > 400) S.volume = 400; }
        else if (!strcmp(buf, "overclock")) S.overclock = atoi(buf2); else if (!strcmp(buf, "autoupdate")) S.autoupdate = !!atoi(buf2); else if (!strcmp(buf, "font")) { S.font = !!atoi(buf2); ui_font = S.lang ? 0 : S.font; } else if (!strcmp(buf, "lang")) { S.lang = !!atoi(buf2); ui_font = S.lang ? 0 : S.font; srv_lang(S.lang); } else if (!strcmp(buf, "engine")) snprintf(S.engine, sizeof S.engine, "%s", strcmp(buf2, "small") ? "jit" : "small");
        settings_save(); break;
    case UI_ROWS: snprintf(out, sizeof out, "%d", UVIS); break;
    case UI_THEMES: { size_t k = 0; for (int i = 0; i < ui_theme_count() && k < sizeof out - 24; i++) k += (size_t)snprintf(out + k, sizeof out - k, "%s%s", i ? "\t" : "", ui_theme_name(i)); break; }
    case UI_FAVS: free(big); big = read_file(g_dir, "favorites.txt", 0); return big ? big : "";
    case UI_FAV: fav_set(buf, buf2, a); break;
    case UI_FORGET: list_remove("mygames.txt", buf); break;
    case UI_MENU: { char *items[10]; int n = split(buf2, '\t', items, 10); ui_menu(buf, (const char *const *)items, n, a, t); break; }
    }
    return out;
}
static void picture_init(void) {
    settings_load();
    if (S.lang < 0) {                       /* never chosen: follow the Miyoo's own language if we can tell (a guess at where Onion keeps it) */
        char *sys = read_file(0, "/appconfigs/system.json", 0); const char *l = sys ? strstr(sys, "\"language\"") : 0;
        if (l) { char win[48]; snprintf(win, sizeof win, "%s", l + 10); S.lang = strstr(win, "\"ja") != 0; } else S.lang = 0;
        free(sys);
    }
    ui_init(g_frame, W, H); ui_set_theme(S.theme); ui_font = S.lang ? 0 : S.font; srv_lang(S.lang);   /* Japanese is written in Playload's own letters: they have the kana */
    effect_build();
}

/* ---- looking for new Arcade games by itself: a curl in the background, started once when the app opens ---- */
static int g_check_pid = -1;
static void appcheck_begin(void);
static void check_begin(void) {
    if (!S.autoupdate) return;
    g_check_pid = net_update_begin(g_dir, 0);
    if (g_check_pid > 0) say("update: looking for new Arcade games in the background");
    appcheck_begin();
}
/* 1 = the list changed and g_error holds a note for the list to show; 0 = nothing to do (yet) */
static int check_poll(void) {
    if (g_check_pid <= 0) return 0;
    int status = 0; pid_t r = waitpid(g_check_pid, &status, WNOHANG);
    if (r == 0) return 0;
    g_check_pid = -1;
    if (r < 0) return 0;
    char msg[200]; int added = 0, changed = 0, bundled = 0;
    for (const char *p = g_games_json; (p = strstr(p, "\"tab\":0")); p += 7) bundled++;
    int e = net_update_end(g_dir, WIFEXITED(status) ? status : 1 << 8, bundled, msg, sizeof msg, &added, &changed);
    say("update: background check %s: %s%s", e ? "failed" : "done", msg, e ? "" : changed ? " games, list changed" : " games, nothing new");
    if (e || !changed) return 0;
    if (added == 1) snprintf(g_error, sizeof g_error, "1 new game in the Arcade"); else if (added > 1) snprintf(g_error, sizeof g_error, "%d new games in the Arcade", added);
    else snprintf(g_error, sizeof g_error, "Arcade list updated");
    return 1;
}
/* show the list again with a short note (a toast, not a message screen) */
static int menu_with_note(void) {
    snprintf(g_head, sizeof g_head, "NOTE");
    int r = prog_start(g_menu_src, 1);
    g_error[0] = 0; snprintf(g_head, sizeof g_head, "GAME STOPPED");
    return r;
}


/* ---------------- updating the app itself ----------------
   update.txt on GitHub (main branch) names the newest version and, for every file of the app, its CRC-32 and size,
   plus the address of one fixed commit to take them from:
       playload-miyoo-update 1
       version 1.2
       base https://raw.githubusercontent.com/mroxfordyazuka/Playload-Miyoo/<commit>/App/Playload/
       file 1a2b3c4d 903312 playload
   The files that differ are downloaded to update/files/, checked, and only then is update/ready written and the app
   leaves with exit code 42: launch.sh moves them into place (the running program cannot replace itself) and starts
   the app again. Games, favorites and settings are never in the list. */
#define UPDATE_URL "https://raw.githubusercontent.com/mroxfordyazuka/Playload-Miyoo/main/update.txt"
#define UPDATE_BASE "https://raw.githubusercontent.com/mroxfordyazuka/Playload-Miyoo/"
typedef struct { unsigned crc; long size; char path[160]; } UFile;
static const char *update_url(void) { const char *u = getenv("PL_UPDATE_URL"); return u && u[0] ? u : UPDATE_URL; }   /* PL_UPDATE_URL: for testing */
/* this app's version. For trying the updater out: a file update/pretend-version holding an older number makes the
   app believe it is that old, so it offers the real update again. */
static const char *my_version(void) {
    static char v[24];
    char *t = read_file(g_dir, "update/pretend-version", 0);
    snprintf(v, sizeof v, "%s", APP_VERSION);
    if (t && t[0] >= '0' && t[0] <= '9') { snprintf(v, sizeof v, "%.15s", t); v[strcspn(v, " \r\n")] = 0; }
    free(t);
    return v;
}
static int ver_cmp(const char *a, const char *b) {
    for (int i = 0; i < 4; i++) {
        long x = strtol(a, (char **)&a, 10), y = strtol(b, (char **)&b, 10);
        if (x != y) return x < y ? -1 : 1;
        if (*a == '.') a++;
        if (*b == '.') b++;
    }
    return 0;
}
static unsigned crc32_file(const char *path, long *size) {
    static unsigned T[256];
    if (!T[1]) for (unsigned i = 0; i < 256; i++) { unsigned c = i; for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1; T[i] = c; }
    FILE *f = fopen(path, "rb"); if (size) *size = -1;
    if (!f) return 0;
    unsigned c = 0xffffffffu; long n = 0; static unsigned char buf[65536]; size_t k;
    while ((k = fread(buf, 1, sizeof buf, f)) > 0) { for (size_t i = 0; i < k; i++) c = T[(c ^ buf[i]) & 255] ^ (c >> 8); n += (long)k; }
    fclose(f);
    if (size) *size = n;
    return c ^ 0xffffffffu;
}
static int path_ok(const char *p) {
    if (!p[0] || p[0] == '/' || strstr(p, "..")) return 0;
    for (; *p; p++) if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '.' || *p == '_' || *p == '-' || *p == '/')) return 0;
    return 1;
}
/* read update/<name>. 0 = fine: version, base and the files (malloc'd, *n of them). -1 = not a list we trust */
static int manifest_load(const char *name, char *version, size_t vcap, char *base, size_t bcap, UFile **files, int *n) {
    char rel[64]; snprintf(rel, sizeof rel, "update/%s", name);
    char *t = read_file(g_dir, rel, 0); if (!t) return -1;
    int ok = !strncmp(t, "playload-miyoo-update 1\n", 24), count = 0, cap = 0; UFile *list = 0;
    version[0] = base[0] = 0;
    for (char *line = t; ok && line && *line;) {
        char *end = strchr(line, '\n'); if (end) *end = 0;
        size_t L = strlen(line); if (L && line[L - 1] == '\r') line[L - 1] = 0;
        if (!strncmp(line, "version ", 8)) snprintf(version, vcap, "%s", line + 8);
        else if (!strncmp(line, "base ", 5)) snprintf(base, bcap, "%s", line + 5);
        else if (!strncmp(line, "file ", 5)) {
            UFile f; memset(&f, 0, sizeof f);
            if (sscanf(line + 5, "%x %ld %159s", &f.crc, &f.size, f.path) != 3 || !path_ok(f.path) || f.size < 0 || f.size > 200L * 1024 * 1024) ok = 0;
            else { if (count == cap) { cap = cap ? cap * 2 : 32; list = realloc(list, (size_t)cap * sizeof *list); } list[count++] = f; }
        }
        line = end ? end + 1 : 0;
    }
    free(t);
    /* only our own repository, unless a test address was given */
    int ours = !strncmp(base, UPDATE_BASE, strlen(UPDATE_BASE)) || (getenv("PL_UPDATE_URL") && getenv("PL_UPDATE_URL")[0]);
    for (const char *p = base; *p; p++) if (*p == '\'' || *p == '\\' || (unsigned char)*p < 33) ok = 0;
    if (!ok || !version[0] || strlen(version) > 15 || !ours || !count || base[strlen(base) - 1] != '/') { free(list); return -1; }
    if (files) { *files = list; *n = count; } else free(list);
    return 0;
}
/* what the last look found: sets g_new_version if update/manifest.txt names a newer version than this one */
static void newer_known(void) {
    char v[24], base[400]; g_new_version[0] = 0;
    if (manifest_load("manifest.txt", v, sizeof v, base, sizeof base, 0, 0) == 0 && ver_cmp(v, my_version()) > 0) snprintf(g_new_version, sizeof g_new_version, "%s", v);
}
static void update_dir(const char *sub, char *out, size_t cap) {
    snprintf(out, cap, "%s/update", g_dir); mkdir(out, 0755);
    if (sub) { snprintf(out, cap, "%s/update/%s", g_dir, sub); }
}
/* a look in the background when the app opens */
static int g_app_pid = -1;
static void appcheck_begin(void) {
    if (!S.autoupdate) return;
    char out[700]; update_dir("manifest.new", out, sizeof out);
    g_app_pid = net_get_begin(g_dir, update_url(), out, 0);
}
/* 1 = a newer version is out and g_error holds a note for the list to show */
static int appcheck_poll(void) {
    if (g_app_pid <= 0) return 0;
    int status = 0; pid_t r = waitpid(g_app_pid, &status, WNOHANG);
    if (r == 0) return 0;
    g_app_pid = -1;
    char neu[700], cur[700], v[24], base[400]; update_dir("manifest.new", neu, sizeof neu); update_dir("manifest.txt", cur, sizeof cur);
    if (r < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) { unlink(neu); say("app update: check failed: %s", net_why(status)); return 0; }
    if (manifest_load("manifest.new", v, sizeof v, base, sizeof base, 0, 0) != 0) { unlink(neu); say("app update: the list did not look right"); return 0; }
    rename(neu, cur); newer_known();
    say("app update: this is %s, newest is %s", my_version(), v);
    /* offer each new version once, full screen (update/offered remembers which); after that it waits in Settings */
    char *off = read_file(g_dir, "update/offered", 0); char was[24] = "";
    if (off) { snprintf(was, sizeof was, "%.15s", off); was[strcspn(was, " \r\n")] = 0; free(off); }
    if (g_new_version[0] && strcmp(was, g_new_version)) g_offer = 1;
    return 0;
}
/* the offer is on screen now: do not bring it up by itself again for this version */
static void offer_shown(void) {
    char path[700]; update_dir("offered", path, sizeof path);
    FILE *f = fopen(path, "w"); if (f) { fprintf(f, "%s\n", g_new_version); fclose(f); }
}

#define TJ(en, ja) (S.lang == 1 ? (ja) : (en))
/* one of the updater's own screens: a heading, up to four lines, the buttons */
static void up_screen(const char *head, const char *l1, const char *l2, const char *l3, const char *l4, const char *hints, void (*show)(void)) {
    double t = h_now() / 1000.0;
    ui_bg(t); ui_header(head, "v" APP_VERSION, t, 0); ui_panel();
    const char *L[4] = { l1, l2, l3, l4 };
    for (int i = 0; i < 4; i++) if (L[i] && L[i][0]) ui_text(-1, 76 + i * 22, L[i], i == 0 ? 5 : 0);
    ui_footer(hints);
    if (show) show();
}
/* wait for A (1) or B (0), keeping the screen alive. keys() returns 16 for A, 32 for B, 0 for nothing; -1 = quit */
static int up_wait(const char *head, const char *l1, const char *l2, const char *l3, const char *l4, const char *hints, void (*show)(void), int (*keys)(void)) {
    for (;;) {
        up_screen(head, l1, l2, l3, l4, hints, show);
        int k = keys ? keys() : 16;
        if (k < 0 || k & 32) return 0;
        if (k & 16) return 1;
        usleep(30000);
    }
}
/* run a download, drawing while it goes. 0 = done, 1 = B pressed, else a wait() status */
static int up_fetch(const char *url, const char *out, int big, const char *head, const char *l1, const char *l2, long have, long total, void (*show)(void), int (*keys)(void)) {
    int pid = net_get_begin(g_dir, url, out, big);
    if (pid <= 0) return 127 << 8;
    for (;;) {
        int status = 0; pid_t r = waitpid(pid, &status, WNOHANG);
        if (r != 0) return r < 0 ? 1 << 8 : status;
        char l3[80] = "", l4[80] = "";
        if (total > 0) {
            struct stat st; long got = have + (stat(out, &st) == 0 ? (long)st.st_size : 0);
            int pct = (int)(got * 100.0 / total); if (pct > 100) pct = 100;
            int bars = pct * 24 / 100; char bar[32]; for (int i = 0; i < 24; i++) bar[i] = i < bars ? '#' : '.'; bar[24] = 0;
            snprintf(l3, sizeof l3, "%s", bar);
            snprintf(l4, sizeof l4, "%d%%   %.1f / %.1f MB", pct, got / 1048576.0, total / 1048576.0);
        }
        up_screen(head, l1, l2, l3, l4, big ? TJ("B:Cancel", "B:やめる") : "", show);
        int k = keys ? keys() : 0;
        if (k < 0 || k & 32) { kill(pid, SIGTERM); waitpid(pid, &status, 0); return 1; }
        usleep(big ? 200000 : 60000);
    }
}
/* Settings > Update Playload. returns 42 when an update is ready and the app must leave for launch.sh to put it in
   place; 0 otherwise (g_error / g_head then hold what to tell the user, if anything) */
static int app_update(void (*show)(void), int (*keys)(void)) {
    const char *head = TJ("UPDATE", "こうしん");
    char neu[700], cur[700], v[24], base[400], l[4][96];
    UFile *files = 0; int n = 0;
    g_appupdate = 0; g_error[0] = 0;
    snprintf(g_head, sizeof g_head, "UPDATE");
    const char *verify = getenv("VERIFY");
    if (verify && !strcmp(verify, "0")) { snprintf(g_error, sizeof g_error, "The Miyoo's date is wrong, so the download cannot be checked. Set the date, then try again."); return 0; }
    update_dir("manifest.new", neu, sizeof neu); update_dir("manifest.txt", cur, sizeof cur);
    int st, offered = g_from_offer; g_from_offer = 0;
    if (offered) {                           /* the look in the background has just fetched the list */
        if (manifest_load("manifest.txt", v, sizeof v, base, sizeof base, &files, &n) != 0) return 0;
    } else {
        say("app update: looking at %s", update_url());
        st = up_fetch(update_url(), neu, 0, head, TJ("Looking for a new version...", "あたらしい バージョンを さがしています..."), "", 0, 0, show, keys);
        if (st == 1) { unlink(neu); return 0; }
        if (st != 0) { unlink(neu); snprintf(g_error, sizeof g_error, "%s", net_why(st)); say("app update: %s", g_error); return 0; }
        if (manifest_load("manifest.new", v, sizeof v, base, sizeof base, &files, &n) != 0) { unlink(neu); snprintf(g_error, sizeof g_error, "That did not look like an update list."); return 0; }
        rename(neu, cur); newer_known();
    }
    if (ver_cmp(v, my_version()) <= 0) { free(files); snprintf(g_error, sizeof g_error, "Playload %s is up to date.", my_version()); snprintf(g_head, sizeof g_head, "UP TO DATE"); return 0; }
    /* which files differ from what is on the card? (reading them all takes a few seconds) */
    snprintf(l[0], sizeof l[0], TJ("Playload %s is out", "Playload %s が でました"), v);
    up_screen(head, l[0], TJ("One moment...", "おまちください..."), "", "", "", show);
    long total = 0; int need = 0; char path[900];
    for (int i = 0; i < n; i++) {
        long size; snprintf(path, sizeof path, "%s/%s", g_dir, files[i].path);
        unsigned c = crc32_file(path, &size);
        if (size == files[i].size && c == files[i].crc) files[i].size = -1;      /* have it already */
        else { total += files[i].size; need++; }
    }
    say("app update: %s -> %s, %d files, %ld bytes", my_version(), v, need, total);
    struct statvfs fs;
    if (statvfs(g_dir, &fs) == 0 && (double)fs.f_bavail * fs.f_frsize < total + 8.0 * 1048576) {
        free(files); snprintf(g_error, sizeof g_error, "Not enough room on the card: the update needs %.0f MB free.", total / 1048576.0 + 8); return 0;
    }
    snprintf(l[0], sizeof l[0], TJ("Playload %s is out", "Playload %s が でました"), v);
    snprintf(l[1], sizeof l[1], TJ("You have %s.", "いまは %s です"), my_version());
    snprintf(l[2], sizeof l[2], TJ("Download: %.1f MB over Wi-Fi", "ダウンロード: %.1f MB (Wi-Fi)"), total / 1048576.0);
    snprintf(l[3], sizeof l[3], "%s", TJ("Your games and settings stay.", "ゲームと せっていは そのまま"));
    if (offered) offer_shown();
    if (!up_wait(head, l[0], l[1], l[2], l[3], TJ("A:Update  B:Not now", "A:こうしん  B:あとで"), show, keys)) {
        free(files);
        if (offered) snprintf(g_error, sizeof g_error, "Later: Settings > Update Playload");     /* a short note back in the list */
        return 0;
    }
    /* fetch them one by one into update/files, then check every one */
    long have = 0; char url[700], out[900], dir[900];
    update_dir("files", dir, sizeof dir);
    {   /* files left from a download of some other version must not get mixed in: start clean then */
        char was[24] = "", mark[900]; update_dir("for", mark, sizeof mark);
        FILE *m = fopen(mark, "r"); if (m) { if (!fgets(was, sizeof was, m)) was[0] = 0; fclose(m); was[strcspn(was, "\r\n")] = 0; }
        if (strcmp(was, v)) {
            pid_t rm = fork();
            if (rm == 0) { execl("/bin/rm", "rm", "-rf", dir, (char *)0); _exit(127); }
            if (rm > 0) waitpid(rm, 0, 0);
            snprintf(out, sizeof out, "%s/update/ready", g_dir); unlink(out);
            m = fopen(mark, "w"); if (m) { fprintf(m, "%s\n", v); fclose(m); }
        }
    }
    mkdir(dir, 0755);
    for (int i = 0; i < n; i++) {
        if (files[i].size < 0) continue;
        snprintf(out, sizeof out, "%s/%s", dir, files[i].path);
        for (char *p = out + strlen(dir) + 1; (p = strchr(p, '/')); p++) { *p = 0; mkdir(out, 0755); *p = '/'; }
        long size; unsigned c = crc32_file(out, &size);
        if (!(size == files[i].size && c == files[i].crc)) {                   /* not here from an earlier try */
            if (size > files[i].size) unlink(out);
            snprintf(url, sizeof url, "%s%s", base, files[i].path);
            snprintf(l[0], sizeof l[0], TJ("Downloading Playload %s", "Playload %s を ダウンロードちゅう"), v);
            snprintf(l[1], sizeof l[1], "%.60s", files[i].path);
            st = up_fetch(url, out, 1, head, l[0], l[1], have, total, show, keys);
            if (st == 1) { free(files); say("app update: cancelled"); return 0; }
            c = crc32_file(out, &size);
            if (st != 0 || size != files[i].size || c != files[i].crc) {
                say("app update: %s failed (curl %d, %ld bytes, crc %08x, wanted %ld, %08x)", files[i].path, st >> 8, size, c, files[i].size, files[i].crc);
                if (st == 0 || size > files[i].size) unlink(out);               /* a wrong file: start it over next time */
                snprintf(g_error, sizeof g_error, "%s", st != 0 ? net_why(st) : "A downloaded file was damaged. Try again.");
                free(files); return 0;
            }
        }
        have += files[i].size;
    }
    free(files);
    snprintf(out, sizeof out, "%s/update/ready", g_dir);
    FILE *f = fopen(out, "w"); if (!f) { snprintf(g_error, sizeof g_error, "Could not write to the card."); return 0; }
    fprintf(f, "%s\n", v); fclose(f); sync();
    say("app update: %s is downloaded and checked; leaving so launch.sh can put it in place", v);
    snprintf(l[0], sizeof l[0], TJ("Playload %s is ready", "Playload %s の じゅんびが できました"), v);
    up_screen(head, l[0], TJ("Restarting...", "さいきどう します..."), "", "", "", show);
    usleep(900000);
    return 42;
}

/* ---------------- the pause menu (START in a game) ---------------- */
enum { PA_RESUME, PA_FAV, PA_DEV, PA_LIST };
static int g_psel, g_pids[4];
static int pause_items(const char **items) {
    int n = 0;
    const int ja = S.lang == 1;
    items[n] = ja ? "\xe3\x81\xa4\xe3\x81\xa5\xe3\x81\x91\xe3\x82\x8b" : "Resume"; g_pids[n++] = PA_RESUME;
    if (g_cur_hash) { items[n] = list_has("favorites.txt", g_cur_hash) ? (ja ? "\xe2\x99\xa5\x20\xe3\x81\x8a\xe3\x81\x8d\xe3\x81\xab\xe3\x81\x84\xe3\x82\x8a\xe3\x81\x8b\xe3\x82\x89\x20\xe3\x81\xaf\xe3\x81\x9a\xe3\x81\x99" : "\xE2\x99\xA5 Remove from favorites") : (ja ? "\xe2\x99\xa1\x20\xe3\x81\x8a\xe3\x81\x8d\xe3\x81\xab\xe3\x81\x84\xe3\x82\x8a\xe3\x81\xab\x20\xe3\x81\xa4\xe3\x81\x84\xe3\x81\x8b" : "\xE2\x99\xA1 Add to favorites"); g_pids[n++] = PA_FAV; }
    if (g_cur_src) { items[n] = ja ? "\xe3\x81\x8b\xe3\x81\x84\xe3\x81\xaf\xe3\x81\xa4\xe3\x81\xa7\x20\xe3\x81\xb2\xe3\x82\x89\xe3\x81\x8f" : "Open in Dev"; g_pids[n++] = PA_DEV; }
    items[n] = ja ? "\xe3\x83\xaa\xe3\x82\xb9\xe3\x83\x88\xe3\x81\xab\x20\xe3\x82\x82\xe3\x81\xa9\xe3\x82\x8b" : "Back to the list"; g_pids[n++] = PA_LIST;
    return n;
}
static void pause_draw(void) {
    const char *items[4]; int n = pause_items(items);
    if (g_psel >= n) g_psel = n - 1;
    ui_menu(S.lang == 1 ? "\xe3\x83\x9d\xe3\x83\xbc\xe3\x82\xba" : "Paused", items, n, g_psel, h_now() / 1000.0);
}
/* buttons that went down this frame, while paused. returns 0 = still paused, 1 = resume, 2 = go to the list */
static int pause_key(int edge) {
    const char *items[4]; int n = pause_items(items);
    if (edge & 1) g_psel = (g_psel + n - 1) % n;
    if (edge & 2) g_psel = (g_psel + 1) % n;
    if (edge & 32) return 1;
    if (!(edge & 16)) return 0;
    switch (g_pids[g_psel < n ? g_psel : 0]) {
    case PA_RESUME: return 1;
    case PA_FAV: fav_set(g_cur_hash, g_title, !list_has("favorites.txt", g_cur_hash)); return 0;
    case PA_DEV:                     /* this game's code goes to the editor; the list comes back on its Dev screen */
        if (srv_start() == 0) { srv_dev(1); srv_code(g_cur_src); say("dev: \"%s\" handed to the editor", g_title); }
        else { snprintf(g_error, sizeof g_error, "No Wi-Fi address. Turn Wi-Fi on in the Miyoo's settings, then try again."); snprintf(g_head, sizeof g_head, "DEV PANEL"); g_keep_error = 1; }
        return 2;
    default: return 2;
    }
}

#ifdef HOST
/* ---------------- desktop test build: no screen, no sound device ---------------- */
static char *game_arg(const char *path) {
    char *text = read_file(0, path, 0); if (!text) { say("can't read %s", path); exit(2); }
    return text;
}
static int start_any(const char *what) {
    if (!strcmp(what, "menu")) return start_menu();
    char *text = game_arg(what); int e;
    char *h = strstr(text, "#v1."); if (!h) h = strstr(text, "#1.");
    if (h && h - text < 200) { h[strcspn(h, " \r\n\t")] = 0; const char *why = 0; char *src = payload_decode(h, 0, &why); if (!src) { say("decode: %s", why); exit(2); } e = prog_start(src, 0); g_cur_src = src; g_cur_hash = strdup(h); snprintf(g_title, sizeof g_title, "Test game"); }
    else { e = prog_start(text, 0); g_cur_src = strdup(text); }
    free(text);
    return e;
}
/* the same made-up button presses the reference harness (test/ref.mjs) uses */
static int auto_mask(int frame) {
    unsigned s = (unsigned)(frame / 12) * 2654435761u; s ^= s >> 15;
    int mask = (int)(s & 63);
    if ((frame / 12) % 3 == 0) mask &= 48;
    if (frame < 30) mask = 0;
    if (frame >= 30 && frame < 36) mask = 16;
    return mask;
}
static void write_ppm(const char *path) {
    FILE *f = fopen(path, "wb"); if (!f) return;
    fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (int i = 0; i < W * H; i++) { uint8_t c[3] = { (uint8_t)(g_frame[i] >> 16), (uint8_t)(g_frame[i] >> 8), (uint8_t)g_frame[i] }; fwrite(c, 1, 3, f); }
    fclose(f);
}
int main(int argc, char **argv) {
    if (argc < 4) { say("usage: see the top of pl.c"); return 2; }
    snprintf(g_dir, sizeof g_dir, "%s", argv[1]);
    g_t0 = now_ms(); g_fixed_random = 1;
    if (load_app()) return 1;
    { const char *ov = getenv("PL_RES"), *x = ov ? strchr(ov, 'x') : 0; if (x) screen_size(atoi(ov), atoi(x + 1)); }
    picture_init();
    ay_init(44100);
    const char *cmd = argv[2];
    newer_known();
    if (!strcmp(cmd, "update")) {            /* playload <app> update <ppm|-> : run the app updater, saying yes to its question */
        int r = app_update(0, 0);
        say("update: returned %d, head \"%s\", message \"%s\"", r, g_head, g_error);
        if (strcmp(argv[3], "-")) write_ppm(argv[3]);
        return r == 42 ? 0 : 3;
    }
    if (!strcmp(cmd, "check")) {             /* the background look, waited for */
        S.autoupdate = 1; appcheck_begin();
        for (int i = 0; i < 400 && g_app_pid > 0; i++) { if (appcheck_poll()) break; usleep(20000); }
        say("check: newer \"%s\", offer %d", g_new_version, g_offer);
        if (g_offer && argc > 4 && !strcmp(argv[4], "offer")) { g_offer = 0; g_from_offer = 1; int r = app_update(0, 0); say("offer: returned %d", r); return r == 42 ? 0 : 3; }
    }
    if (getenv("PL_NOTE") && !strcmp(argv[3], "menu")) { snprintf(g_error, sizeof g_error, "%s", getenv("PL_NOTE")); if (menu_with_note()) return 1; }
    else if (start_any(argv[3])) { say("START FAILED: %s", g_error); return 1; }
    int frames = argc > 4 ? atoi(argv[4]) : 60;
    if (!strcmp(cmd, "shot")) {
        const char *keys = argc > 6 ? argv[6] : "";   /* one letter per 8 frames: u d l r a b L R x y . and p = START */
        int hp = 0;
        for (int f = 0; f < frames; f++) {
            char k = (size_t)(f / 8) < strlen(keys) && f % 8 < 4 ? keys[f / 8] : '.';
            int m = k == 'u' ? 1 : k == 'd' ? 2 : k == 'l' ? 4 : k == 'r' ? 8 : k == 'a' ? 16 : k == 'b' ? 32 : 0;
            g_raw = m | (k == 'L' ? 64 : 0) | (k == 'R' ? 128 : 0) | (k == 'x' ? 256 : 0) | (k == 'y' ? 512 : 0);
            if (k == 'p' && f % 8 == 0) { hp = !hp; g_psel = 0; }
            if (hp) {
                int r = f % 8 == 0 ? pause_key(m) : 0;
                if (r == 1) hp = 0;
                if (r == 2) { hp = 0; if (!g_keep_error) g_error[0] = 0; g_keep_error = 0; if (start_menu()) return 1; }
                if (hp) continue;
            }
            srv_poll(g_dir);
            if (k == 'w') usleep(200000);
            if (!keys[0] && !P.wide) m = auto_mask(f);
            if (prog_frame(m) < 0) {
                if (!srv_is_dev()) { say("FAILED at frame %d: %s", f, g_error); return 1; }
                srv_status("error", g_error, 0); if (start_menu()) return 1;      /* as on the device */
            }
            if (g_launch) { char *h = g_launch; g_launch = 0; if (start_game(h)) { say("launch failed: %s", g_error); } free(h); }
            if (g_update && run_update()) return 1;
            dev_take();
        }
        if (!P.wide) { if (prog_pixels() < 0) return 1; g_backdrop = 1; compose_game(hp || (argc > 7 && !strcmp(argv[7], "paused"))); }
        write_ppm(argv[5]);
    } else if (!strcmp(cmd, "hash")) {
        uint32_t h = 2166136261u;
        for (int f = 0; f < frames; f++) {
            if (prog_frame(auto_mask(f)) < 0) { printf("frame %d ERROR %s\n", f, g_error); return 0; }
            if (prog_pixels() < 0) { printf("frame %d ERROR %s\n", f, g_error); return 0; }
            for (int i = 0; i < 160 * 144; i++) { h ^= g_px[i]; h *= 16777619u; }
            if (f % 60 == 59 || f == frames - 1) printf("frame %d %08x\n", f, h);
        }
    } else if (!strcmp(cmd, "bench")) {
        double t_step = 0, t_draw = 0, worst = 0;
        for (int f = 0; f < frames; f++) {
            double a = now_ms(); if (prog_frame(auto_mask(f)) < 0) { say("FAILED at %d: %s", f, g_error); return 1; }
            double b = now_ms(); if (prog_pixels() < 0) return 1;
            double c = now_ms(); t_step += b - a; t_draw += c - b; if (c - a > worst) worst = c - a;
        }
        printf("tick %.3f ms  draw %.3f ms  worst frame %.3f ms\n", t_step / frames, t_draw / frames, worst);
    } else if (!strcmp(cmd, "wav")) {
        FILE *f = fopen(argv[5], "wb"); int n = 44100 / 60; int16_t buf[735]; uint32_t bytes = (uint32_t)frames * (uint32_t)n * 2;
        uint32_t hdr[11] = { 0x46464952, 36 + bytes, 0x45564157, 0x20746d66, 16, 0x00010001, 44100, 88200, 0x00100002, 0x61746164, bytes };
        fwrite(hdr, 4, 11, f);
        for (int i = 0; i < frames; i++) { if (prog_frame(auto_mask(i)) < 0) break; ay_render(buf, n); fwrite(buf, 2, (size_t)n, f); }
        fclose(f);
    }
    prog_free();
    return 0;
}
#else
/* ---------------- the Miyoo: SDL 1.2 screen, buttons, sound ---------------- */
#define K_UP SDLK_UP
#define K_DOWN SDLK_DOWN
#define K_LEFT SDLK_LEFT
#define K_RIGHT SDLK_RIGHT
#define K_A SDLK_SPACE
#define K_B SDLK_LCTRL
#define K_X SDLK_LSHIFT
#define K_Y SDLK_LALT
#define K_L1 SDLK_e
#define K_R1 SDLK_t
#define K_L2 SDLK_TAB
#define K_R2 SDLK_BACKSPACE
#define K_START SDLK_RETURN
#define K_SELECT SDLK_RCTRL
#define K_MENU SDLK_ESCAPE

static SDL_Surface *scr; static int flip = 1;
/* g_frame -> the screen (upside down if the panel is mounted that way) */
static void present(int whole) {
    int bpp = scr->format->BytesPerPixel; SDL_PixelFormat *f = scr->format;
    if (scr->w < W || scr->h < H || (bpp != 4 && bpp != 2)) return;
    SDL_LockSurface(scr);
    uint8_t *base = (uint8_t *)scr->pixels; int pitch = scr->pitch;
    int std = bpp == 4 && f->Rshift == 16 && f->Gshift == 8 && f->Bshift == 0;
    int y0 = whole ? 0 : GY, y1 = whole ? H : GY + GH, x0 = whole ? 0 : GX, x1 = whole ? W : GX + GW;      /* a game only changes its own window */
    for (int y = y0; y < y1; y++) {
        const uint32_t *s = g_frame + y * W; uint8_t *row = base + (flip ? H - 1 - y : y) * pitch;
        if (std && !flip) memcpy(row + x0 * 4, s + x0, (size_t)(x1 - x0) * 4);
        else if (std) { uint32_t *d = (uint32_t *)row + (W - 1); for (int x = x0; x < x1; x++) d[-x] = s[x]; }
        else if (bpp == 4) { uint32_t *d = (uint32_t *)row; for (int x = 0; x < W; x++) { uint32_t v = s[x]; d[flip ? W - 1 - x : x] = (((v >> 16) & 255) << f->Rshift) | (((v >> 8) & 255) << f->Gshift) | ((v & 255) << f->Bshift); } }
        else { uint16_t *d = (uint16_t *)row; for (int x = 0; x < W; x++) { uint32_t v = s[x]; d[flip ? W - 1 - x : x] = (uint16_t)(((v >> 19) & 31) << 11 | ((v >> 10) & 63) << 5 | ((v >> 3) & 31)); } }
    }
    SDL_UnlockSurface(scr);
    SDL_Flip(scr);
}
static void present_all(void) { present(1); }
/* buttons for the updater's own screens: 16 = A went down, 32 = B, -1 = MENU or the app is told to quit */
static int update_keys(void) {
    SDL_Event ev; int k = 0;
    while (SDL_PollEvent(&ev)) {
        if (ev.type == SDL_QUIT) return -1;
        if (ev.type != SDL_KEYDOWN) continue;
        if (ev.key.keysym.sym == K_A) k |= 16;
        if (ev.key.keysym.sym == K_B || ev.key.keysym.sym == K_MENU) k |= 32;
    }
    return k;
}

static int g_ch = 2;
static void audio_cb(void *ud, Uint8 *stream, int len) {
    (void)ud; static int16_t mono[4096];
    int16_t *o = (int16_t *)stream; int frames = len / (2 * g_ch);
    while (frames > 0) {
        int n = frames > 4096 ? 4096 : frames;
        ay_render(mono, n);
        for (int i = 0; i < n; i++) {
            int v = mono[i] * S.volume / 100; v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;   /* three voices at full volume peak at 60% */
            *o++ = (int16_t)v; if (g_ch == 2) *o++ = (int16_t)v;
        }
        frames -= n;
    }
}
static void audio_open(void) {
    SDL_AudioSpec want, got; memset(&want, 0, sizeof want); memset(&got, 0, sizeof got);
    want.freq = 44100; want.format = AUDIO_S16SYS; want.channels = 2; want.samples = 512; want.callback = audio_cb;
    if (SDL_InitSubSystem(SDL_INIT_AUDIO) < 0 || SDL_OpenAudio(&want, &got) < 0) { say("no sound: SDL_OpenAudio failed"); return; }
    say("sound: %d Hz, %d channels, format 0x%x, buffer %d", got.freq, got.channels, got.format, got.samples);
    if (got.format != AUDIO_S16SYS || got.channels < 1 || got.channels > 2 || got.freq < 8000) { SDL_CloseAudio(); say("no sound: a format this app doesn't mix"); return; }
    g_ch = got.channels; ay_init(got.freq);
    g_audio_on = 1; SDL_PauseAudio(0);
}

static void load_state(void) {
    char *s = read_file(g_dir, "state.txt", 0); if (!s) return;
    int t = 0, n = 0; if (sscanf(s, "%d %d", &t, &n) >= 2) { g_tab = t < 0 || t > 4 ? 0 : t; g_sel = n < 0 ? 0 : n; }
    free(s);
}
static void save_state(void) {
    char path[700]; snprintf(path, sizeof path, "%s/state.txt", g_dir);
    FILE *f = fopen(path, "w"); if (!f) return;
    fprintf(f, "%d %d\n", g_tab, g_sel); fclose(f);
}

int main(int argc, char **argv) {
    snprintf(g_dir, sizeof g_dir, "%s", argc > 1 ? argv[1] : ".");
    if (argc > 2) flip = atoi(argv[2]);
    g_t0 = now_ms();
    if (load_app()) return 1;
    load_state();
    {   /* how big is the screen? ask the framebuffer (640x480, or 752x560 on a Mini v4 / Flip with "full_resolution") */
        int fd = open("/dev/fb0", O_RDONLY);
        if (fd >= 0) {
            unsigned v[40]; memset(v, 0, sizeof v);
            if (ioctl(fd, FBIOGET_VSCREENINFO, v) == 0 && v[0] >= 640 && v[0] <= WMAX && v[1] >= 480 && v[1] <= HMAX) screen_size((int)v[0] & ~1, (int)v[1] & ~1);
            close(fd);
        }
        const char *ov = getenv("PL_RES"), *x = ov ? strchr(ov, 'x') : 0;      /* e.g. PL_RES=752x560, for testing */
        if (x && atoi(ov) >= 640 && atoi(ov) <= WMAX && atoi(x + 1) >= 480 && atoi(x + 1) <= HMAX) screen_size(atoi(ov) & ~1, atoi(x + 1) & ~1);
    }
    picture_init();
    if (SDL_Init(SDL_INIT_VIDEO) < 0) { say("SDL_Init failed"); return 1; }
    scr = SDL_SetVideoMode(W, H, 32, SDL_SWSURFACE);
    if (!scr && (W != 640 || H != 480)) { screen_size(640, 480); ui_init(g_frame, W, H); scr = SDL_SetVideoMode(W, H, 32, SDL_SWSURFACE); }
    if (!scr) { say("SDL_SetVideoMode failed"); SDL_Quit(); return 1; }
    SDL_ShowCursor(0); SDL_EnableKeyRepeat(0, 0);
    say("screen: %d x %d, %d bits, pitch %d", scr->w, scr->h, scr->format->BitsPerPixel, scr->pitch);
    say("JavaScript engine: %s", js_engine_name());
    ay_init(44100);
    audio_open();
    double t_boot = now_ms();
    if (start_menu()) { say("the game list failed to start: %s", g_error); SDL_Quit(); return 1; }
    say("engine ready in %.0f ms", now_ms() - t_boot);
    check_begin();

    int in_game = 0, paused = 0, mask = 0, raw = 0, praw = 0, hold = 0, quit = 0, draw_frames = 3, exit_code = 0; unsigned loops = 0;
    newer_known();
    const double interval = 1000.0 / 60.0;
    double tick_avg = 0, last = -1, acc_tick = 0, acc_draw = 0, acc_show = 0, worst = 0, t_log = now_ms(); int acc_n = 0, acc_shown = 0, acc_drawn = 0, late = 0;
    while (!quit && !g_quit) {
        SDL_Event ev; int to_menu = 0;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) quit = 1;
            if (ev.type != SDL_KEYDOWN && ev.type != SDL_KEYUP) continue;
            int d = ev.type == SDL_KEYDOWN, bit = 0;
            switch (ev.key.keysym.sym) {
            case K_UP: bit = 1; break; case K_DOWN: bit = 2; break; case K_LEFT: bit = 4; break; case K_RIGHT: bit = 8; break;
            case K_A: bit = 16; break; case K_X: bit = 256; break;      /* A, and X as a second A */
            case K_B: bit = 32; break; case K_Y: bit = 512; break;      /* B, and Y as a second B */
            case K_L1: bit = 64; break; case K_L2: bit = 1024; break;
            case K_R1: bit = 128; break; case K_R2: bit = 2048; break;
            case K_START: if (d && in_game) { paused = !paused; g_psel = 0; hold = raw; AUDIO_LOCK(); ay_pause(paused); AUDIO_UNLOCK(); draw_frames = 2; last = -1; } break;
            case K_SELECT: if (d && in_game) { S.effect = !S.effect; settings_save(); draw_frames = 2; } break;
            case K_MENU: if (d) { if (in_game) to_menu = 1; else quit = 1; } break;
            default: break;
            }
            if (bit) raw = d ? raw | bit : raw & ~bit;
        }
        if (paused && in_game) {            /* the pause menu has the buttons */
            int r = pause_key(raw & ~praw);
            if (r == 1) { paused = 0; hold = raw; AUDIO_LOCK(); ay_pause(0); AUDIO_UNLOCK(); last = -1; }
            if (r == 2) to_menu = 1;
            draw_frames = 2;                /* its cursor moves */
        }
        praw = raw; hold &= raw;            /* a button that closed the menu does nothing in the game until it is let go */
        mask = ((raw & 63) | (in_game && raw & 256 ? 16 : 0) | (in_game && raw & 512 ? 32 : 0)) & ~((hold & 63) | (hold & 256 ? 16 : 0) | (hold & 512 ? 32 : 0));
        g_raw = (raw & 63) | (raw & (64 | 1024) ? 64 : 0) | (raw & (128 | 2048) ? 128 : 0) | (raw & (256 | 512));
        if ((++loops & 31) == 0 && (check_poll() || appcheck_poll())) {
            if (in_game || srv_addr()[0]) g_error[0] = 0;      /* busy: the new list is simply there at the next visit */
            else { if (menu_with_note()) break; draw_frames = 3; last = -1; continue; }
        }
        if (!in_game || srv_is_dev()) srv_poll(g_dir);
        {
            int d = dev_take();
            if (d) { in_game = d == 1; paused = 0; raw = 0; tick_avg = 0; g_backdrop = 1; draw_frames = 3; last = -1; AUDIO_LOCK(); ay_pause(0); AUDIO_UNLOCK(); continue; }
        }

        if (to_menu) {
            paused = 0; AUDIO_LOCK(); ay_pause(0); AUDIO_UNLOCK();
            if (!g_keep_error) g_error[0] = 0;
            g_keep_error = 0; in_game = 0; raw = 0;
            if (srv_is_dev()) srv_status("idle", "", 0);
            if (start_menu()) break;
            g_backdrop = 1; draw_frames = 3; last = -1; continue;
        }

        double t = now_ms(); int stepped = 0, failed = 0, stall = 0;
        if (!paused) {
            if (last < 0) last = t - interval;
            double elapsed = t - last;
            if (elapsed >= interval - 0.5) {
                int steps = elapsed > 250 ? 1 : (int)((elapsed + 0.5) / interval);
                if (steps > MAX_FRAME_STEPS) steps = MAX_FRAME_STEPS;
                /* A game whose own tick takes most of a frame can never catch up. Running several ticks per
                   picture would only make it jerky as well as slow, so show every tick (or every second one). */
                int cap = tick_avg > 9 ? 1 : tick_avg > 4.5 ? 2 : MAX_FRAME_STEPS, capped = steps > cap;
                if (capped) steps = cap;
                if (steps > 1) late += steps - 1;
                for (int i = 0; i < steps && !failed; i++) {
                    double a = now_ms();
                    int wait = prog_frame(mask);
                    if (wait < 0) failed = 1; else stall += wait;
                    double took = now_ms() - a; if (took > 100) took = 100;
                    tick_avg += (took - tick_avg) * 0.1;
                }
                last = capped || elapsed > interval * MAX_FRAME_STEPS ? t : last + steps * interval;
                stepped = 1; acc_n += steps;
            }
        }
        double t1 = now_ms(); acc_tick += t1 - t;

        if (failed) {                       /* the game threw an error: back to the list, which shows it */
            if (srv_is_dev()) srv_status("error", g_error, 0);
            in_game = 0; raw = 0;
            if (start_menu()) break;
            g_backdrop = 1; draw_frames = 3; last = -1; continue;
        }
        if (g_launch) {
            char *h = g_launch; g_launch = 0; save_state();
            if (S.bezel) { ui_game_frame(1); present(1); }      /* the frame, lit, while the game is unpacked and started */
            in_game = start_game(h) == 0; free(h); tick_avg = 0;
            raw = 0; g_backdrop = 1; draw_frames = 3; last = -1; continue;
        }

        /* paint every tick; push it to the screen only when the picture changed */
        if (stepped || draw_frames > 0) {
            static uint8_t shown[160 * 144];
            int whole = 1;
            if (!P.wide) {
                if (prog_pixels() < 0) { in_game = 0; if (start_menu()) break; draw_frames = 3; last = -1; continue; }
                if (draw_frames <= 0 && !g_backdrop && !frame_busy() && !memcmp(shown, g_px, sizeof shown)) { acc_draw += now_ms() - t1; acc_drawn++; goto shown_already; }
                memcpy(shown, g_px, sizeof shown);
                compose_game(paused);
                whole = g_whole || draw_frames > 0; g_whole = 0;
            }
            double t2 = now_ms(); acc_draw += t2 - t1; acc_drawn++;
            present(whole);
            double t3 = now_ms(); acc_show += t3 - t2; acc_shown++;
            if (t3 - t > worst) worst = t3 - t;
            if (draw_frames > 0) draw_frames--;
        }
    shown_already:
        if (g_offer && !in_game && !srv_addr()[0] && !g_update) { g_offer = 0; g_appupdate = g_from_offer = 1; }   /* a new version: say so, full screen */
        if (g_appupdate && !in_game) {      /* Settings > Update Playload: its own screens, until it is done or given up */
            int offered = g_from_offer;
            if (app_update(present_all, update_keys) == 42) { exit_code = 42; break; }
            if (!offered) g_tab = 4;
            srv_stop();
            if (offered && g_error[0]) snprintf(g_head, sizeof g_head, "NOTE");
            if (prog_start(g_menu_src, 1)) break;
            g_error[0] = 0; snprintf(g_head, sizeof g_head, "GAME STOPPED");
            raw = 0; g_backdrop = 1; draw_frames = 3; last = -1; continue;
        }
        if (g_update) {                     /* its "updating" screen is up by now; this blocks until curl is done */
            if (run_update()) break;
            raw = 0; g_backdrop = 1; draw_frames = 3; last = -1; continue;
        }
        if (stall) SDL_Delay((Uint32)(stall * interval));

        double t4 = now_ms();
        if (in_game && srv_is_dev()) srv_status(0, 0, tick_avg);
        if (t4 - t_log > 15000) {
            if (acc_n) say("%s: tick %.2f ms, draw %.2f ms, show %.2f ms, worst frame %.1f ms, %d ticks, %d caught up", in_game ? g_title : "list",
                           acc_tick / acc_n, acc_drawn ? acc_draw / acc_drawn : 0, acc_shown ? acc_show / acc_shown : 0, worst, acc_n, late);
            acc_tick = acc_draw = acc_show = worst = 0; acc_n = acc_shown = acc_drawn = late = 0; t_log = t4;
        }
        double left = paused ? 20 : last + interval - now_ms();
        if (left > 1.5) SDL_Delay((Uint32)(left - 0.5)); else if (left > 0.2) SDL_Delay(1);
    }
    save_state();
    srv_stop();
    prog_free();
    if (g_audio_on) { SDL_PauseAudio(1); SDL_CloseAudio(); }
    SDL_Quit();
    return exit_code;                       /* 42: launch.sh puts a downloaded update in place and starts us again */
}
#endif

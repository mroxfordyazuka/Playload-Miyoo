/* The seam between the app and a JavaScript engine. Two engines implement js_*: QuickJS (js_quickjs.c, small,
   interpreter only) and JavaScriptCore (js_jsc.cpp, large, compiles hot code to ARM). The app implements h_*. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct { const char *games_json, *arcade_json; int tab, sel; const char *error, *head; } JsMenu;

/* engine side */
const char *js_engine_name(void);
int js_start(const char *bundle, size_t bundle_len, const char *source, int wide, const JsMenu *menu, int fixed_random);   /* 0, or -1 after h_error() */
void js_stop(void);
int js_frame(int mask);                       /* frames to wait (0..), or -1 after h_error() */
int js_pixels(void);                          /* paints into the bound pixel array. 0, or -1 after h_error() */

/* app side */
int h_timed_out(void);
void h_error(const char *msg, const char *stack);
void h_play(int ch, const double *flat, size_t count);
/* the engine's arrays (they stay where they are until js_stop): pixels, glyph patterns, glyph colors, cell slots, cell colors 1 and 2, sprites */
void h_bind(uint8_t *const p[7], const size_t n[7], int cols);
void h_render(int nspr);
double h_now(void);
void h_log(const char *text);
char *h_decode(const char *hash);             /* malloc'd source, or NULL */
void h_launch(const char *hash, const char *title);
void h_quit(void);
int h_raw(void);
void h_remember(int tab, int sel);
void h_update(void);
int h_serve(int on);
const char *h_addr(void);
int h_inbox(void);
char *h_mine(void);
const char *h_ui(int op, const char *s1, const char *s2, int a, int b, int c, int d);   /* the list's drawing kit and settings */                           /* malloc'd text of mygames.txt */

#ifdef __cplusplus
}
#endif

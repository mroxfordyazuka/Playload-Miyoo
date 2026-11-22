/* ArchiveTV's GBA-style UI kit, as used by Playload: everything is drawn on a 320x240 "virtual" canvas, each virtual pixel = 2x2 real pixels. */
#pragma once
#include <stdint.h>

extern int UW, UH, UVIS;   /* virtual screen size (real / 2) and list rows; set by ui_init */
#define UROWH 18

typedef struct { const char *main, *side; int tone; } URow;   /* tone: 0 normal, 1 good, 2 warn, 3 dim, 4 "more" */

void ui_init(uint32_t *target, int real_w, int real_h);
void ui_bg(double t);
void ui_header(const char *title, const char *right, double t, int mood);
void ui_header_tabs(const char *const *tabs, int n, int sel, const char *right, double t);
void ui_footer(const char *hints);
void ui_footer_badge(const char *b);
void ui_toast(const char *msg);
void ui_list(const URow *rows, int n, int sel, int top, int marquee_off, double t, const char *empty);
void ui_menu(const char *title, const char *const *items, int n, int sel, double t);
void ui_rect(int x, int y, int w, int h, uint32_t c);
extern int ui_marquee_extra;
int ui_theme_count(void);
const char *ui_theme_name(int i);
void ui_set_theme(int i);
void ui_panel(void);
void ui_text(int x, int y, const char *s, int role);
void ui_qr(const unsigned char *modules, int n, int x, int y, int px);
void ui_game_frame(int light_on);   /* the dark frame around a game; its logo and light take the theme's colours */
void ui_frame_light(int on);       /* repaint only the power light */
extern int ui_font;             /* 0 Playload's 8x8, 1 m5x7 */

#pragma once
#include <stdint.h>
#include <stddef.h>

/* ay.c */
enum { AY_REPEAT, AY_T, AY_M, AY_V, AY_W, AY_X, AY_U, AY_H, AY_NOTE };
typedef struct { int op; double a, b; } AyEvent;
void ay_init(int rate);
void ay_reset(void);
void ay_pause(int on);
void ay_play(int ch, AyEvent *code, int n, int fixed);
void ay_render(int16_t *out, int frames);

/* payload.c: "#v1.<base64url of raw-deflated UTF-8>" -> malloc'd source text (NUL-terminated), or NULL */
char *payload_decode(const char *hash, size_t *len, const char **why);

/* net.c */
int net_update(const char *dir, char *msg, size_t cap);
int net_update_begin(const char *dir, int patient);
int net_update_end(const char *dir, int status, int bundled, char *msg, size_t cap, int *added, int *changed);
int net_get_begin(const char *dir, const char *url, const char *out, int big);   /* curl in a process of its own: pid or -1 */
const char *net_why(int status);                                                 /* a wait() status from it, in words */
int srv_start(void);
void srv_stop(void);
void srv_poll(const char *dir);
const char *srv_addr(void);
int srv_count(void);
void srv_dev(int on);
void srv_code(const char *src);
void srv_lang(int ja);
int srv_is_dev(void);
char *srv_take_run(void);
void srv_status(const char *state, const char *note, double tick_ms);

/* qr.c */
int qr_encode(const char *text, unsigned char *modules);

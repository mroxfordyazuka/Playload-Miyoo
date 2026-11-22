/* Engine backend: QuickJS-ng. Small and portable; interprets, never compiles. */
#include "js.h"
#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

static JSRuntime *rt; static JSContext *ctx; static JSValue f_frame, f_pixels;

const char *js_engine_name(void) { return "QuickJS"; }
static int on_interrupt(JSContext *c, void *opaque) { (void)c; (void)opaque; return h_timed_out(); }

static void take_error(JSContext *c) {
    JSValue e = JS_GetException(c);
    const char *msg = 0, *stack = 0;
    if (JS_IsObject(e)) {
        JSValue m = JS_GetPropertyStr(c, e, "message"), s = JS_GetPropertyStr(c, e, "stack");
        if (JS_IsString(m)) msg = JS_ToCString(c, m);
        if (JS_IsString(s)) stack = JS_ToCString(c, s);
        JS_FreeValue(c, m); JS_FreeValue(c, s);
    }
    if (!msg) msg = JS_ToCString(c, e);
    h_error(msg, stack);
    if (msg) JS_FreeCString(c, msg);
    if (stack) JS_FreeCString(c, stack);
    JS_FreeValue(c, e);
    JS_ResetUncatchableError(c);
}
/* typed array -> its bytes */
static uint8_t *bytes_of(JSContext *c, JSValueConst v, size_t *n) {
    size_t off = 0, len = 0, bpe = 0, size = 0;
    JSValue ab = JS_GetTypedArrayBuffer(c, v, &off, &len, &bpe);
    if (JS_IsException(ab)) return 0;
    uint8_t *buf = JS_GetArrayBuffer(c, &size, ab);
    JS_FreeValue(c, ab);
    if (!buf || off + len > size) return 0;
    *n = len; return buf + off;
}
#define FN(name) static JSValue name(JSContext *c, JSValueConst self, int argc, JSValueConst *argv)
#define UNUSED (void)c; (void)self; (void)argc; (void)argv
FN(n_play) {
    UNUSED; int ch = 0; size_t n = 0;
    if (argc < 2 || JS_ToInt32(c, &ch, argv[0])) return JS_UNDEFINED;
    uint8_t *b = bytes_of(c, argv[1], &n); if (!b) return JS_EXCEPTION;
    if (n >= 8 && !((uintptr_t)b & 7)) h_play(ch, (const double *)b, n / 8);
    return JS_UNDEFINED;
}
FN(n_bind) {
    UNUSED; size_t n[7]; uint8_t *p[7]; int cols;
    if (argc < 8) return JS_UNDEFINED;
    for (int i = 0; i < 7; i++) if (!(p[i] = bytes_of(c, argv[i], &n[i]))) return JS_EXCEPTION;
    if (JS_ToInt32(c, &cols, argv[7])) return JS_EXCEPTION;
    h_bind(p, n, cols);
    return JS_UNDEFINED;
}
FN(n_render) { UNUSED; int nspr = 0; if (argc > 0 && !JS_ToInt32(c, &nspr, argv[0])) h_render(nspr); return JS_UNDEFINED; }
FN(n_now) { UNUSED; return JS_NewFloat64(c, h_now()); }
FN(n_log) { UNUSED; for (int i = 0; i < argc; i++) { const char *s = JS_ToCString(c, argv[i]); if (s) { h_log(s); JS_FreeCString(c, s); } } return JS_UNDEFINED; }
FN(n_decode) {
    UNUSED; if (argc < 1) return JS_NULL;
    const char *hash = JS_ToCString(c, argv[0]); if (!hash) return JS_EXCEPTION;
    char *src = h_decode(hash); JS_FreeCString(c, hash);
    if (!src) return JS_NULL;
    JSValue v = JS_NewString(c, src); free(src); return v;
}
FN(n_launch) {
    UNUSED; if (argc < 1) return JS_UNDEFINED;
    const char *hash = JS_ToCString(c, argv[0]), *title = argc > 1 ? JS_ToCString(c, argv[1]) : 0;
    if (hash) h_launch(hash, title);
    if (hash) JS_FreeCString(c, hash);
    if (title) JS_FreeCString(c, title);
    return JS_UNDEFINED;
}
FN(n_quit) { UNUSED; h_quit(); return JS_UNDEFINED; }
FN(n_raw) { UNUSED; return JS_NewInt32(c, h_raw()); }
FN(n_remember) { UNUSED; int a = 0, b = 0; if (argc >= 2 && !JS_ToInt32(c, &a, argv[0]) && !JS_ToInt32(c, &b, argv[1])) h_remember(a, b); return JS_UNDEFINED; }
FN(n_update) { UNUSED; h_update(); return JS_UNDEFINED; }
FN(n_serve) { UNUSED; int on = 0; if (argc > 0) JS_ToInt32(c, &on, argv[0]); return JS_NewBool(c, h_serve(on)); }   /* true / 1 = phone, 2 = dev panel too */
FN(n_addr) { UNUSED; return JS_NewString(c, h_addr()); }
FN(n_inbox) { UNUSED; return JS_NewInt32(c, h_inbox()); }
FN(n_ui) {
    UNUSED; int v[5] = { 0, 0, 0, 0, 0 };
    if (argc > 0) JS_ToInt32(c, &v[0], argv[0]);
    for (int i = 0; i < 4; i++) if (argc > 3 + i) JS_ToInt32(c, &v[1 + i], argv[3 + i]);
    const char *s1 = argc > 1 ? JS_ToCString(c, argv[1]) : 0, *s2 = argc > 2 ? JS_ToCString(c, argv[2]) : 0;
    JSValue r = JS_NewString(c, h_ui(v[0], s1, s2, v[1], v[2], v[3], v[4]));
    if (s1) JS_FreeCString(c, s1);
    if (s2) JS_FreeCString(c, s2);
    return r;
}
FN(n_mine) { UNUSED; char *t = h_mine(); JSValue v = JS_NewString(c, t ? t : ""); free(t); return v; }

void js_stop(void) {
    if (!rt) return;
    JS_FreeValue(ctx, f_frame); JS_FreeValue(ctx, f_pixels);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    rt = 0; ctx = 0;
}
int js_start(const char *bundle, size_t bundle_len, const char *source, int wide, const JsMenu *menu, int fixed_random) {
    static const struct { const char *name; JSCFunction *f; int n; } natives[] = {
        { "play", n_play, 2 }, { "bind", n_bind, 8 }, { "render", n_render, 1 }, { "now", n_now, 0 }, { "log", n_log, 1 }, { "decode", n_decode, 1 },
        { "launch", n_launch, 2 }, { "quit", n_quit, 0 }, { "raw", n_raw, 0 }, { "remember", n_remember, 2 }, { "update", n_update, 0 },
        { "serve", n_serve, 1 }, { "addr", n_addr, 0 }, { "inbox", n_inbox, 0 }, { "mine", n_mine, 0 }, { "ui", n_ui, 7 } };
    rt = JS_NewRuntime(); if (!rt) { h_error("Out of memory", 0); return -1; }
    JS_SetMemoryLimit(rt, 48u * 1024 * 1024);
    JS_SetMaxStackSize(rt, 512 * 1024);
    JS_SetGCThreshold(rt, 24u * 1024 * 1024);   /* the cycle collector walks the whole heap (150 ms on the Miyoo): let it run rarely */
    JS_SetInterruptHandler(rt, on_interrupt, 0);
    JSContext *c = ctx = JS_NewContext(rt);
    f_frame = f_pixels = JS_UNDEFINED;
    int ok = 0;
    if (fixed_random) {
        static const char fixed[] = "(()=>{let s=12345;Math.random=()=>{s=(Math.imul(s,1103515245)+12345)>>>0;return s/4294967296};"
                                    "let t=0;Date.now=()=>1700000000000+(t+=16);})()";
        JS_FreeValue(c, JS_Eval(c, fixed, sizeof fixed - 1, "fixed.js", JS_EVAL_TYPE_GLOBAL));
    }
    JSValue host = JS_NewObject(c);
    JS_SetPropertyStr(c, host, "engine", JS_NewString(c, js_engine_name()));
    for (size_t i = 0; i < sizeof natives / sizeof natives[0]; i++) JS_SetPropertyStr(c, host, natives[i].name, JS_NewCFunction(c, natives[i].f, natives[i].name, natives[i].n));
    JSValue boot = JS_Eval(c, bundle, bundle_len, "playload.js", JS_EVAL_TYPE_GLOBAL);
    JSValue start = JS_IsException(boot) ? JS_EXCEPTION : JS_Call(c, boot, JS_UNDEFINED, 1, &host);
    JSValue ctl = JS_UNDEFINED;
    if (!JS_IsException(start)) {
        JSValue a[8] = { JS_NewString(c, source), JS_NewBool(c, wide), JS_NewString(c, menu->games_json), JS_NewString(c, menu->arcade_json),
                         JS_NewInt32(c, menu->tab), JS_NewInt32(c, menu->sel), JS_NewString(c, menu->error), JS_NewString(c, menu->head) };
        ctl = JS_Call(c, start, JS_UNDEFINED, 8, a);
        for (int i = 0; i < 8; i++) JS_FreeValue(c, a[i]);
        if (!JS_IsException(ctl)) {
            f_frame = JS_GetPropertyStr(c, ctl, "frame"); f_pixels = JS_GetPropertyStr(c, ctl, "pixels");
            ok = JS_IsFunction(c, f_frame) && JS_IsFunction(c, f_pixels);
        }
    }
    if (!ok) take_error(c);
    JS_FreeValue(c, ctl); JS_FreeValue(c, start); JS_FreeValue(c, boot); JS_FreeValue(c, host);
    return ok ? 0 : -1;
}
int js_frame(int mask) {
    JSValue arg = JS_NewInt32(ctx, mask);
    JSValue r = JS_Call(ctx, f_frame, JS_UNDEFINED, 1, &arg);
    if (JS_IsException(r)) { take_error(ctx); return -1; }
    int wait = 0; JS_ToInt32(ctx, &wait, r); JS_FreeValue(ctx, r);
    for (int i = 0; i < 1000 && JS_IsJobPending(rt); i++) {
        JSContext *c; if (JS_ExecutePendingJob(rt, &c) < 0) { take_error(c); return -1; }
    }
    return wait < 0 ? 0 : wait;
}
int js_pixels(void) {
    JSValue r = JS_Call(ctx, f_pixels, JS_UNDEFINED, 0, 0);
    if (JS_IsException(r)) { take_error(ctx); return -1; }
    JS_FreeValue(ctx, r);
    return 0;
}

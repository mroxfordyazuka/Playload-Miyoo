/* A small QR code encoder: byte mode, error correction level L, versions 1 to 5 (up to 106 bytes), which is
   plenty for "http://192.168.1.23:8080". Follows ISO/IEC 18004; all eight masks are tried and the best kept. */
#include "pl.h"
#include <string.h>

static const int DATA_CW[6] = { 0, 19, 34, 55, 80, 108 }, EC_CW[6] = { 0, 7, 10, 15, 20, 26 };

static unsigned char gf_exp[512], gf_log[256];
static void gf_init(void) {
    if (gf_exp[0]) return;
    int x = 1;
    for (int i = 0; i < 255; i++) { gf_exp[i] = (unsigned char)x; gf_log[x] = (unsigned char)i; x <<= 1; if (x & 256) x ^= 0x11d; }
    for (int i = 255; i < 512; i++) gf_exp[i] = gf_exp[i - 255];
}
static void rs(const unsigned char *data, int nd, unsigned char *ec, int ne) {
    unsigned char gen[32] = { 1 }; int ng = 1;
    for (int i = 0; i < ne; i++) {          /* multiply by (x - a^i) */
        unsigned char next[32] = { 0 };
        for (int j = 0; j < ng; j++) { next[j] ^= gen[j]; next[j + 1] ^= gen[j] ? gf_exp[gf_log[gen[j]] + i] : 0; }
        ng++; memcpy(gen, next, sizeof gen);
    }
    memset(ec, 0, (size_t)ne);
    for (int i = 0; i < nd; i++) {
        unsigned char f = data[i] ^ ec[0];
        memmove(ec, ec + 1, (size_t)ne - 1); ec[ne - 1] = 0;
        if (f) for (int j = 0; j < ne; j++) ec[j] ^= gen[j + 1] ? gf_exp[gf_log[gen[j + 1]] + gf_log[f]] : 0;
    }
}
#define N_MAX 37
static unsigned char fn[N_MAX * N_MAX];     /* 1 = function module (not data, not masked) */
static int n;
static void put(unsigned char *m, int x, int y, int v) { if (x >= 0 && y >= 0 && x < n && y < n) { m[y * n + x] = (unsigned char)v; fn[y * n + x] = 1; } }
static void finder(unsigned char *m, int cx, int cy) {
    for (int dy = -4; dy <= 4; dy++) for (int dx = -4; dx <= 4; dx++) {
        int d = dx < 0 ? -dx : dx, e = dy < 0 ? -dy : dy, r = d > e ? d : e;
        put(m, cx + dx, cy + dy, r != 2 && r != 4);
    }
}
static int mask_bit(int k, int x, int y) {
    switch (k) {
    case 0: return (x + y) % 2 == 0; case 1: return y % 2 == 0; case 2: return x % 3 == 0; case 3: return (x + y) % 3 == 0;
    case 4: return (y / 2 + x / 3) % 2 == 0; case 5: return x * y % 2 + x * y % 3 == 0;
    case 6: return (x * y % 2 + x * y % 3) % 2 == 0; default: return ((x + y) % 2 + x * y % 3) % 2 == 0;
    }
}
static void format_bits(unsigned char *m, int mask) {
    int data = (1 << 3) | mask, rem = data;      /* level L = 01 */
    for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    int bits = ((data << 10) | rem) ^ 0x5412;
    for (int i = 0; i <= 5; i++) put(m, 8, i, (bits >> i) & 1);
    put(m, 8, 7, (bits >> 6) & 1); put(m, 8, 8, (bits >> 7) & 1); put(m, 7, 8, (bits >> 8) & 1);
    for (int i = 9; i < 15; i++) put(m, 14 - i, 8, (bits >> i) & 1);
    for (int i = 0; i < 8; i++) put(m, n - 1 - i, 8, (bits >> i) & 1);
    for (int i = 8; i < 15; i++) put(m, 8, n - 15 + i, (bits >> i) & 1);
    put(m, 8, n - 8, 1);
}
static int penalty(const unsigned char *m) {
    int p = 0, dark = 0;
    for (int pass = 0; pass < 2; pass++) for (int a = 0; a < n; a++) {
        int run = 0, prev = -1; unsigned hist = 0;
        for (int b = 0; b < n; b++) {
            int v = pass ? m[b * n + a] : m[a * n + b];
            if (v == prev) { run++; if (run == 5) p += 3; else if (run > 5) p++; } else { run = 1; prev = v; }
            hist = ((hist << 1) | (unsigned)v) & 0x7ff;
            if (b >= 10 && (hist == 0x5d0 || hist == 0x05d)) p += 40;     /* 1011101 with four light on one side */
        }
    }
    for (int y = 0; y < n - 1; y++) for (int x = 0; x < n - 1; x++) {
        int v = m[y * n + x];
        if (v == m[y * n + x + 1] && v == m[(y + 1) * n + x] && v == m[(y + 1) * n + x + 1]) p += 3;
    }
    for (int i = 0; i < n * n; i++) dark += m[i];
    int pct = dark * 100 / (n * n), dev = pct > 50 ? pct - 50 : 50 - pct;
    return p + dev / 5 * 10;
}
/* modules gets size*size bytes of 0/1 (room for 37*37). returns size, or 0 if the text is too long */
int qr_encode(const char *text, unsigned char *modules) {
    gf_init();
    int len = (int)strlen(text), v = 0;
    for (int k = 1; k <= 5; k++) if (len + 2 <= DATA_CW[k]) { v = k; break; }
    if (!v) return 0;
    n = 17 + 4 * v;
    int nd = DATA_CW[v], ne = EC_CW[v];
    unsigned char cw[160], bitbuf[160]; int nb = 0;
    memset(bitbuf, 0, sizeof bitbuf);
#define BITS(val, cnt) for (int _i = (cnt) - 1; _i >= 0; _i--) { if (((val) >> _i) & 1) bitbuf[nb >> 3] |= (unsigned char)(128 >> (nb & 7)); nb++; }
    BITS(4, 4) BITS(len, 8)
    for (int i = 0; i < len; i++) BITS((unsigned char)text[i], 8)
    BITS(0, 4)
    int used = (nb + 7) / 8;
    memcpy(cw, bitbuf, (size_t)nd);
    for (int i = used, k = 0; i < nd; i++, k++) cw[i] = k & 1 ? 0x11 : 0xec;
    rs(cw, nd, cw + nd, ne);
    int total = nd + ne;

    static unsigned char base[N_MAX * N_MAX], trial[N_MAX * N_MAX];
    memset(base, 0, sizeof base); memset(fn, 0, sizeof fn);
    finder(base, 3, 3); finder(base, n - 4, 3); finder(base, 3, n - 4);
    for (int i = 8; i < n - 8; i++) { put(base, i, 6, i % 2 == 0); put(base, 6, i, i % 2 == 0); }
    if (v >= 2) for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
        int d = dx < 0 ? -dx : dx, e = dy < 0 ? -dy : dy;
        put(base, n - 7 + dx, n - 7 + dy, (d > e ? d : e) != 1);
    }
    format_bits(base, 0);                    /* reserves the format area */
    /* data, zig-zag from the bottom right, two columns at a time, skipping the timing column */
    int bit = 0, up = 1;
    for (int right = n - 1; right >= 1; right -= 2) {
        if (right == 6) right = 5;
        for (int k = 0; k < n; k++) {
            int y = up ? n - 1 - k : k;
            for (int j = 0; j < 2; j++) {
                int x = right - j;
                if (fn[y * n + x]) continue;
                int val = bit < total * 8 ? (cw[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
                base[y * n + x] = (unsigned char)val; bit++;
            }
        }
        up = !up;
    }
    int best = -1, best_p = 0;
    for (int k = 0; k < 8; k++) {
        memcpy(trial, base, (size_t)(n * n));
        for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) if (!fn[y * n + x] && mask_bit(k, x, y)) trial[y * n + x] ^= 1;
        format_bits(trial, k);
        int p = penalty(trial);
        if (best < 0 || p < best_p) { best = k; best_p = p; memcpy(modules, trial, (size_t)(n * n)); }
    }
    return n;
}

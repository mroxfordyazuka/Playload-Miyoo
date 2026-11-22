/* Playload game links: "#v1." + unpadded base64url of the raw-deflated UTF-8 source (see Playload's src/payload.js). */
#include "pl.h"
#include <stdlib.h>
#include <string.h>

#define MAX_SOURCE (1024 * 1024)
#define MAX_PACKED 3072

/* ---- a small inflate (RFC 1951) ---- */
typedef struct { const uint8_t *in; size_t n, pos; uint32_t bits; int cnt; uint8_t *out; size_t len, cap; int err; } Z;
typedef struct { uint16_t count[16], symbol[288]; } Huff;

static int getbits(Z *z, int need) {
    while (z->cnt < need) {
        if (z->pos >= z->n) { z->err = 1; return 0; }
        z->bits |= (uint32_t)z->in[z->pos++] << z->cnt; z->cnt += 8;
    }
    int v = (int)(z->bits & ((1u << need) - 1));
    z->bits >>= need; z->cnt -= need;
    return v;
}
static int build(Huff *h, const uint16_t *length, int n) {
    uint16_t offs[16]; int left = 1;
    memset(h->count, 0, sizeof h->count);
    for (int i = 0; i < n; i++) h->count[length[i]]++;
    if (h->count[0] == n) return 0;
    for (int len = 1; len < 16; len++) { left <<= 1; left -= h->count[len]; if (left < 0) return left; }
    offs[1] = 0;
    for (int len = 1; len < 15; len++) offs[len + 1] = offs[len] + h->count[len];
    for (int i = 0; i < n; i++) if (length[i]) h->symbol[offs[length[i]]++] = (uint16_t)i;
    return left;
}
static int decode(Z *z, const Huff *h) {
    int code = 0, first = 0, index = 0;
    for (int len = 1; len < 16; len++) {
        code |= getbits(z, 1); if (z->err) return -1;
        int count = h->count[len];
        if (code - count < first) return h->symbol[index + (code - first)];
        index += count; first += count; first <<= 1; code <<= 1;
    }
    z->err = 1; return -1;
}
static void put(Z *z, uint8_t b) {
    if (z->len >= z->cap) { z->err = 2; return; }
    z->out[z->len++] = b;
}
static void codes(Z *z, const Huff *lc, const Huff *dc) {
    static const uint16_t lens[29] = { 3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258 };
    static const uint16_t lext[29] = { 0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0 };
    static const uint16_t dists[30] = { 1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577 };
    static const uint16_t dext[30] = { 0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13 };
    for (;;) {
        int sym = decode(z, lc);
        if (z->err) return;
        if (sym < 256) put(z, (uint8_t)sym);
        else if (sym == 256) return;
        else {
            sym -= 257; if (sym >= 29) { z->err = 1; return; }
            int len = lens[sym] + getbits(z, lext[sym]);
            sym = decode(z, dc); if (z->err || sym >= 30) { z->err = z->err ? z->err : 1; return; }
            size_t dist = (size_t)dists[sym] + (size_t)getbits(z, dext[sym]);
            if (z->err || dist > z->len) { z->err = z->err ? z->err : 1; return; }
            while (len-- && !z->err) put(z, z->out[z->len - dist]);
        }
        if (z->err) return;
    }
}
static int inflate_raw(Z *z) {
    static const uint8_t order[19] = { 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15 };
    static Huff lc, dc; uint16_t length[320];
    int last;
    do {
        last = getbits(z, 1);
        int type = getbits(z, 2);
        if (z->err) return z->err;
        if (type == 0) {
            z->bits = 0; z->cnt = 0;
            if (z->pos + 4 > z->n) return 1;
            unsigned len = z->in[z->pos] | (z->in[z->pos + 1] << 8), nlen = z->in[z->pos + 2] | (z->in[z->pos + 3] << 8);
            z->pos += 4;
            if (len != (~nlen & 0xffff) || z->pos + len > z->n) return 1;
            while (len-- && !z->err) put(z, z->in[z->pos++]);
        } else if (type == 1) {
            int i = 0;
            for (; i < 144; i++) length[i] = 8;
            for (; i < 256; i++) length[i] = 9;
            for (; i < 280; i++) length[i] = 7;
            for (; i < 288; i++) length[i] = 8;
            build(&lc, length, 288);
            for (i = 0; i < 30; i++) length[i] = 5;
            build(&dc, length, 30);
            codes(z, &lc, &dc);
        } else if (type == 2) {
            int nlen = getbits(z, 5) + 257, ndist = getbits(z, 5) + 1, ncode = getbits(z, 4) + 4, i;
            if (z->err || nlen > 286 || ndist > 30) return 1;
            for (i = 0; i < ncode; i++) length[order[i]] = (uint16_t)getbits(z, 3);
            for (; i < 19; i++) length[order[i]] = 0;
            if (build(&lc, length, 19) != 0) return 1;
            for (i = 0; i < nlen + ndist;) {
                int sym = decode(z, &lc);
                if (z->err) return 1;
                if (sym < 16) length[i++] = (uint16_t)sym;
                else {
                    int prev = 0, rep;
                    if (sym == 16) { if (i == 0) return 1; prev = length[i - 1]; rep = 3 + getbits(z, 2); }
                    else if (sym == 17) rep = 3 + getbits(z, 3);
                    else rep = 11 + getbits(z, 7);
                    if (z->err || i + rep > nlen + ndist) return 1;
                    while (rep--) length[i++] = (uint16_t)prev;
                }
            }
            if (length[256] == 0) return 1;
            int e = build(&lc, length, nlen);
            if (e < 0 || (e > 0 && nlen - lc.count[0] != 1)) return 1;
            e = build(&dc, length + nlen, ndist);
            if (e < 0 || (e > 0 && ndist - dc.count[0] != 1)) return 1;
            codes(z, &lc, &dc);
        } else return 1;
        if (z->err) return z->err;
    } while (!last);
    return 0;
}

static int valid_utf8(const uint8_t *s, size_t n) {
    for (size_t i = 0; i < n;) {
        uint8_t c = s[i]; int more; uint32_t cp;
        if (c < 0x80) { i++; continue; }
        else if ((c & 0xe0) == 0xc0) { more = 1; cp = c & 0x1f; }
        else if ((c & 0xf0) == 0xe0) { more = 2; cp = c & 0x0f; }
        else if ((c & 0xf8) == 0xf0) { more = 3; cp = c & 0x07; }
        else return 0;
        if (i + (size_t)more >= n) return 0;
        for (int k = 1; k <= more; k++) { if ((s[i + k] & 0xc0) != 0x80) return 0; cp = (cp << 6) | (s[i + k] & 0x3f); }
        if ((more == 1 && cp < 0x80) || (more == 2 && cp < 0x800) || (more == 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
        i += (size_t)more + 1;
    }
    return 1;
}

char *payload_decode(const char *hash, size_t *len, const char **why) {
    static const char *dummy; if (!why) why = &dummy;
    const char *body;
    if (!strncmp(hash, "#v1.", 4)) body = hash + 4; else if (!strncmp(hash, "#1.", 3)) body = hash + 3;
    else { *why = "Invalid game URL"; return 0; }
    size_t n = strlen(body);
    if (!n || n > (MAX_PACKED * 4 + 2) / 3 || n % 4 == 1) { *why = "Invalid payload length"; return 0; }
    uint8_t *packed = malloc(n), *out = malloc(MAX_SOURCE + 1);
    if (!packed || !out) { free(packed); free(out); *why = "Out of memory"; return 0; }
    size_t pn = 0; uint32_t acc = 0; int bits = 0;
    for (size_t i = 0; i < n; i++) {
        char c = body[i]; int v;
        if (c >= 'A' && c <= 'Z') v = c - 'A'; else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
        else if (c >= '0' && c <= '9') v = c - '0' + 52; else if (c == '-') v = 62; else if (c == '_') v = 63;
        else { free(packed); free(out); *why = "Invalid game URL"; return 0; }
        acc = (acc << 6) | (uint32_t)v; bits += 6;
        if (bits >= 8) { bits -= 8; packed[pn++] = (uint8_t)(acc >> bits); }
    }
    Z z; memset(&z, 0, sizeof z); z.in = packed; z.n = pn; z.out = out; z.cap = MAX_SOURCE;
    int e = inflate_raw(&z);
    free(packed);
    if (e) { free(out); *why = e == 2 ? "Expanded source exceeds 1 MiB" : "Damaged game URL"; return 0; }
    if (!valid_utf8(out, z.len)) { free(out); *why = "Game source is not valid UTF-8"; return 0; }
    out[z.len] = 0;
    if (len) *len = z.len;
    return (char *)out;
}

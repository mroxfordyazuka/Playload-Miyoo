/* The sound chip: a C translation of the AY class in Playload's src/engine/sound.js (MIT, Takashi Kitao).
   Three square-wave channels, shared 17-bit noise, shared 16-step envelope, eight-times oversampling
   and a windowed-sinc output filter. Scores arrive already compiled by Playload's own compileScore. */
#include "pl.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define KLEN 257
#define OVER 8
#define PI 3.14159265358979323846
#define UNSET (-2147483647 - 1)

typedef struct { AyEvent *code; int n, fixed; int *loops; int pc; double remaining; int volume, envelope, sounding, active; } Voice;

static struct {
    double rate, clock, dc_decay, levels[16];
    float kernel[KLEN], history[KLEN * 2];
    Voice v[3];
    double phase[3], tone_counter[3]; int tone_high[3]; double period[3];
    double half[3], inv_half[3], inv16[3], step[3];   /* per channel, worked out when its period is set */
    int mixer; double tempo;
    unsigned noise; double noise_phase, noise_period;
    double env_period, env_phase; int shape, env_step, attack, env_held, env_level;
    double last_in, last_out; int position;
    int quiet;                       /* how many filter inputs in a row were exactly zero */
    /* what the browser's audio processor adds around the chip */
    double gain, last_sample, previous, transition; int paused;
} A;

static void set_period(int ch, double period) {
    A.period[ch] = period;
    A.half[ch] = 8 * period; A.inv_half[ch] = 1 / (8 * period); A.inv16[ch] = 1 / (16 * period);
    A.step[ch] = A.clock / (16 * period * A.rate * OVER);
    A.phase[ch] = A.tone_counter[ch] + (A.tone_high[ch] ? 0 : 8 * period);
}
static void trigger(void) {
    A.env_phase = 0; A.env_step = 0; A.attack = !!(A.shape & 4); A.env_held = 0; A.env_level = A.attack ? 0 : 15;
}
static void chip_reset(void) {
    for (int c = 0; c < 3; c++) { A.v[c].active = 0; A.tone_counter[c] = 0; A.tone_high[c] = 1; set_period(c, 1); A.phase[c] = 0; }
    A.mixer = 7; A.tempo = 120;
    A.noise = 0x1ffff; A.noise_phase = 0; A.noise_period = 1;
    A.env_period = 65535; A.shape = 0; trigger();
    A.last_in = A.last_out = 0; memset(A.history, 0, sizeof A.history); A.position = 0; A.quiet = KLEN;
}
void ay_init(int rate) {
    static const double volts[16] = { 1.147, 1.162, 1.169, 1.178, 1.192, 1.213, 1.238, 1.299, 1.336, 1.457, 1.573, 1.707, 1.882, 2.06, 2.32, 2.58 };
    memset(&A, 0, sizeof A);
    A.rate = rate; A.clock = 1773400; A.dc_decay = exp((-2 * PI * 20) / rate);
    for (int i = 0; i < 16; i++) A.levels[i] = (volts[i] - volts[0]) / (volts[15] - volts[0]);
    double cutoff = 0.4 / OVER, middle = (KLEN - 1) / 2.0, sum = 0, k[KLEN];
    for (int i = 0; i < KLEN; i++) {
        double t = i - middle, angle = (2 * PI * i) / (KLEN - 1);
        double window = 0.42 - 0.5 * cos(angle) + 0.08 * cos(2 * angle);
        k[i] = (t == 0 ? 2 * cutoff : sin(2 * PI * cutoff * t) / (PI * t)) * window; sum += k[i];
    }
    for (int i = 0; i < KLEN; i++) A.kernel[i] = (float)(k[i] / sum);
    A.gain = 1;
    chip_reset();
}
/* call with the audio thread locked out */
void ay_reset(void) {
    A.previous = A.last_sample; A.transition = 1;
    for (int c = 0; c < 3; c++) { free(A.v[c].code); free(A.v[c].loops); A.v[c].code = 0; A.v[c].loops = 0; }
    chip_reset();
}
void ay_pause(int on) { A.paused = on; }
/* takes ownership of code. call with the audio thread locked out */
void ay_play(int ch, AyEvent *code, int n, int fixed) {
    Voice *v = &A.v[ch];
    free(v->code); free(v->loops); memset(v, 0, sizeof *v);
    if (!n) { free(code); return; }
    v->loops = malloc(sizeof(int) * (size_t)n);
    if (!v->loops) { free(code); return; }
    for (int i = 0; i < n; i++) v->loops[i] = UNSET;
    v->code = code; v->n = n; v->fixed = fixed; v->volume = 15; v->active = 1;
}

static void next(int ch, Voice *v) {
    static const int shapes[8] = { 0, 4, 9, 13, 8, 12, 14, 10 };
    int budget = 32768;
    while (v->pc < v->n) {
        if (--budget == 0) { for (int c = 0; c < 3; c++) A.v[c].active = 0; chip_reset(); return; }   /* "Score loop did not advance" */
        AyEvent *e = &v->code[v->pc++];
        switch (e->op) {
        case AY_REPEAT: {
            int position = v->pc - 1, ecount = (int)e->b;
            int count = v->loops[position] != UNSET ? v->loops[position] : ecount - 1;
            if (ecount == 0 || count > 0) { v->loops[position] = count > -1000000 ? count - 1 : count; v->pc = (int)e->a; }
            else v->loops[position] = UNSET;
            break; }
        case AY_T: if (ch == 0) A.tempo = e->a; break;
        case AY_M: A.mixer = (int)e->a; break;
        case AY_V: v->volume = (int)e->a; v->envelope = 0; break;
        case AY_W: A.shape = shapes[(int)e->a & 7]; break;
        case AY_X: A.env_period = e->a < 0.5 ? 0.5 : e->a; break;
        case AY_U: v->envelope = !v->fixed; break;
        case AY_H: for (int c = 0; c < 3; c++) A.v[c].active = 0; return;
        case AY_NOTE:
            v->remaining += e->b;
            v->sounding = e->a > 0;
            if (v->sounding) {
                double p = floor(A.clock / (16 * e->a) + 0.5);
                set_period(ch, p < 1 ? 1 : p > 4095 ? 4095 : p);
                if (A.mixer & (8 << ch)) { int np = (int)A.period[ch] & 31; A.noise_period = np < 1 ? 1 : np; }
                if (v->envelope) trigger();
            }
            return;
        }
    }
    v->active = 0;
}
static double edge(double phase, double step) {
    if (phase < step) { double t = phase / step; return 2 * t - t * t - 1; }
    if (phase > 1 - step) { double t = (phase - 1) / step; return t * t + 2 * t + 1; }
    return 0;
}
static double tone(int ch) {
    double step = A.step[ch], phase = A.phase[ch] * A.inv16[ch];
    if (step * OVER >= 0.5) return 0.5;
    double other = phase + 0.5; if (other >= 1) other -= 1;
    return (phase < 0.5 ? 1 : 0) + 0.5 * (edge(phase, step) - edge(other, step));
}
/* move the chip's counters on by this many master clocks */
static void advance(double clocks) {
    for (int ch = 0; ch < 3; ch++) {
        double half = A.half[ch], elapsed = A.tone_counter[ch] + clocks;
        long edges = (long)(elapsed * A.inv_half[ch]);
        double left = elapsed - (double)edges * half;
        if (left >= half) { left -= half; edges++; } else if (left < 0) { left += half; edges--; }
        A.tone_counter[ch] = left;
        if (edges & 1) A.tone_high[ch] = !A.tone_high[ch];
        A.phase[ch] = A.tone_counter[ch] + (A.tone_high[ch] ? 0 : half);
    }
    A.noise_phase += clocks;
    while (A.noise_phase >= 16 * A.noise_period) {
        A.noise_phase -= 16 * A.noise_period;
        A.noise = (A.noise >> 1) | (((A.noise ^ (A.noise >> 3)) & 1) << 16);
    }
    A.env_phase += clocks;
    while (A.env_phase >= 16 * A.env_period) {
        A.env_phase -= 16 * A.env_period;
        if (A.env_held) continue;
        A.env_step++;
        if (A.env_step == 16) {
            if (!(A.shape & 8)) { A.env_held = 1; A.env_level = 0; continue; }
            if (A.shape & 1) { A.env_held = 1; A.env_level = A.shape & 2 ? (A.attack ? 0 : 15) : A.attack ? 15 : 0; continue; }
            if (A.shape & 2) A.attack = !A.attack;
            A.env_step = 0;
        }
        A.env_level = A.attack ? A.env_step : 15 - A.env_step;
    }
}
static double synth(void) {
    advance(A.clock / (A.rate * OVER));
    double sum = 0;
    for (int ch = 0; ch < 3; ch++) {
        Voice *v = &A.v[ch];
        if (!v->active || !v->sounding) continue;
        double t = A.mixer & (1 << ch) ? tone(ch) : 1;
        int noise = !(A.mixer & (8 << ch)) || (A.noise & 1);
        if (noise) sum += t * A.levels[v->envelope ? A.env_level : v->volume];
    }
    return sum * 0.2;
}
static double sample(void) {
    int sounding = 0;
    for (int ch = 0; ch < 3; ch++) {
        Voice *v = &A.v[ch];
        if (v->active && v->remaining <= 0) next(ch, v);
        if (A.v[ch].active) { A.v[ch].remaining -= A.tempo / (60 * A.rate); sounding |= A.v[ch].sounding; }
    }
    double input;
    if (!sounding && A.quiet >= KLEN) {
        /* nothing playing and the filter has run dry: keep the counters moving, skip the arithmetic */
        advance(A.clock / A.rate);
        input = 0;
    } else {
        int all_zero = 1;
        for (int i = 0; i < OVER; i++) {
            float value = (float)synth();
            if (value != 0) all_zero = 0;
            A.history[A.position] = A.history[A.position + KLEN] = value;
            A.position = (A.position + 1) % KLEN;
        }
        A.quiet = all_zero ? A.quiet + OVER : 0;
        const float *h = A.history + A.position, *k = A.kernel;
        float acc = k[(KLEN - 1) / 2] * h[(KLEN - 1) / 2];
        for (int i = 0; i < (KLEN - 1) / 2; i++) acc += k[i] * (h[i] + h[KLEN - 1 - i]);
        input = acc;
    }
    double output = input - A.last_in + A.dc_decay * A.last_out;
    if (output > -1e-9 && output < 1e-9) output = 0;
    A.last_in = input; A.last_out = output;
    return output;
}
/* mono, signed 16-bit */
void ay_render(int16_t *out, int frames) {
    double step = 1 / (A.rate * 0.004);
    for (int i = 0; i < frames; i++) {
        A.gain += A.paused ? -step : step; if (A.gain < 0) A.gain = 0; if (A.gain > 1) A.gain = 1;
        if (!A.paused) {
            A.transition -= step; if (A.transition < 0) A.transition = 0;
            A.last_sample = A.previous * A.transition + sample() * (1 - A.transition);
        }
        double s = A.last_sample * A.gain * 32767.0;
        out[i] = (int16_t)(s > 32767 ? 32767 : s < -32768 ? -32768 : s);
    }
}

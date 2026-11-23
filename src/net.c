/* Wi-Fi: (1) fetch Playload's current Arcade list with the system's curl,
           (2) a one-page web server so a phone on the same network can send game links to mygames.txt. */
#include "pl.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define ARCADE_URL "https://raw.githubusercontent.com/kitao/playload/main/data/arcade.json"
#define PORT 8080

/* ---------------- (1) Arcade list ---------------- */
/* curl: Onion keeps it in .tmp_update, spruceOS in spruce/bin; App/Playload/bin/curl is our own, for systems without one (sprigUI) */
static const char *curl_bin(const char *dir) {
    static char mine[720]; snprintf(mine, sizeof mine, "%s/bin/curl", dir);
    const char *C[] = { "/mnt/SDCARD/.tmp_update/bin/curl", "/mnt/SDCARD/spruce/bin/curl", mine, "/usr/bin/curl", "/bin/curl" };
    for (int i = 0; i < 5; i++) if (access(C[i], F_OK) == 0) { if (C[i] == mine) chmod(mine, 0755); return C[i]; }
    return 0;
}
static char *slurp(const char *path, long *len) {
    FILE *f = fopen(path, "rb"); if (!f) return 0;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *b = n > 0 && n < 8 * 1024 * 1024 ? malloc((size_t)n + 1) : 0;
    if (b && fread(b, 1, (size_t)n, f) != (size_t)n) { free(b); b = 0; }
    fclose(f);
    if (b) { b[n] = 0; if (len) *len = n; }
    return b;
}
static int count_games(const char *json) { int n = 0; for (const char *p = json; (p = strstr(p, "\"url\"")); p += 5) n++; return n; }
/* start fetching the list in a process of its own (so nothing waits for Wi-Fi). returns its pid, or -1 */
int net_update_begin(const char *dir, int patient) {
    const char *curl = curl_bin(dir);
    if (!curl) return -1;
    char cmd[2400], tls[800];
    const char *v = getenv("VERIFY");
    if (v && !strcmp(v, "0")) snprintf(tls, sizeof tls, "-k"); else snprintf(tls, sizeof tls, "--cacert '%s/cacert.pem'", dir);
    snprintf(cmd, sizeof cmd, "LD_LIBRARY_PATH=/mnt/SDCARD/.tmp_update/lib:/customer/lib:/mnt/SDCARD/miyoo/lib:$LD_LIBRARY_PATH "
             "exec %s -sSL --fail --connect-timeout %d --max-time %d -A Playload-Miyoo %s -o '%s/arcade.new' '%s'", curl, patient ? 15 : 8, patient ? 60 : 40, tls, dir, ARCADE_URL);
    pid_t pid = fork();
    if (pid == 0) { execl("/bin/sh", "sh", "-c", cmd, (char *)0); _exit(127); }
    return (int)pid;
}
/* fetch any URL to a file, in a process of its own. big: a long download (no overall time limit, gives up when the
   line goes quiet for a minute, continues a partial file). returns the pid, or -1 */
int net_get_begin(const char *dir, const char *url, const char *out, int big) {
    const char *curl = curl_bin(dir);
    if (!curl) return -1;
    for (const char *p = url; *p; p++) if (*p == '\'' || *p == '\\' || (unsigned char)*p < 33) return -1;
    for (const char *p = out; *p; p++) if (*p == '\'' || *p == '\\' || (unsigned char)*p < 32) return -1;
    char cmd[3200], tls[800];
    const char *v = getenv("VERIFY");
    if (v && !strcmp(v, "0")) snprintf(tls, sizeof tls, "-k"); else snprintf(tls, sizeof tls, "--cacert '%s/cacert.pem'", dir);
    snprintf(cmd, sizeof cmd, "LD_LIBRARY_PATH=/mnt/SDCARD/.tmp_update/lib:/customer/lib:/mnt/SDCARD/miyoo/lib:$LD_LIBRARY_PATH "
             "exec %s -sSL --fail --connect-timeout 15 %s -A Playload-Miyoo %s -o '%s' '%s'", curl,
             big ? "--speed-limit 200 --speed-time 60 -C -" : "--max-time 40", tls, out, url);
    pid_t pid = fork();
    if (pid == 0) { execl("/bin/sh", "sh", "-c", cmd, (char *)0); _exit(127); }
    return (int)pid;
}
const char *net_why(int status) {
    int e = WIFEXITED(status) ? WEXITSTATUS(status) : 1;
    return e == 0 ? "" : e == 127 ? "No curl on this system." : e == 6 || e == 7 ? "No connection. Is Wi-Fi on?" : e == 28 ? "The download timed out."
         : e == 60 || e == 77 ? "Certificate check failed (is the date right?)" : e == 22 ? "The file is not there (yet)." : "Download failed.";
}
/* the fetch has ended with this wait() status. 0 = arcade.json is in place: msg says how many games, *added how many
   more than before (bundled = how many the built-in list has), *changed whether it differs from the one we had.
   -1 = failed, msg says why. */
int net_update_end(const char *dir, int status, int bundled, char *msg, size_t cap, int *added, int *changed) {
    char tmp[700], dst[700];
    snprintf(tmp, sizeof tmp, "%s/arcade.new", dir); snprintf(dst, sizeof dst, "%s/arcade.json", dir);
    if (added) *added = 0;
    if (changed) *changed = 0;
    if (status != 0) {
        int e = (status >> 8) & 255; unlink(tmp);
        printf("update: curl exit %d\n", e); fflush(stdout);
        snprintf(msg, cap, e == 127 ? "No curl on this system." : e == 6 || e == 7 ? "No connection. Is Wi-Fi on?" : e == 28 ? "The download timed out." : e == 60 || e == 77 ? "Certificate check failed (is the date right?)" : "Download failed (curl error %d).", e);
        return -1;
    }
    long n = 0, on = 0; char *b = slurp(tmp, &n);
    if (!b) { unlink(tmp); snprintf(msg, cap, "The download was empty."); return -1; }
    int games = count_games(b);
    char *first = b; while (*first == ' ' || *first == '\n' || *first == '\r' || *first == '\t') first++;
    int ok = *first == '[' && games > 0 && strstr(b, "#v1.");
    if (!ok) { free(b); unlink(tmp); snprintf(msg, cap, "That did not look like the Arcade list."); return -1; }
    char *old = slurp(dst, &on);
    int before = old ? count_games(old) : bundled, same = old && on == n && !memcmp(old, b, (size_t)n);
    free(old); free(b);
    if (same) { unlink(tmp); snprintf(msg, cap, "%d", games); return 0; }
    if (rename(tmp, dst) != 0) { unlink(tmp); snprintf(msg, cap, "Could not save the list to the card."); return -1; }
    if (added) *added = games > before ? games - before : 0;
    if (changed) *changed = old != 0 || games != before;      /* the first copy of an unchanged list is nothing new */
    snprintf(msg, cap, "%d", games);
    return 0;
}
/* the same, waiting for it (the X button). Blocks for up to a minute. */
int net_update(const char *dir, char *msg, size_t cap) {
    int pid = net_update_begin(dir, 1), status = 127 << 8;
    if (pid < 0) { snprintf(msg, cap, "No curl on this system."); return -1; }
    waitpid(pid, &status, 0);
    return net_update_end(dir, WIFEXITED(status) ? status : 1 << 8, 0, msg, cap, 0, 0);
}

/* ---------------- (2) links from a phone ---------------- */
#define NCLIENT 4
#define REQ_MAX (400 * 1024)          /* a pushed game's source; links are far smaller */
typedef struct { int fd; size_t len, cap; char *buf; } Client;
static int g_listen = -1, g_count, g_dev;
static char *g_run;                         /* source waiting to be started */
static char *g_code; static unsigned g_code_id;   /* a game handed to the editor ("Open in Dev"), and which one */
static char g_state[16] = "idle", g_note[400]; static double g_tick; static char g_addr[64]; static Client g_cl[NCLIENT];

static void nonblock(int fd) { int fl = fcntl(fd, F_GETFL, 0); if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK); }
const char *srv_addr(void) { return g_listen >= 0 ? g_addr : ""; }
int srv_count(void) { return g_count; }
void srv_stop(void) {
    for (int i = 0; i < NCLIENT; i++) if (g_cl[i].fd > 0) { close(g_cl[i].fd); g_cl[i].fd = 0; }
    g_dev = 0;
    if (g_listen >= 0) close(g_listen);
    g_listen = -1;
}
/* 0 = listening; srv_addr() is "192.168.1.23:8080". -1 = no network address or the port is taken */
int srv_start(void) {
    srv_stop(); g_count = 0; g_addr[0] = 0;
    /* which of our addresses faces the local network: ask the routing table, nothing is sent */
    int u = socket(AF_INET, SOCK_DGRAM, 0); struct sockaddr_in a; socklen_t al = sizeof a;
    memset(&a, 0, sizeof a); a.sin_family = AF_INET; a.sin_port = htons(9); inet_pton(AF_INET, "192.0.2.1", &a.sin_addr);
    char ip[32] = "";
    if (u >= 0 && connect(u, (struct sockaddr *)&a, sizeof a) == 0 && getsockname(u, (struct sockaddr *)&a, &al) == 0) inet_ntop(AF_INET, &a.sin_addr, ip, sizeof ip);
    if (u >= 0) close(u);
    if (!ip[0] || !strncmp(ip, "127.", 4) || !strcmp(ip, "0.0.0.0")) return -1;
    int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) return -1;
    int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a); a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(PORT);
    if (bind(s, (struct sockaddr *)&a, sizeof a) != 0 || listen(s, 4) != 0) { close(s); return -1; }
    nonblock(s); g_listen = s;
    snprintf(g_addr, sizeof g_addr, "%s:%d", ip, PORT);
    return 0;
}
static void url_decode(char *s) {
    char *o = s;
    for (; *s; s++) {
        if (*s == '+') *o++ = ' ';
        else if (*s == '%' && s[1] && s[2]) { char h[3] = { s[1], s[2], 0 }; *o++ = (char)strtol(h, 0, 16); s += 2; }
        else *o++ = *s;
    }
    *o = 0;
}
/* the value of one form field, decoded in place inside a copy */
static char *field(const char *body, const char *name) {
    size_t nl = strlen(name);
    for (const char *p = body; p && *p;) {
        const char *e = strchr(p, '&'); size_t len = e ? (size_t)(e - p) : strlen(p);
        if (len > nl && !strncmp(p, name, nl) && p[nl] == '=') {
            char *v = malloc(len - nl); if (!v) return 0;
            memcpy(v, p + nl + 1, len - nl - 1); v[len - nl - 1] = 0; url_decode(v); return v;
        }
        p = e ? e + 1 : 0;
    }
    return 0;
}
static int g_lang;                           /* 1 = the phone page speaks Japanese */
void srv_lang(int ja) { g_lang = ja; }
#define TR(en, ja) (g_lang ? (ja) : (en))
static void reply(int fd, const char *note, int good) {
    static char page[6000], out[6400];
    int n = snprintf(page, sizeof page,
        "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Playload on Miyoo</title>"
        "<style>body{background:#000;color:#dcf5ff;font:16px/1.4 ui-monospace,Menlo,monospace;margin:0;padding:20px;max-width:560px}"
        "h1{font-size:20px;margin:0 0 4px}i{font-style:normal;display:inline-block;width:12px;height:6px;margin-right:2px}"
        "p{color:#8a918a}label{display:block;margin:16px 0 6px;color:#e6c86e}"
        "input,textarea{box-sizing:border-box;width:100%%;background:#000;color:#dcf5ff;border:2px solid #55415f;padding:10px;font:inherit;border-radius:0}"
        "textarea{height:130px;word-break:break-all}button{margin-top:16px;width:100%%;padding:14px;border:0;background:#e6c86e;color:#000;font:inherit;font-weight:700}"
        ".n{margin:16px 0;padding:10px;border:2px solid %s;color:%s}</style></head><body>"
        "<h1>PLAYLOAD &#9654; MIYOO</h1><i style=background:#d77355></i><i style=background:#e6c86e></i><i style=background:#64b964></i><i style=background:#508cd7></i>"
        "%s%s%s%s"
        "<form method=post action=/add><label>%s</label><textarea name=link placeholder='https://kitao.dev/playload/app/#v1...' required></textarea>"
        "<label>%s</label><input name=name maxlength=40><button>%s</button></form>"
        "<p>%s</p></body></html>",
        good ? "#64b964" : "#d77355", good ? "#64b964" : "#d77355", note && good ? "<!--ok-->" : "", note ? "<div class=n>" : "", note ? note : "", note ? "</div>" : "",
        TR("Playload link", "\x50\x6c\x61\x79\x6c\x6f\x61\x64\x20\xe3\x81\xae\xe3\x83\xaa\xe3\x83\xb3\xe3\x82\xaf"), TR("Name (optional)", "\xe5\x90\x8d\xe5\x89\x8d\xef\xbc\x88\xe7\x9c\x81\xe7\x95\xa5\xe5\x8f\xaf\xef\xbc\x89"), TR("SEND TO MIYOO", "\x4d\x49\x59\x4f\x4f\x20\xe3\x81\xab\xe9\x80\x81\xe3\x82\x8b"), TR("In Playload, use Share and copy the link. It appears under MY GAMES when you press B on the Miyoo.", "\x50\x6c\x61\x79\x6c\x6f\x61\x64\x20\xe3\x81\xae\xe3\x80\x8c\xe5\x85\xb1\xe6\x9c\x89\xe3\x80\x8d\xe3\x81\xa7\xe3\x83\xaa\xe3\x83\xb3\xe3\x82\xaf\xe3\x82\x92\xe3\x82\xb3\xe3\x83\x94\xe3\x83\xbc\xe3\x81\x97\xe3\x81\xa6\xe3\x81\x8f\xe3\x81\xa0\xe3\x81\x95\xe3\x81\x84\xe3\x80\x82\x4d\x69\x79\x6f\x6f\x20\xe3\x81\xa7\x20\x42\x20\xe3\x82\x92\xe6\x8a\xbc\xe3\x81\x99\xe3\x81\xa8\xe3\x80\x8c\xe3\x83\x9e\xe3\x82\xa4\xe3\x82\xb2\xe3\x83\xbc\xe3\x83\xa0\xe3\x80\x8d\xe3\x81\xab\xe8\xa1\xa8\xe7\xa4\xba\xe3\x81\x95\xe3\x82\x8c\xe3\x81\xbe\xe3\x81\x99\xe3\x80\x82"));
    int h = snprintf(out, sizeof out, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", n);
    memcpy(out + h, page, (size_t)n);
    size_t total = (size_t)(h + n), sent = 0;
    int fl = fcntl(fd, F_GETFL, 0); if (fl >= 0) fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);   /* a few KB to a LAN client: just send it */
    while (sent < total) { ssize_t k = send(fd, out + sent, total - sent, MSG_NOSIGNAL); if (k <= 0) break; sent += (size_t)k; }
}
static void add_game(int fd, const char *body, const char *dir) {
    char *link = field(body, "link"), *name = field(body, "name");
    const char *why = TR("Paste a Playload link first.", "\xe5\x85\x88\xe3\x81\xab\x20\x50\x6c\x61\x79\x6c\x6f\x61\x64\x20\xe3\x81\xae\xe3\x83\xaa\xe3\x83\xb3\xe3\x82\xaf\xe3\x82\x92\xe8\xb2\xbc\xe3\x82\x8a\xe4\xbb\x98\xe3\x81\x91\xe3\x81\xa6\xe3\x81\x8f\xe3\x81\xa0\xe3\x81\x95\xe3\x81\x84\xe3\x80\x82"); int ok = 0;
    char *h = link ? strstr(link, "#v1.") : 0; if (link && !h) h = strstr(link, "#1.");
    if (h) {
        h[strcspn(h, " \r\n\t")] = 0;
        char *src = payload_decode(h, 0, &why);
        if (src) {
            free(src);
            if (name) for (char *p = name; *p; p++) if (*p == '|' || *p == '\r' || *p == '\n' || *p == '#') *p = ' ';
            char path[700]; snprintf(path, sizeof path, "%s/mygames.txt", dir);
            FILE *f = fopen(path, "a");
            if (f) {
                if (name && name[strspn(name, " ")]) fprintf(f, "\n%s | https://kitao.dev/playload/app/%s\n", name + strspn(name, " "), h);
                else fprintf(f, "\nhttps://kitao.dev/playload/app/%s\n", h);
                fclose(f); ok = 1; g_count++;
                printf("phone: received a game (%d bytes of link)\n", (int)strlen(h)); fflush(stdout);
            } else why = TR("The Miyoo could not write to its card.", "\x4d\x69\x79\x6f\x6f\x20\xe3\x81\x8c\x20\x53\x44\x20\xe3\x82\xab\xe3\x83\xbc\xe3\x83\x89\xe3\x81\xab\xe6\x9b\xb8\xe3\x81\x8d\xe8\xbe\xbc\xe3\x82\x81\xe3\x81\xbe\xe3\x81\x9b\xe3\x82\x93\xe3\x81\xa7\xe3\x81\x97\xe3\x81\x9f\xe3\x80\x82");
        }
    } else if (link && link[0]) why = TR("That is not a Playload link (it should contain #v1.).", "\x50\x6c\x61\x79\x6c\x6f\x61\x64\x20\xe3\x81\xae\xe3\x83\xaa\xe3\x83\xb3\xe3\x82\xaf\xe3\x81\xa7\xe3\x81\xaf\xe3\x81\x82\xe3\x82\x8a\xe3\x81\xbe\xe3\x81\x9b\xe3\x82\x93\xef\xbc\x88\x23\x76\x31\x2e\x20\xe3\x82\x92\xe5\x90\xab\xe3\x82\x80\xe3\x81\xaf\xe3\x81\x9a\xe3\x81\xa7\xe3\x81\x99\xef\xbc\x89\xe3\x80\x82");
    reply(fd, ok ? TR("Sent. Paste another, or press B on the Miyoo.", "\xe9\x80\x81\xe4\xbf\xa1\xe3\x81\x97\xe3\x81\xbe\xe3\x81\x97\xe3\x81\x9f\xe3\x80\x82\xe7\xb6\x9a\xe3\x81\x91\xe3\x81\xa6\xe8\xb2\xbc\xe3\x82\x8a\xe4\xbb\x98\xe3\x81\x91\xe3\x82\x8b\xe3\x81\x8b\xe3\x80\x81\x4d\x69\x79\x6f\x6f\x20\xe3\x81\xa7\x20\x42\x20\xe3\x82\x92\xe6\x8a\xbc\xe3\x81\x97\xe3\x81\xa6\xe3\x81\x8f\xe3\x81\xa0\xe3\x81\x95\xe3\x81\x84\xe3\x80\x82") : why, ok);
    free(link); free(name);
}
/* call every frame while the phone screen is up */
/* ---------------- (3) the dev panel: write a game in a browser on the same network, press Run, it plays here ---------------- */
/* put a game's source in the editor of whoever opens the dev page next (NULL = nothing) */
void srv_code(const char *src) { free(g_code); g_code = src ? strdup(src) : 0; g_code_id = (unsigned)time(0); }
void srv_dev(int on) { g_dev = on; if (on) { snprintf(g_state, sizeof g_state, "idle"); g_note[0] = 0; } }
int srv_is_dev(void) { return g_listen >= 0 && g_dev; }
/* the pushed source, once. malloc'd, or NULL */
char *srv_take_run(void) { char *r = g_run; g_run = 0; return r; }
void srv_status(const char *state, const char *note, double tick_ms) {
    if (state) snprintf(g_state, sizeof g_state, "%s", state);
    if (note) snprintf(g_note, sizeof g_note, "%s", note);
    g_tick = tick_ms;
}
static void send_all(int fd, const char *head, const char *body, size_t n) {
    int fl = fcntl(fd, F_GETFL, 0); if (fl >= 0) fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
    size_t hn = strlen(head), sent = 0;
    while (sent < hn) { ssize_t k = send(fd, head + sent, hn - sent, MSG_NOSIGNAL); if (k <= 0) return; sent += (size_t)k; }
    for (sent = 0; sent < n;) { ssize_t k = send(fd, body + sent, n - sent, MSG_NOSIGNAL); if (k <= 0) return; sent += (size_t)k; }
}
static void send_text(int fd, const char *type, const char *body, size_t n) {
    char head[200]; snprintf(head, sizeof head, "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %u\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", type, (unsigned)n);
    send_all(fd, head, body, n);
}
static void send_json(int fd, const char *json) { send_text(fd, "application/json", json, strlen(json)); }
static void send_status(int fd) {
    char json[1200], esc[900]; size_t k = 0;
    for (const unsigned char *p = (const unsigned char *)g_note; *p && k < sizeof esc - 8; p++) {
        if (*p == '"' || *p == '\\') { esc[k++] = '\\'; esc[k++] = (char)*p; }
        else if (*p < 32) esc[k++] = ' ';
        else esc[k++] = (char)*p;
    }
    esc[k] = 0;
    int n = snprintf(json, sizeof json, "{\"state\":\"%s\",\"note\":\"%s\",\"tick\":%.2f,\"code\":%u}", g_state, esc, g_tick, g_code ? g_code_id : 0);
    send_text(fd, "application/json", json, (size_t)n);
}
static void send_file(int fd, const char *dir, const char *name, const char *type) {
    char path[700]; snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "rb"); char *b = 0; long n = 0;
    if (f) { fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET); if (n > 0 && n < 2 * 1024 * 1024 && (b = malloc((size_t)n))) n = (long)fread(b, 1, (size_t)n, f); fclose(f); }
    if (b) send_text(fd, type, b, (size_t)n); else { static const char m[] = "that file is missing from the app folder"; send_text(fd, "text/plain", m, sizeof m - 1); }
    free(b);
}

void srv_poll(const char *dir) {
    if (g_listen < 0) return;
    for (;;) {
        int c = accept(g_listen, 0, 0); if (c < 0) break;
        int slot = -1; for (int i = 0; i < NCLIENT; i++) if (g_cl[i].fd <= 0) { slot = i; break; }
        if (slot < 0) { close(c); continue; }
        nonblock(c); g_cl[slot].fd = c; g_cl[slot].len = 0;
    }
    for (int i = 0; i < NCLIENT; i++) {
        Client *c = &g_cl[i]; if (c->fd <= 0) continue;
        int done = 0;
        for (;;) {                                   /* take everything that has arrived */
            if (c->len + 4096 + 1 > c->cap) {
                size_t cap = c->cap ? c->cap * 2 : 16384; char *nb = cap <= REQ_MAX + 8192 ? realloc(c->buf, cap) : 0;
                if (!nb) { done = 1; break; }
                c->buf = nb; c->cap = cap;
            }
            ssize_t k = recv(c->fd, c->buf + c->len, c->cap - c->len - 1, 0);
            if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
            if (k <= 0) { done = 1; break; }
            c->len += (size_t)k;
        }
        if (!c->buf) { close(c->fd); c->fd = 0; continue; }
        c->buf[c->len] = 0;
        char *body = c->len ? strstr(c->buf, "\r\n\r\n") : 0;
        if (body) {
            body += 4;
            size_t want = 0, have = c->len - (size_t)(body - c->buf);
            char *cl = strcasestr(c->buf, "content-length:");
            if (cl && cl < body) want = (size_t)atol(cl + 15);
            if (have < want && want <= REQ_MAX && !done) continue;       /* the rest is still on its way */
            if (!strncmp(c->buf, "POST /add", 9)) add_game(c->fd, body, dir);
            else if (!strncmp(c->buf, "POST /run", 9)) {
                if (!g_dev) send_json(c->fd, "{\"ok\":false,\"why\":\"Open the Dev panel on the Miyoo first.\"}");
                else if (want > REQ_MAX || have < want) send_json(c->fd, "{\"ok\":false,\"why\":\"Too large.\"}");
                else {
                    free(g_run); g_run = malloc(have + 1);
                    if (g_run) { memcpy(g_run, body, have); g_run[have] = 0; }
                    snprintf(g_state, sizeof g_state, "starting"); g_note[0] = 0;
                    printf("dev: received %u bytes of source\n", (unsigned)have); fflush(stdout);
                    send_json(c->fd, "{\"ok\":true}");
                }
            }
            else if (!strncmp(c->buf, "GET /status", 11)) send_status(c->fd);
            else if (!strncmp(c->buf, "GET /examples", 13)) send_file(c->fd, dir, "examples.json", "application/json");
            else if (!strncmp(c->buf, "GET /code", 9)) {      /* first line: which hand-over this is; then the source */
                size_t n = g_code ? strlen(g_code) : 0; char *b = malloc(n + 32);
                if (b) { int h = snprintf(b, 32, "%u\n", g_code ? g_code_id : 0); if (n) memcpy(b + h, g_code, n); send_text(c->fd, "text/plain; charset=utf-8", b, (size_t)h + n); free(b); }
            }
            else if (!strncmp(c->buf, "GET /dev", 8)) send_file(c->fd, dir, "dev.html", "text/html; charset=utf-8");
            else if (!strncmp(c->buf, "GET / ", 6) || !strncmp(c->buf, "GET /?", 6) || !strncmp(c->buf, "GET /add", 8)) reply(c->fd, 0, 1);
            else { static const char nf[] = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"; send(c->fd, nf, sizeof nf - 1, MSG_NOSIGNAL); }
            done = 1;
        }
        if (done) { close(c->fd); c->fd = 0; c->len = 0; }
    }
}

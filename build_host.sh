#!/bin/sh
# desktop test build (no SDL)
set -e
cd "$(dirname "$0")"
Q=${QJS:-$HOME/quickjs}
mkdir -p build/host out
QF="-O2 -D_GNU_SOURCE -DQUICKJS_NG_BUILD -funsigned-char -w"
for f in quickjs libregexp libunicode dtoa; do [ -f build/host/$f.o ] || gcc $QF -c $Q/$f.c -o build/host/$f.o; done
gcc -O2 -Wall -Wextra -DHOST -I$Q -Isrc src/pl.c src/js_quickjs.c src/ay.c src/payload.c src/net.c src/ui.c src/qr.c build/host/*.o -lm -lpthread -o build/host/playload

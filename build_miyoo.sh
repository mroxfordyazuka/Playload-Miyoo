#!/bin/sh
# Cross-compile for the Miyoo Mini / Mini Plus (armhf, glibc) with the miyoomini toolchain (gcc 8.3).
#   TC=/path/to/miyoomini-toolchain  QJS=/path/to/quickjs-ng  ./build_miyoo.sh
set -e
cd "$(dirname "$0")"
TC=${TC:-$HOME/miyoomini-toolchain}
Q=${QJS:-$HOME/quickjs}
CC=$TC/bin/arm-linux-gnueabihf-gcc
ARCH="-marm -mcpu=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard"
mkdir -p build/miyoo
QF="$ARCH -O2 -std=gnu11 -D_GNU_SOURCE -DQUICKJS_NG_BUILD -DNDEBUG -funsigned-char -fno-strict-aliasing -w"
for f in quickjs libregexp libunicode dtoa; do [ -f build/miyoo/$f.o ] || $CC $QF -c $Q/$f.c -o build/miyoo/$f.o; done
$CC $ARCH -O2 -std=gnu11 -D_GNU_SOURCE -Wall -Isrc -c src/pl.c -o build/miyoo/pl.o
$CC $ARCH -O2 -std=gnu11 -D_GNU_SOURCE -Wall -I$Q -Isrc -c src/js_quickjs.c -o build/miyoo/js_quickjs.o
$CC $ARCH -O3 -ffast-math -std=gnu11 -Wall -Isrc -c src/ay.c -o build/miyoo/ay.o
$CC $ARCH -O2 -std=gnu11 -Wall -Isrc -c src/payload.c -o build/miyoo/payload.o
$CC $ARCH -O2 -std=gnu11 -D_GNU_SOURCE -Wall -Isrc -c src/net.c -o build/miyoo/net.o
$CC $ARCH -O2 -std=gnu11 -Wall -Isrc -c src/ui.c -o build/miyoo/ui.o
$CC $ARCH -O2 -std=gnu11 -Wall -Isrc -c src/qr.c -o build/miyoo/qr.o
$CC $ARCH -o build/miyoo/playload build/miyoo/*.o -lSDL -lm -lpthread -Wl,--as-needed
$TC/bin/arm-linux-gnueabihf-strip build/miyoo/playload
ls -la build/miyoo/playload

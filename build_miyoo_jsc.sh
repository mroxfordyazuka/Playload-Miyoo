#!/bin/sh
# Cross-compile the JavaScriptCore (JIT) build for the Miyoo Mini / Mini Plus.
# Needs: JavaScriptCore built for armv7 (WebKit webkitgtk-2.38.6, PORT=JSCOnly, static, see README-JIT.txt) and ICU 69 for arm.
set -e
cd "$(dirname "$0")"
TC=${TC:-$HOME/miyoomini-toolchain}
J=${JSC:-$HOME/jsc-arm}; I=${ICU:-$HOME/icu-arm}
CC=$TC/bin/arm-linux-gnueabihf-gcc; CXX=$TC/bin/arm-linux-gnueabihf-g++
ARCH="-mcpu=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard"
INC="-I$J/JavaScriptCore/Headers"
mkdir -p build/miyoojsc
$CXX $ARCH -mthumb -O2 -std=c++17 -Wall -Isrc $INC -c src/js_jsc.cpp -o build/miyoojsc/js_jsc.o
$CC $ARCH -marm -O2 -std=gnu11 -D_GNU_SOURCE -Wall -Isrc -c src/pl.c -o build/miyoojsc/pl.o
$CC $ARCH -marm -O3 -ffast-math -std=gnu11 -Wall -Isrc -c src/ay.c -o build/miyoojsc/ay.o
$CC $ARCH -marm -O2 -std=gnu11 -Wall -Isrc -c src/payload.c -o build/miyoojsc/payload.o
$CC $ARCH -marm -O2 -std=gnu11 -D_GNU_SOURCE -Wall -Isrc -c src/net.c -o build/miyoojsc/net.o
$CC $ARCH -marm -O2 -std=gnu11 -Wall -Isrc -c src/ui.c -o build/miyoojsc/ui.o
$CC $ARCH -marm -O2 -std=gnu11 -Wall -Isrc -c src/qr.c -o build/miyoojsc/qr.o
$CXX $ARCH -o build/miyoojsc/playload-jit build/miyoojsc/*.o -Wl,--start-group $J/lib/libJavaScriptCore.a $J/lib/libWTF.a -Wl,--end-group \
  $I/lib/libicui18n.a $I/lib/libicuuc.a $I/lib/libicudata.a -static-libstdc++ -static-libgcc -Wl,-Bstatic -lstdc++fs -latomic -Wl,-Bdynamic -lSDL -lpthread -ldl -lm -Wl,--as-needed -Wl,--gc-sections
$TC/bin/arm-linux-gnueabihf-strip build/miyoojsc/playload-jit
ls -la build/miyoojsc/playload-jit

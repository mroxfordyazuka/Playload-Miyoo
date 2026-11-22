#!/bin/sh
# desktop test build with JavaScriptCore instead of QuickJS
set -e
cd "$(dirname "$0")"
J=${JSC:-$HOME/jsc-host}; I=${ICU:-$HOME/icu-host}
INC="-I$J/JavaScriptCore/Headers -I$J/JavaScriptCore/PrivateHeaders"
mkdir -p build/hostjsc
g++ -O2 -std=c++17 -Wall -Isrc $INC -c src/js_jsc.cpp -o build/hostjsc/js_jsc.o
gcc -O2 -Wall -DHOST -Isrc -c src/pl.c -o build/hostjsc/pl.o
gcc -O2 -Isrc -c src/ay.c -o build/hostjsc/ay.o
gcc -O2 -Isrc -c src/payload.c -o build/hostjsc/payload.o
gcc -O2 -D_GNU_SOURCE -Isrc -c src/net.c -o build/hostjsc/net.o
gcc -O2 -Isrc -c src/ui.c -o build/hostjsc/ui.o
gcc -O2 -w -Isrc -c src/qr.c -o build/hostjsc/qr.o
g++ -o build/hostjsc/playload build/hostjsc/*.o -Wl,--start-group $J/lib/libJavaScriptCore.a $J/lib/libWTF.a $([ -f $J/lib/libbmalloc.a ] && echo $J/lib/libbmalloc.a) -Wl,--end-group \
  $I/lib/libicui18n.a $I/lib/libicuuc.a $I/lib/libicudata.a -lpthread -ldl -latomic -lm
ls -la build/hostjsc/playload

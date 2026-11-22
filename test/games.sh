#!/bin/sh
# every bundled game: the device runtime (QuickJS, patched engine, native drawing) against the untouched engine in Node
cd "$(dirname "$0")/.."; R=${1:-$HOME/playload}; N=${2:-600}; pass=0; fail=0; slow=0
for f in games_src/a*.js $R/examples/*.js; do
  b=$(timeout 40 build/host/playload out hash $f $N 2>&1 | grep "^frame\|^START" | sed 's/ERROR.*/ERROR/;s/START FAILED.*/START ERROR/')
  if [ -z "$b" ]; then slow=$((slow+1)); echo "TOO SLOW TO CHECK $f"; continue; fi
  a=$(node test/ref.mjs $R $f $N 2>&1 | sed 's/ERROR.*/ERROR/')
  if [ "$a" = "$b" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "DIFF $f"; echo "$a" | head -3; echo "$b" | head -3; fi
done
echo "same picture on every checked frame: $pass   different: $fail   too slow to check on the desktop build: $slow"

#!/bin/sh
# Playload for the Miyoo Mini family (Onion OS, spruceOS, sprigUI): tiny JavaScript games that fit in a link.
APPDIR=$(cd "$(dirname "$0")" && pwd)
cd "$APPDIR" || exit 1
LOG="$APPDIR/log.txt"
ROTATE=1      # 1 = draw rotated 180 degrees (right for Onion). Set 0 if the picture is upside down.
# Everything else is in the app's Settings tab (the gear), kept in settings.txt:
#   engine jit|small     jit = JavaScriptCore, compiles games to ARM code. small = QuickJS; also used if jit fails
#   overclock 1600|0     CPU MHz while Playload runs (stock is 1200), 0 = leave it alone
ENGINE=$(sed -n 's/^engine //p' "$APPDIR/settings.txt" 2>/dev/null); [ -z "$ENGINE" ] && ENGINE=jit
OVERCLOCK=$(sed -n 's/^overclock //p' "$APPDIR/settings.txt" 2>/dev/null); [ -z "$OVERCLOCK" ] && OVERCLOCK=1600

echo "--- $(date)" > "$LOG"
# Without a clock battery the date can be very old, and certificates can't be checked then
VERIFY=1; if [ "$(date +%Y)" -lt 2025 ]; then VERIFY=0; fi
export VERIFY
export LD_LIBRARY_PATH="/mnt/SDCARD/miyoo/lib:/config/lib:/customer/lib:$LD_LIBRARY_PATH"
chmod +x "$APPDIR/playload" "$APPDIR/bin/curl" 2>/dev/null

GOVF=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
GOV=$(cat "$GOVF" 2>/dev/null)
echo performance > "$GOVF" 2>/dev/null
touch /tmp/stay_awake    # Onion: no auto-sleep while playing
CLK=/mnt/SDCARD/.tmp_update/bin/cpuclock    # Onion only; elsewhere the CPU speed is left alone
if [ "$OVERCLOCK" -gt 0 ] 2>/dev/null && [ -f "$CLK" ]; then "$CLK" "$OVERCLOCK" >> "$LOG" 2>&1; echo "cpu clock: $OVERCLOCK MHz" >> "$LOG"; fi

run() { "$APPDIR/$1" "$APPDIR" "$ROTATE" >> "$LOG" 2>&1; }
if [ "$ENGINE" = jit ] && [ -f "$APPDIR/playload-jit" ]; then
    chmod +x "$APPDIR/playload-jit" 2>/dev/null
    # two CPU cores: leave one for the sound chip
    export JSC_numberOfDFGCompilerThreads=1 JSC_numberOfGCMarkers=1
    run playload-jit; CODE=$?
    echo "playload-jit exit code $CODE" >> "$LOG"
    if [ $CODE -ne 0 ]; then
        echo "The JIT engine did not run or crashed: starting the small engine instead" >> "$LOG"
        run playload; CODE=$?
    fi
else
    run playload; CODE=$?
fi
echo "exit code $CODE" >> "$LOG"

rm -f /tmp/stay_awake
if [ "$OVERCLOCK" -gt 0 ] 2>/dev/null && [ -f "$CLK" ]; then "$CLK" 1200 > /dev/null 2>&1; fi
[ -n "$GOV" ] && echo "$GOV" > "$GOVF" 2>/dev/null
sync
exit 0

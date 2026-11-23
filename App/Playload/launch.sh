#!/bin/sh
# Playload for the Miyoo Mini family (Onion OS, spruceOS, sprigUI): tiny JavaScript games that fit in a link.
{   # the braces make the shell read this whole file before running it, so an update may replace it
APPDIR=$(cd "$(dirname "$0")" && pwd)
cd "$APPDIR" || exit 1
LOG="$APPDIR/log.txt"
ROTATE=1      # 1 = draw rotated 180 degrees (right for Onion). Set 0 if the picture is upside down.
# Everything else is in the app's Settings tab (the gear), kept in settings.txt:
#   engine jit|small     jit = JavaScriptCore, compiles games to ARM code. small = QuickJS; also used if jit fails
#   overclock 1600|0     CPU MHz while Playload runs (stock is 1200), 0 = leave it alone
ENGINE=$(sed -n 's/^engine //p' "$APPDIR/settings.txt" 2>/dev/null); [ -z "$ENGINE" ] && ENGINE=jit
OVERCLOCK=$(sed -n 's/^overclock //p' "$APPDIR/settings.txt" 2>/dev/null); [ -z "$OVERCLOCK" ] && OVERCLOCK=1600

[ "$PLAYLOAD_RESTARTED" = 1 ] || echo "--- $(date)" > "$LOG"

# An update the app downloaded and checked waits in update/files, with update/ready beside it. Move the files into
# place here, where nothing of the app is running. If this is interrupted, the next start finishes the job.
# Returns 0 if something was put in place.
apply_update() {
    [ -f "$APPDIR/update/ready" ] && [ -d "$APPDIR/update/files" ] || return 1      # nothing finished: a half download waits for the app to go on with it
    echo "update: putting version $(cat "$APPDIR/update/ready") in place" >> "$LOG"
    NEWSELF=0
    for f in $(cd "$APPDIR/update/files" && find . -type f | sed 's#^\./##'); do
        if [ "$f" = launch.sh ]; then NEWSELF=1; continue; fi       # this file goes last
        mkdir -p "$APPDIR/$(dirname "$f")"
        mv -f "$APPDIR/update/files/$f" "$APPDIR/$f" || { echo "update: could not replace $f" >> "$LOG"; return 1; }
    done
    if [ $NEWSELF = 1 ]; then mv -f "$APPDIR/update/files/launch.sh" "$APPDIR/launch.sh" || NEWSELF=0; fi
    rm -rf "$APPDIR/update/files" "$APPDIR/update/ready" "$APPDIR/update/for"
    chmod +x "$APPDIR/playload" "$APPDIR/playload-jit" "$APPDIR/bin/curl" "$APPDIR/launch.sh" 2>/dev/null
    sync
    echo "update: done" >> "$LOG"
    if [ $NEWSELF = 1 ]; then PLAYLOAD_RESTARTED=1 PLAYLOAD_GOV="$GOV" exec sh "$APPDIR/launch.sh"; fi
    return 0
}
apply_update

# Without a clock battery the date can be very old, and certificates can't be checked then
VERIFY=1; if [ "$(date +%Y)" -lt 2025 ]; then VERIFY=0; fi
export VERIFY
export LD_LIBRARY_PATH="/mnt/SDCARD/miyoo/lib:/config/lib:/customer/lib:$LD_LIBRARY_PATH"
chmod +x "$APPDIR/playload" "$APPDIR/bin/curl" 2>/dev/null

GOVF=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
GOV=${PLAYLOAD_GOV:-$(cat "$GOVF" 2>/dev/null)}    # what to put back at the end
echo performance > "$GOVF" 2>/dev/null
touch /tmp/stay_awake    # Onion: no auto-sleep while playing
CLK=/mnt/SDCARD/.tmp_update/bin/cpuclock    # Onion only; elsewhere the CPU speed is left alone
if [ "$OVERCLOCK" -gt 0 ] 2>/dev/null && [ -f "$CLK" ]; then "$CLK" "$OVERCLOCK" >> "$LOG" 2>&1; echo "cpu clock: $OVERCLOCK MHz" >> "$LOG"; fi

run() { "$APPDIR/$1" "$APPDIR" "$ROTATE" >> "$LOG" 2>&1; }
while :; do
    if [ "$ENGINE" = jit ] && [ -f "$APPDIR/playload-jit" ]; then
        chmod +x "$APPDIR/playload-jit" 2>/dev/null
        # two CPU cores: leave one for the sound chip
        export JSC_numberOfDFGCompilerThreads=1 JSC_numberOfGCMarkers=1
        run playload-jit; CODE=$?
        echo "playload-jit exit code $CODE" >> "$LOG"
        if [ $CODE -ne 0 ] && [ $CODE -ne 42 ]; then
            echo "The JIT engine did not run or crashed: starting the small engine instead" >> "$LOG"
            run playload; CODE=$?
        fi
    else
        run playload; CODE=$?
    fi
    echo "exit code $CODE" >> "$LOG"
    # 42: the app downloaded an update and left so it can be put in place; then start it again
    if [ $CODE -eq 42 ] && apply_update; then continue; fi
    break
done

rm -f /tmp/stay_awake
if [ "$OVERCLOCK" -gt 0 ] 2>/dev/null && [ -f "$CLK" ]; then "$CLK" 1200 > /dev/null 2>&1; fi
[ -n "$GOV" ] && echo "$GOV" > "$GOVF" 2>/dev/null
sync
exit 0
}

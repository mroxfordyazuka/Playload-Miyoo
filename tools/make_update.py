#!/usr/bin/env python3
"""Write update.txt, the list the app's own updater reads (see "updating the app itself" in src/pl.c).

    python3 tools/make_update.py <commit>      (the commit whose App/Playload files are the release; default: HEAD)

Release order: 1. commit the new App/Playload files  2. run this  3. commit update.txt  4. push.
Apps in the field read update.txt from the main branch, then take the files from <commit>."""
import os, re, subprocess, sys, zlib

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = os.path.join(root, 'App', 'Playload')
commit = sys.argv[1] if len(sys.argv) > 1 else subprocess.check_output(['git', '-C', root, 'rev-parse', 'HEAD'], text=True).strip()
version = re.search(r'#define APP_VERSION "([^"]+)"', open(os.path.join(root, 'src', 'version.h')).read()).group(1)
# the user's own files are never part of an update
skip = {'mygames.txt', 'favorites.txt', 'settings.txt', 'state.txt', 'log.txt', 'arcade.json', '.DS_Store'}
lines = ['playload-miyoo-update 1', 'version ' + version,
         'base https://raw.githubusercontent.com/mroxfordyazuka/Playload-Miyoo/%s/App/Playload/' % commit]
total = 0
for folder, dirs, names in sorted(os.walk(app)):
    dirs[:] = sorted(d for d in dirs if d != 'update')
    for name in sorted(names):
        rel = os.path.relpath(os.path.join(folder, name), app).replace(os.sep, '/')
        if name in skip or name.startswith('._'):
            continue
        data = open(os.path.join(folder, name), 'rb').read()
        if not re.fullmatch(r'[A-Za-z0-9._/-]+', rel):
            sys.exit('a file name the updater will not accept: ' + rel)
        lines.append('file %08x %d %s' % (zlib.crc32(data) & 0xffffffff, len(data), rel))
        total += len(data)
open(os.path.join(root, 'update.txt'), 'w').write('\n'.join(lines) + '\n')
print('update.txt: version %s, %d files, %.1f MB, from commit %s' % (version, len(lines) - 3, total / 1048576, commit))

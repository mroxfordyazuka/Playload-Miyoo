PLAYLOAD for the Miyoo Mini family
Playload (kitao.dev/playload, by Takashi Kitao) is a tiny game engine: 160 x 144, 8 colors, 3 sound channels,
and a whole game fits in a link. This runs those games on the Miyoo. Unofficial port by 0kCyb0rg.
Source and updates: github.com/mroxfordyazuka/Playload-Miyoo

INSTALL
  Copy the App folder to the root of the SD card (merge folders). Open "Playload" from the Apps menu.
  Works on the Miyoo Mini Plus with Onion OS. Other Minis, the Flip, spruceOS and sprigUI are untested.

CONTROLS
  In the list:  up / down: choose     left / right: a page up / down     L / R: Arcade, Favorites, My Games, Dev, Settings
                A: play (or change a setting)       MENU: quit
                Y: add the game to Favorites, or take it out
                X on Arcade: update the list over Wi-Fi     X on Favorites: remove     X on My Games: delete
  In a game:    D-pad and A, B are Playload's six buttons (X is a second A, Y a second B)
                START: the pause menu (resume, favorite, open in Dev, back to the list)
                SELECT: scanlines on / off          MENU: straight back to the list

TABS
  Arcade     The games from Playload's Arcade. With Wi-Fi the app looks for new ones when it starts
             (Settings can turn that off); X fetches the list now. HEAVY marks the few 3D games that are
             too much arithmetic for this CPU.
  Favorites  Press Y on any game to keep it here. Kept in favorites.txt.
  My Games   Your own links, kept in mygames.txt ("Name | link" per line). The first row shows a QR code:
             scan it with a phone on the same Wi-Fi, paste a Playload link, send.
  Dev        "Start the dev panel..." shows an address. Open it in a browser on the same Wi-Fi, write a
             game, press Run on Miyoo: it plays here. Save to My Games keeps it. Under it are Kitao's
             examples to play; "Open in Dev" in a game's pause menu puts its code in the editor.
  Settings   Language (English / Japanese), scanlines, the frame around games, theme, letters, volume,
             engine, CPU speed (Onion only), looking for new games at start.

UPDATES
  With Wi-Fi the app also looks for a newer version of itself when it starts and tells you if there is one.
  Settings > "Update Playload..." downloads it (it asks first, and shows how big it is), checks every file, and
  restarts into the new version. Your games, favorites and settings are not touched. The files come from
  github.com/mroxfordyazuka/Playload-Miyoo. Without Wi-Fi, copy a newer App folder over this one instead.

GOOD TO KNOW
  - Two engines: "JIT" (JavaScriptCore, compiles games to ARM code, about twice as fast) and "Small"
    (QuickJS). If the JIT one fails to start, the small one is used.
  - Japanese on the Miyoo is written in kana with spaces: Playload's 8x8 characters have no kanji.
  - log.txt in this folder is written on every run; include it when reporting a problem.
  - A game that hangs is stopped after a few seconds and you are returned to the list.

LICENSES
  See the licenses folder. Playload: MIT, Takashi Kitao. Arcade games belong to their authors.
  playload-jit contains JavaScriptCore (LGPL 2.1): the source and the libraries to relink it are at
  github.com/mroxfordyazuka/Playload-Miyoo and github.com/mroxfordyazuka/jsc-miyoo.

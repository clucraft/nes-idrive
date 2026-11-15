#!/bin/sh
# The bundled cartridges, app/games/*.nes, from games/src: needs cc65 (ca65, ld65) and Node.js.
#   sh games/build.sh        (npm run build:games)
# The files it writes are committed, so the app builds without cc65. A build gives the same bytes.
set -e
cd "$(dirname "$0")"
command -v ca65 >/dev/null 2>&1 && command -v ld65 >/dev/null 2>&1 || {
    echo "build.sh: ca65 and ld65 (the cc65 package) are needed: apt install cc65, brew install cc65, or https://cc65.github.io" >&2
    exit 1
}
mkdir -p obj ../app/games
node mkchr.js obj/font.chr
build() {    # <source name> <file name of the game>
    ca65 -I src --bin-include-dir obj -o "obj/$1.o" "src/$1.s"
    ld65 -C src/nrom.cfg -o "../app/games/$2.nes" "obj/$1.o"
    echo "build.sh: app/games/$2.nes"
}
build pad_test Pad_Test
build snake Snake

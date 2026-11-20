# The games that come with the app

Two small NES cartridges, written for this repository so the app can be tried without a game of one's own. They are the only games in it. Both are under the repository's licence, GPL-2.0-or-later.

| | |
|---|---|
| **Snake** (`src/snake.s`) | Steer the snake to the apples. Only the direction buttons steer, one at a time, so it suits the iDrive controller's push. Start pauses. |
| **Pad Test** (`src/pad_test.s`) | Shows what the game gets from the pad: each button lights while it is held and counts its presses. A clock counts 60 frames a second and a ball crosses the screen one pixel a frame, to see that the picture runs at full speed and evenly. A dotted frame marks the edge of the 224 lines a TV shows. |

On the car, Pad Test is the quickest check of the controls: one press of the controller should count one A, one click to the right one B, one click to the left one Start. Its clock should keep time with a watch.

## Building

```bash
npm run build:games
```

This needs [cc65](https://cc65.github.io) (`ca65` and `ld65`; `apt install cc65`, `brew install cc65`) and Node.js. It writes `app/games/Pad_Test.nes` and `app/games/Snake.nes`. Those files are committed, so the app builds without cc65. A build gives the same bytes each time.

## Files

```
src/common.inc   what both share: the cartridge's header, start-up, the frame interrupt that
                 shows what the game queued, the pad, text
src/pad_test.s   Pad Test
src/snake.s      Snake
src/nrom.cfg     the cartridge's layout for the linker: no mapper, 16 KB of program, 8 KB of tiles
mkchr.js         the tiles: a 5 x 7 letter set and a few pictures, drawn in the file itself
build.sh         builds both into app/games/
```

Each cartridge is 24 KB and has no mapper (NROM).

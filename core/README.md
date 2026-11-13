# The emulator core

`app/nes.wasm` is [libretro-fceumm](https://github.com/libretro/libretro-fceumm) (GPL-2.0-or-later), commit `e0f3086`, **unchanged**, as the submodule `vendor/libretro-fceumm`, compiled to WebAssembly together with one file from here.

## `mgu_libretro.c`

A libretro frontend of some 280 lines. The core runs as WebAssembly inside the app's Node.js process; JavaScript (`app/nes-core.js`) hands it the ROM's bytes and the pad's buttons, runs it one frame at a time and takes each picture as RGBA bytes, as the kit's GPU renderer wants them. It also carries:

- the core options (`mgu_set_var`)
- the cropping of the picture's edges
- save states and battery memory, through buffers
- the frame's sound samples, which nothing plays yet

The core needs no files: the C library's file calls are answered "not there" in `nes-core.js`. Nothing in the frontend is specific to FCEUmm, so another libretro core can be built with it.

## `build.sh`

```bash
npm run build:core
```

It needs **zig 0.13** (`pip install ziglang==0.13.0`) and **binaryen 119** (`npm install binaryen@119`, or `WASM_OPT=/path/to/wasm-opt`), the versions the kit builds Doom with. The committed `nes.wasm` is built from exactly this source, and two builds give the same bytes (SHA-256 `607a6d69...8c7b06`).

As for the kit's Doom, it builds for wasm32-wasi with the first version of WebAssembly only (the head unit's Node 8), and binaryen lowers sign-extension and splits 64-bit arguments. Besides:

- **12 MiB of memory from the start, a 2 MiB stack.** zig's default stack is 16 MiB, and Node 8 grows a WebAssembly memory by copying it. With the defaults a game's start left about 80 MB of copies behind, against the app's memory limit. Now the memory never grows for ROMs up to about 2.5 MiB. (`--initial-memory` is given in hex: zig 0.13 reads its number as hexadecimal.)
- **`-Os`, debug sections stripped:** 0.9 MB instead of 7.3 MB, 0.65 MB of code instead of 1.6 MB at `-O2`. Node 8 compiles it in a little over half the time; a frame takes about a sixth longer.
- The core's NTSC filter and HD packs are not built.

## What it was checked against

All on a PC, none of it on a head unit:

- **A native build:** the same sources built for x86-64 and `nes.wasm` under Node 8.17 give the same picture, byte for byte, after 1500 frames with the same pad input, on six test ROMs (NROM, UxROM, MMC1, MMC3 among them).
- **blargg's `official_only` CPU test** passes.
- **Memory:** under Node 8 the app's process holds about 110 MB with a game running. The kit's Doom engine alone, measured the same way: about 165 MB.
- **Speed:** a frame takes under a millisecond of a 2.1 GHz Xeon core.

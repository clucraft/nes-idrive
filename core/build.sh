#!/bin/bash
# build.sh - FCEUmm (vendor/libretro-fceumm) + mgu_libretro.c -> app/nes.wasm (the app's emulator)
#
#   bash core/build.sh        (npm run build:core)
#
# Needs: zig (C compiler for wasm32-wasi, e.g. `pip install ziglang==0.13.0`) and binaryen's wasm-opt
# (e.g. `npm install binaryen@119`). Override with ZIG="zig" / WASM_OPT=/path/to/wasm-opt.
# The car runs Node 8: WebAssembly MVP only, so sign-extension opcodes are lowered and 64-bit
# arguments of imports/exports are split for JavaScript (--legalize-js-interface), as the kit does for
# Doom (vendor/idrive7-apps third_party/doomgeneric/build.sh).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-"python3 -m ziglang"}
WASM_OPT=${WASM_OPT:-wasm-opt}
ROOT=$(cd "$HERE/.." && pwd)
OUT=${OUT:-$ROOT/app/nes.wasm}
CORE=${CORE:-$ROOT/vendor/libretro-fceumm/src}
if [ ! -f "$CORE/fceu.c" ]; then echo "build.sh: $CORE is empty - run: git submodule update --init" >&2; exit 1; fi
COMM=$CORE/drivers/libretro/libretro-common
# The core's memory, all of it from the start: 12 MiB (about 3.5 MiB of the core's own data, a 2 MiB stack, the
# rest for the ROM and the core's buffers). Node 8 grows a WebAssembly memory by making a bigger copy, and the
# copies it leaves behind count against the app's memory limit; a ROM over ~2.5 MiB still loads, by growing.
# In hex: zig 0.13 reads the number after --initial-memory= as hexadecimal with or without the 0x.
INITIAL_MEMORY=${INITIAL_MEMORY:-0xC00000}
STACK_SIZE=${STACK_SIZE:-2097152}
# -Os: a third of the code of -O2 (0.65 MB against 1.6), so the head unit compiles it faster and in less memory;
# a frame takes about a sixth longer, of well under a millisecond on a PC
OPT=${OPT:--Os}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# the sources of Makefile.common (no NTSC filter, no HD packs)
SRCS="$(ls "$CORE"/boards/*.c "$CORE"/input/*.c)
$CORE/drivers/libretro/libretro.c $CORE/drivers/libretro/libretro_dipswitch.c
$CORE/cart.c $CORE/cheat.c $CORE/crc32.c $CORE/fceu-endian.c $CORE/fceu-memory.c $CORE/fceu.c
$CORE/fds.c $CORE/fds_apu.c $CORE/file.c $CORE/filter.c $CORE/general.c $CORE/input.c $CORE/md5.c
$CORE/nsf.c $CORE/palette.c $CORE/ppu.c $CORE/sound.c $CORE/state.c $CORE/video.c $CORE/vsuni.c
$CORE/ines.c $CORE/unif.c $CORE/x6502.c
$COMM/streams/memory_stream.c
$COMM/compat/compat_posix_string.c $COMM/compat/compat_snprintf.c $COMM/compat/compat_strcasestr.c
$COMM/compat/compat_strl.c $COMM/compat/fopen_utf8.c $COMM/encodings/encoding_utf.c
$COMM/file/file_path.c $COMM/file/file_path_io.c $COMM/streams/file_stream.c
$COMM/streams/file_stream_transforms.c $COMM/string/stdstring.c $COMM/time/rtime.c
$COMM/vfs/vfs_implementation.c"

# shellcheck disable=SC2086
$ZIG cc -target wasm32-wasi -mcpu=mvp -mexec-model=reactor $OPT \
    -D__LIBRETRO__ -DPATH_MAX=1024 -DFCEU_VERSION_NUMERIC=9900 -DFRONTEND_SUPPORTS_RGB888 \
    -D_DEFAULT_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -Wno-everything \
    -I"$CORE/drivers/libretro" -I"$COMM/include" -I"$CORE" -I"$CORE/input" -I"$CORE/boards" \
    -Wl,--initial-memory=$INITIAL_MEMORY -Wl,-z,stack-size=$STACK_SIZE \
    -o "$TMP/nes-raw.wasm" $SRCS "$HERE/mgu_libretro.c" \
    -lwasi-emulated-signal -lwasi-emulated-process-clocks
"$WASM_OPT" "$TMP/nes-raw.wasm" --enable-sign-ext --enable-mutable-globals --legalize-js-interface --signext-lowering --strip-debug --strip-producers $OPT -o "$OUT"
ls -l "$OUT"

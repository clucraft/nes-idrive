# USB gamepad: design notes and what is left to prove

What the feature is and how it limits itself is in [`README.md`](README.md), "A USB gamepad". This file
keeps the reasons behind the design, what a look at a real head unit showed, and the steps that are still
open. **Status (2026-11-19): built, tested against a stand-in for the pad, tried on a real Xbox One S
pad on a PC, where every button and the left stick were read correctly, and then on one car, where the
pad works as the gamepad (both below).**

## What a head unit showed

Read-only, over SSH, on one rooted iDrive 7 unit (kernel `4.14.198-apl`), with an Xbox One S pad
(`045e:02ea`) on a cable in the car's USB port:

- The pad is listed on the USB bus (`New USB device found ... Product: Controller`, 500 mA), so the port
  is a working host.
- **No driver binds it.** The kernel has no HID core, no `usbhid`, no `hidraw`, no `evdev`, no `joydev`,
  no `uinput`, no `xpad`: `/sys/bus/usb/drivers` holds `hub`, `usb` and `usbfs`, and there is no
  `/dev/input` at all. Any pad, of any make, ends up the same way there.
- **usbfs is there:** `/dev/bus/usb/<bus>/<device>`, mode `crw-rw----`, owner `root`, group `mgu_usb`.
- The pad's interface 0 is class `ff`, subclass `47`, protocol `d0` (Microsoft's "GIP"), with two
  interrupt endpoints of 64 bytes: `0x82` in, `0x02` out. That is what `pad.js` looks for.

## Decisions

- **In the loader, not in the app.** The app's user cannot open `/dev/bus/usb/*`. The loader already
  runs as root, started by the app's connection and gone two minutes after it, on a socket only the NES
  app can reach.
- **The program that touches USB knows nothing.** Node 8 cannot make the ioctl calls usbfs needs, so a
  compiled program is unavoidable. `nes-usbpipe` only passes one interface's packets on as lines of hex, in
  both directions. Everything about gamepads is in `pad.js`, where it is tested without a pad and can
  change without the program being built again. Another kind of pad is a second reader in `pad.js`,
  not another program.
- **Asynchronous requests** (`USBDEVFS_SUBMITURB` / `REAPURB`), not the simpler blocking
  `USBDEVFS_BULK`. A blocking read with a timeout can lose the packet that arrives as the timeout
  ends, which here would be a button that stays pressed; without a timeout it waits where no signal
  reaches it, so the program could not be stopped until the next button press.
- **Go, not C.** One file, no library beside Go's own, and the same program from any computer
  (`npm run build:usbpipe`); it depends on nothing of the head unit but the kernel. It is about 1.6 MB,
  where C would be some tens of KB: the price of needing no Linux C toolchain to build it.
- **A program in a Store tool is allowed.** The MGU Store's `docs/PUBLISHING.md`: "Native programs
  ship as tools", prebuilt and committed, run from `/var/opt/<id>/current/`.
- **Not root.** `nes-usbpipe` is started as the NES app's user with the group of the pad's device file.
  The first car test showed that the head unit lets that user open the device. One that refused would
  show as `gamepad: its helper ended (2): nes-usbpipe: ... permission denied` in the journal.
- **Off unless asked for.** With the setting on, the loader runs for as long as a game does, and looks
  at the USB bus every two seconds. Until now nothing of the loader ran unless "Add games from a
  phone" was open; that stays true for everyone who leaves the setting off.
- **The Xbox pad's packets are the kernel's.** The four packets that switch an Xbox One S pad on, the
  layout of its input report and the answer its Xbox button wants are taken from
  `drivers/input/joystick/xpad.c` (`xboxone_init_packets`, `xpadone_process_packet`,
  `xpadone_ack_mode_report`), not from memory. The tests hold them to that.

## The whole pad, for another app

The NES app wants a D-pad and a few buttons, and that is all the loader sends it. Since 0.2.1 `pad.js`
reads the rest of an Xbox pad's report too, for a program that wants a pad with two sticks:
`open(dev, { onState })` tells `{ buttons, lt, rt, lx, ly, rx, ry }` whenever any of it changes.

- `buttons`: the bits of `PAD_FULL`. The D-pad is as it is pressed, with no stick counted into it, and
  `LS` and `RS` are the sticks pressed in.
- `lt`, `rt`: the triggers, 0 to 1023.
- `lx`, `ly`, `rx`, `ry`: the sticks, -32768 to 32767. Right and up are the greater numbers.

`node tools/pad-try.js --state` shows it from a pad on a PC.

- **Seen from the real pad** (the PC captures below): the right trigger from 0 to 1023, the right stick
  to 32767 one way and far out another, and the left stick at both ends of both axes. Those packets are
  in `test/run.js`.
- **Not seen from a pad:** the left trigger and the sticks pressed in. They are read where the kernel
  driver reads them (`xpadone_process_packet`: bytes 6 and 7, and bits 6 and 7 of byte 5).
- **The Xbox button is not in it.** It comes in a packet of its own, which is answered and otherwise
  passed over.
- **A stick at rest is not at 0.** This pad's rested one to three thousand off the middle, and a stick
  let go sprang past the middle (below). A program that uses the numbers needs a dead zone of its own.
- **The loader's socket is the NES app's alone** (`sockgroup.js`), and the pad is read for one
  connection. Another app needs a tool of its own made the same way: a root service on a socket of its
  own app's group, which starts the USB program as that app's user with the group of the pad's device
  file. Its copy of the program should have a file name of its own: the head unit's crash handler knows
  a tool's programs by their file names, and two tools with one name between them have not been tried.
- **Not on a car yet.** The car ran 0.2.0. What 0.2.1 sends the NES app is the same, by the tests.

## Open, in the order to settle them

1. **A real pad on a PC: done, for an Xbox One S pad.** WSL 2's kernel has no driver for the pad, so a
   pad handed to WSL with [usbipd-win](https://github.com/dorssel/usbipd-win) is in the state the head
   unit leaves it in: listed, three `ff`/`47`/`d0` interfaces, no driver. `node tools/pad-try.js --raw`
   finds it there as `pad.js` finds it on the head unit, runs `nes-usbpipe` on it and prints every packet
   (the top of that file has the usbipd commands; this pad needed `bind --force`).

   What that showed on 2026-11-19 (usbipd-win 5.3.0, WSL kernel 6.18):
   - `nes-usbpipe` opened the device, claimed interface 0 and sent the four packets that switch the pad on;
     50 ms later the pad sent its input report, 18 bytes, nothing held;
   - **every button, pressed one at a time by a person, was read as itself:** A, B, X, Y, the D-pad's
     four, Menu, View, LB, RB, and A with D-pad right together. Each press and each release was one
     change, 28 for 14 presses, none missed and none stuck;
   - **the left stick,** held up, down, left and right, was read as those, up being the greater number
     as the kernel driver has it; the right stick and trigger moved where that driver puts them;
   - **the Xbox button** sent its own packet on the press and on the release, each was answered, and
     the pad did not repeat them;
   - every 20 seconds the pad sent a packet starting `03`, which is no report and is passed over;
   - `nes-usbpipe` ended with 0 when its input ended, each time, and ran for 15 minutes without an error.

   Then the whole way in one piece: `npm run emu -- --pad` put the same pad behind the loader beside
   the emulator, and *Pad Test* counted its D-pad's four directions, View, Menu and A as a person
   pressed them. From the pad to the game, only the head unit itself is left out.

   Some of those packets are in `test/run.js` now. One thing to know: let go from full left, the stick
   sprang past the middle far enough (58 %) to be read as *right* for 10 ms. The D-pad has no such
   thing. If it shows in a game, a direction from the stick should have to last a few packets to count.
2. **On the car: done, on one car** (2026-11-19, the head unit looked at above). The app (0.4.0) and
   the loader (0.2.0) installed from the Store, *USB gamepad* switched on, the Xbox One S pad plugged
   in: its owner reports that the gamepad works. Two of the things that could go wrong there and
   nowhere else did not: the Store installed `nes-usbpipe` as a program that runs, and the app's user
   was let at the device. Of the third, the head unit's recovery manager minding the extra process,
   nothing was seen. Not kept from that run: which buttons were tried, whether a pad pulled out and
   plugged in again came back, and the journal (`journalctl -u clucraft-nes-loader` has a `gamepad:`
   line for each step).
3. **Buttons a player would change:** which of A, B, X, Y is the NES pad's A and B is fixed in
   `app/pad.js` (`toNes`). A setting, as the controller's press and turns have, is a small change.
4. **Other pads.** All need a reader in `pad.js`; none needs a kernel driver.
   - Xbox 360 on a cable: no packets to switch it on, a fixed report of 20 bytes. Small.
   - A plain USB (HID) pad, a PlayStation pad on a cable: the report's layout comes from the pad's
     own description of it, which `nes-usbpipe` cannot ask for yet (it passes on no control requests).
     Larger.
   - A wireless pad's dongle: another protocol again.

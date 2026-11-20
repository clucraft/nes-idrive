# NES game loader

A small service for the head unit that lets the [NES app](../README.md) take games from a phone: **Add games from a phone** in the app shows a QR code, the phone opens the page behind it and picks `.nes` files, and they are in the app's menu.

It exists because an app cannot do this on its own: the head unit's firewall drops every connection to an app. The loader is the part that may open a port. It is optional; without it the app works as before, and games come from a USB stick or over SSH.

It also reads a **USB gamepad** for the app, which an app cannot do either: [A USB gamepad](#a-usb-gamepad), below.

> **Tried on one car, in part** (2026-11-19 and 20). There the MGU Store installed the loader, the NES app reached it, and an Xbox One S pad on a cable worked as the gamepad. Games from a phone got as far as the page with 0.2.2: a phone on the home Wi-Fi the car had joined opened it, so the phone got through the head unit's firewall there (by the loader's rule, it is taken: the journal was not read). The game it sent was not saved ("the car could not save it (EACCES)"): the page ran as the wrong user, outside a folder the right one cannot enter from outside either. 0.2.3 mends both and saves a game in a copy of that car's folders on a PC; it has not been on a car yet. The car's own Wi-Fi is untried.

## Using it

1. In the MGU Store, from the source `clucraft/nes-idrive`: install **NES** first, then **NES game loader**.
2. **Restart the head unit once** (the Store's Settings → Restart head unit). The loader's socket is made at a start, and the head unit only then knows the loader as something that may stop without the unit restarting.
3. In the NES app: **Add games from a phone**. With the phone on the same Wi-Fi as the car, scan the code and pick the files. That is the Wi-Fi the car has joined, such as your home Wi-Fi or the phone's own hotspot; or the car's own Wi-Fi, which a phone is on for wireless CarPlay or through the car's hotspot.
4. **BACK** closes the page. The games are in the menu.

The page can also take a game out again. It works while the screen with the code is up, for 15 minutes after the last game at most.

## What runs, and as whom

| | runs as | does |
|---|---|---|
| `service.js` | root | answers the NES app on `/run/clucraft-nes-loader.sock`; puts the page's port into the firewall and takes it out; starts the page; starts `nes-usbpipe` and tells the app the gamepad's buttons |
| `page.js` | the NES app's own user | listens on the car Wi-Fi; checks and writes the games |
| `nes-usbpipe` | the NES app's own user, in the group of the head unit's USB devices | passes a gamepad's USB packets on, while a game runs |

- **Started by the app, never at boot.** systemd starts the service when the NES app connects to the socket. Two minutes after the app is gone it ends. Nothing of it runs while the app's screen was never opened.
- **Only the NES app can ask.** The socket belongs to the NES app's own group (`sockgroup.js`), not to the group every app is in.
- **The port is open only while the screen is up.** One rule per chain, for the Wi-Fi's interfaces and port 8493 only, each with the comment `clucraft-nes-loader`. They go when the app leaves the screen, when the time runs out, when the service stops for any reason (`ExecStopPost`), and when the loader is removed.
- **Which Wi-Fi:** the car's own (`wlan_bridge`, where a phone is for wireless CarPlay or on the car's hotspot), and since 0.2.2 a Wi-Fi the car has joined (`wlan0`, `wlan1`: a home network, a phone's hotspot) when the app asks for it. The app asks while its setting *Add games over the Wi-Fi the car is on* is on, as it is at first; the code on the screen is then for that Wi-Fi. On a joined Wi-Fi the head unit is a guest: whoever else is on that network can reach the port while the screen is up, though not the page without its address. Switch the setting off for a network you do not trust; the page is then on the car's own Wi-Fi alone, as before 0.2.2. The car's other networks are never opened.
- **The address is the key.** The page is at `http://<car Wi-Fi address>:8493/<20 random characters>/`, new each time. Without those characters every request is "not found"; after 100 such requests the page closes. It is plain HTTP, so anyone already on that Wi-Fi who sees the code can use it for as long as it is up.
- **The page is not root.** It runs as the user the NES app runs as, so it can write where the app can and nowhere else. That user is the number in the name of the app's folder (`oap_<number>`); the folder's owner is whoever installed the app, the MGU Store's user on a car, and till 0.2.3 the loader took that one. The page is started inside the app's data folder, because the app's user alone does not get there: the way leads through a folder that opens only to a group the head unit gives its apps' processes, and a process started as another user keeps no such group.
- **What it takes:** files that start as an iNES file does, 8 MB at most, 64 MB and 1000 games in all, under a name with folders and odd characters taken out, ending in `.nes`. They go to the app's `data/roms/` folder, which the service finds itself; a request cannot name a folder.
- **It cannot restart the head unit by crashing.** No core file reaches the head unit's crash handler (`LimitCORE=1`), the Store lists the units with the head unit's recovery manager, and a service that keeps failing to start is left stopped.

## A USB gamepad

The head unit's kernel has no driver for a gamepad: no HID, no input events, no joystick driver. A pad plugged into the car's USB port is listed on the bus and nothing more, and an app may not open USB devices. So, with the app's setting **USB gamepad** on (it is off at first):

1. While a game runs, the app asks the loader for a pad (`{"cmd":"pad"}` on the same socket).
2. The loader looks for one on the USB bus every two seconds: an interface of class `ff`, subclass `47`, protocol `d0`, which is an Xbox One or Xbox Series pad on a cable, or another make's pad for that console.
3. It starts `nes-usbpipe` on it. That program knows nothing about gamepads: it passes the packets of one USB interface on as lines of text, in both directions, through the kernel's usbfs.
4. `pad.js` sends the packets that switch the pad on, reads its reports, and the loader tells the app the buttons whenever they change. The packets and the report's layout are those of the Linux kernel's own driver (`drivers/input/joystick/xpad.c`).
5. When the game stops, the app leaves, or the pad is pulled out, `nes-usbpipe` ends. Nothing reads the USB bus while no game runs.

- **Not root.** `nes-usbpipe` runs as the NES app's user, in the group the head unit gives its USB device files to. It opens the one device the loader names and unbinds no driver.
- **No port, no firewall rule.** The buttons go over the socket only the NES app can reach.
- **A pad that cannot be read is left alone** after five tries in a row, until the next game.
- **The NES app gets a part of the pad:** its D-pad, with the left stick counted as one, and its buttons. `pad.js` reads the rest too, for a program that wants a pad with two sticks: both sticks, both triggers and the sticks pressed in (`onState` of its `open`). None of that goes over the loader's socket. `node tools/pad-try.js --state` shows it from a pad on a PC, and [`CONTROLLER-HELPER.md`](CONTROLLER-HELPER.md) says what of it a real pad has shown.
- **`nes-usbpipe` is a program, not a script:** Node.js has no way to talk to usbfs. It is built from `src/nes-usbpipe/main.go`, one file with no library beside Go's own, by `npm run build:usbpipe` on any computer, and is committed here as the Store installs it. It needs nothing of the head unit but its kernel.

What has run, on a PC: the meaning of the packets against the kernel driver's, the pad found in a copy of what a head unit lists for an Xbox One S pad, and the whole way from a stand-in for `nes-usbpipe` through the loader to the app in the emulator, where *Pad Test* lit the stand-in's buttons. `nes-usbpipe` and `pad.js` have also read a real Xbox One S pad on a PC, in WSL, where the pad has no kernel driver either: the pad was switched on, and every button and the left stick's four directions, pressed by a person, were read as themselves (`node tools/pad-try.js`; [`CONTROLLER-HELPER.md`](CONTROLLER-HELPER.md) has the details). With `npm run emu -- --pad` that pad then played *Pad Test* in the emulator: its D-pad, View, Menu and A counted there, through this loader and the app as they are.

What has run, on a car (one, on 2026-11-19): with the app and the loader installed by the MGU Store and the setting on, the same pad worked as the gamepad. So the Store installs `nes-usbpipe` as a program the head unit runs, and a user that is not root may open the pad there, in the USB devices' group. Which buttons were tried, and the loader's journal of it, were not kept. That was the loader 0.2.0, which ran `nes-usbpipe` as the owner of the app's folder: on a car the Store's user, as was found later. Since 0.2.3 it is the app's own user, in the same group. Later versions read the same for the NES app; of them 0.2.2 has been on that car, for games from a phone, and the pad was not tried again. What is still open is in the [main README](../README.md), "What still needs a car".

## Removing it

Remove **NES game loader** in the Store. That takes out its units, its folder `/var/opt/clucraft-nes-loader` and any firewall rule of its own. Games already sent stay with the app.

## Files

```
component.json   what the MGU Store installs: the files, the two units, the check after an install
service.js       the service
page.js          the page and its requests
games.js         the app's games folder; what counts as a game; saving and removing one
nft.js           the firewall rules
sockgroup.js     the socket for the NES app alone
pad.js           a USB gamepad: finding it, switching it on, what its packets mean
nes-usbpipe          the program that passes its packets on (built from src/nes-usbpipe/main.go)
check.js         the Store's check: the service answers
cleanup.js       the firewall as it was (after a stop, before a removal)
systemd/         clucraft-nes-loader.socket, clucraft-nes-loader.service
```

On a PC the same files run with the emulator, without root and without a firewall (`tools/loader-dev.js`, started by `npm run emu`): see "Try it in the emulator" in the [main README](../README.md).

GPL-2.0-or-later, as the rest of the repository (`LICENSE`).

The way it works, a service the app starts through a socket, a page behind a QR code, and a firewall rule for as long as the page is open, is how [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) signs in its TV and AirPlay apps, on cars. That showed it can be done on this head unit. The code here is its own.

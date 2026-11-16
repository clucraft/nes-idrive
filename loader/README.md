# NES game loader

A small service for the head unit that lets the [NES app](../README.md) take games from a phone: **Add games from a phone** in the app shows a QR code, the phone opens the page behind it and picks `.nes` files, and they are in the app's menu.

It exists because an app cannot do this on its own: the head unit's firewall drops every connection to an app. The loader is the part that may open a port. It is optional; without it the app works as before, and games come from a USB stick or over SSH.

> **Not tried on a car yet.** Everything here ran on a PC: the page, the checks on what it takes, the firewall rules against a stand-in for `nft`, the app's screen in the emulator. The MGU Store installing it, the real firewall and the car Wi-Fi are what the first try on a car shows.

## Using it

1. In the MGU Store, from the source `clucraft/nes-idrive`: install **NES** first, then **NES game loader**.
2. **Restart the head unit once** (the Store's Settings → Restart head unit). The loader's socket is made at a start, and the head unit only then knows the loader as something that may stop without the unit restarting.
3. In the NES app: **Add games from a phone**. With the phone on the car's Wi-Fi (connected for wireless CarPlay, or on the car's hotspot), scan the code and pick the files.
4. **BACK** closes the page. The games are in the menu.

The page can also take a game out again. It works while the screen with the code is up, for 15 minutes after the last game at most.

## What runs, and as whom

| | runs as | does |
|---|---|---|
| `service.js` | root | answers the NES app on `/run/clucraft-nes-loader.sock`; puts the page's port into the firewall and takes it out; starts the page |
| `page.js` | the NES app's own user | listens on the car Wi-Fi; checks and writes the games |

- **Started by the app, never at boot.** systemd starts the service when the NES app connects to the socket. Two minutes after the app is gone it ends. Nothing of it runs while the app's screen was never opened.
- **Only the NES app can ask.** The socket belongs to the NES app's own group (`sockgroup.js`), not to the group every app is in.
- **The port is open only while the screen is up.** One rule per chain, for the car Wi-Fi's interfaces and port 8493 only, each with the comment `clucraft-nes-loader`. They go when the app leaves the screen, when the time runs out, when the service stops for any reason (`ExecStopPost`), and when the loader is removed. `wlan0` and `wlan1`, where the head unit is a guest on another network, are never opened.
- **The address is the key.** The page is at `http://<car Wi-Fi address>:8493/<20 random characters>/`, new each time. Without those characters every request is "not found"; after 100 such requests the page closes. It is plain HTTP, so anyone already on the car's Wi-Fi who sees the code can use it for as long as it is up.
- **The page is not root.** It runs as the user the NES app runs as, so it can write where the app can and nowhere else.
- **What it takes:** files that start as an iNES file does, 8 MB at most, 64 MB and 1000 games in all, under a name with folders and odd characters taken out, ending in `.nes`. They go to the app's `data/roms/` folder, which the service finds itself; a request cannot name a folder.
- **It cannot restart the head unit by crashing.** No core file reaches the head unit's crash handler (`LimitCORE=1`), the Store lists the units with the head unit's recovery manager, and a service that keeps failing to start is left stopped.

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
check.js         the Store's check: the service answers
cleanup.js       the firewall as it was (after a stop, before a removal)
systemd/         clucraft-nes-loader.socket, clucraft-nes-loader.service
```

On a PC the same files run with the emulator, without root and without a firewall (`tools/loader-dev.js`, started by `npm run emu`): see "Try it in the emulator" in the [main README](../README.md).

GPL-2.0-or-later, as the rest of the repository (`LICENSE`).

The way it works, a service the app starts through a socket, a page behind a QR code, and a firewall rule for as long as the page is open, is how [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) signs in its TV and AirPlay apps, on cars. That showed it can be done on this head unit. The code here is its own.

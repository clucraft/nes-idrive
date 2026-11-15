The games that come with the app: Pad_Test.nes and Snake.nes.

Both were written for it, under its licence (GPL-2.0-or-later). Their source is in games/ at the
top of the repository; "npm run build:games" (sh games/build.sh, with cc65) writes these files.

Every build packs this folder into the app, and the package the MGU Store installs has it too. So
nothing else belongs here: your own games go into app/roms/, which no published package includes.

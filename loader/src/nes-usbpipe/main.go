//go:build linux && (amd64 || arm64)

// nes-usbpipe: one interface of a USB device, as lines of hex on stdin and stdout.
//
//	nes-usbpipe <device node> <interface> <IN endpoint, hex> <OUT endpoint, hex> [<packet bytes>]
//	nes-usbpipe /dev/bus/usb/001/004 0 82 02 64
//
// Every packet the device sends on the IN endpoint is one line on stdout; every line on stdin is a
// packet for the OUT endpoint. Both are interrupt endpoints. What the packets mean is not known here:
// the NES game loader's pad.js knows (a gamepad the head unit's kernel has no driver for).
//
// It ends when stdin ends (exit 0), when the device is gone (1), or on an error it names on stderr (2).
//
// Through Linux's usbfs, with asynchronous requests: a packet is never lost between two reads, and
// the program never waits where a signal cannot reach it. It unbinds no kernel driver unless
// USBPIPE_DETACH=1 says so (a PC, whose kernel has a driver for the pad; the head unit has none).
// Nothing but this file: no library, no C. tools/build-usbpipe.js builds it into loader/nes-usbpipe.
//
// Part of nes-idrive (GPL-2.0-or-later).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// include/uapi/linux/usbdevice_fs.h, as a 64-bit kernel has them
const (
	claimInterface = 0x8004550f // USBDEVFS_CLAIMINTERFACE  _IOR('U', 15, unsigned int)
	submitURB      = 0x8038550a // USBDEVFS_SUBMITURB       _IOR('U', 10, struct usbdevfs_urb)
	reapURB        = 0x4008550c // USBDEVFS_REAPURB         _IOW('U', 12, void *)
	usbIoctl       = 0xc0105512 // USBDEVFS_IOCTL           _IOWR('U', 18, struct usbdevfs_ioctl)
	disconnect     = 0x5516     // USBDEVFS_DISCONNECT      _IO('U', 22)
	urbInterrupt   = 1          // USBDEVFS_URB_TYPE_INTERRUPT

	// struct usbdevfs_urb: type u8 @0, endpoint u8 @1, status s32 @4, flags u32 @8, buffer ptr @16,
	// buffer_length s32 @24, actual_length s32 @28, ... usercontext ptr @48
	urbSize = 56

	maxPacket = 1024
	outSlots  = 8
	maxErrors = 20 // IN packets in a row that came back as an error: the pad is no use like this
)

// Everything the kernel is given an address of lives in one mapping of its own, outside Go's heap and
// stacks: it stays where it is for as long as the program runs.
const (
	reapAt   = 0  // void *: the request the kernel hands back
	claimAt  = 8  // unsigned int: the interface
	ioctlAt  = 16 // struct usbdevfs_ioctl { int ifno; int ioctl_code; void *data; }
	inURBAt  = 64
	inBufAt  = 128
	outAt    = 2048 // outSlots times: a request, and from +64 its packet
	slotSize = 2048
	memSize  = outAt + outSlots*slotSize
)

var (
	mem  []byte
	base uintptr
	le   = binary.LittleEndian
)

func fail(code int, why string) {
	say(why)
	os.Exit(code)
}

// a line for whoever reads this program's stderr (the loader's log)
func say(what string) {
	os.Stderr.WriteString("nes-usbpipe: " + what + "\n")
}

func ioctl(fd int, request uintptr, arg uintptr) syscall.Errno {
	for {
		_, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), request, arg)
		if e != syscall.EINTR {
			return e
		}
	}
}

// a request for one packet on an interrupt endpoint, written at mem[at:]
func request(at int, endpoint byte, bufAt int, length int) {
	for i := 0; i < urbSize; i++ {
		mem[at+i] = 0
	}
	mem[at] = urbInterrupt
	mem[at+1] = endpoint
	le.PutUint64(mem[at+16:], uint64(base)+uint64(bufAt))
	le.PutUint32(mem[at+24:], uint32(length))
}

func number(text string, radix int, what string) int {
	n, err := strconv.ParseUint(text, radix, 16)
	if err != nil {
		fail(2, what+": "+text)
	}
	return int(n)
}

func main() {
	a := os.Args[1:]
	if len(a) < 4 || len(a) > 5 {
		fail(2, "usage: nes-usbpipe <device node> <interface> <IN endpoint, hex> <OUT endpoint, hex> [<packet bytes>]")
	}
	iface, in, out, packet := number(a[1], 10, "interface"), number(a[2], 16, "IN endpoint"), number(a[3], 16, "OUT endpoint"), 64
	if len(a) == 5 {
		packet = number(a[4], 10, "packet bytes")
	}
	if iface > 255 || in < 0x81 || in > 0x8f || out < 0x01 || out > 0x0f || packet < 1 || packet > maxPacket {
		fail(2, "not an interface, an IN and an OUT endpoint and a packet size")
	}

	var err error
	mem, err = syscall.Mmap(-1, 0, memSize, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_ANON|syscall.MAP_PRIVATE)
	if err != nil {
		fail(2, "memory: "+err.Error())
	}
	base = uintptr(unsafe.Pointer(&mem[0]))

	fd, err := syscall.Open(a[0], syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		fail(2, a[0]+": "+err.Error())
	}
	le.PutUint32(mem[claimAt:], uint32(iface))
	e := ioctl(fd, claimInterface, base+claimAt)
	if e == syscall.EBUSY && os.Getenv("USBPIPE_DETACH") == "1" {
		le.PutUint32(mem[ioctlAt:], uint32(iface))
		le.PutUint32(mem[ioctlAt+4:], disconnect)
		le.PutUint64(mem[ioctlAt+8:], 0)
		if e2 := ioctl(fd, usbIoctl, base+ioctlAt); e2 != 0 {
			fail(2, "interface "+a[1]+": its kernel driver does not let go: "+e2.Error())
		}
		e = ioctl(fd, claimInterface, base+claimAt)
	}
	if e != 0 {
		fail(2, "interface "+a[1]+" of "+a[0]+": "+e.Error())
	}

	gone := func(e syscall.Errno) bool { return e == syscall.ENODEV || e == syscall.ESHUTDOWN }
	listen := func() {
		request(inURBAt, byte(in), inBufAt, packet)
		if e := ioctl(fd, submitURB, base+inURBAt); e != 0 {
			if gone(e) {
				fail(1, "the device is gone")
			}
			fail(2, "IN endpoint "+a[2]+": "+e.Error())
		}
	}
	listen()

	// stdin: a line is a packet for the device
	var lock sync.Mutex
	var busy [outSlots]bool
	take := func() int {
		for tries := 0; tries < 200; tries++ {
			lock.Lock()
			for i := range busy {
				if !busy[i] {
					busy[i] = true
					lock.Unlock()
					return i
				}
			}
			lock.Unlock()
			time.Sleep(5 * time.Millisecond)
		}
		return -1
	}
	free := func(i int) { lock.Lock(); busy[i] = false; lock.Unlock() }
	go func() {
		lines := bufio.NewScanner(os.Stdin)
		lines.Buffer(make([]byte, 4096), 4096)
		for lines.Scan() {
			text := strings.TrimSpace(lines.Text())
			if text == "" {
				continue
			}
			data, err := hex.DecodeString(text)
			if err != nil || len(data) == 0 || len(data) > packet {
				say("not a packet: " + text)
				continue
			}
			slot := take()
			if slot < 0 {
				say("the device takes no packets: dropped " + text)
				continue
			}
			at := outAt + slot*slotSize
			copy(mem[at+64:], data)
			request(at, byte(out), at+64, len(data))
			if e := ioctl(fd, submitURB, base+uintptr(at)); e != 0 {
				free(slot)
				if gone(e) {
					fail(1, "the device is gone")
				}
				say("OUT endpoint " + a[3] + ": " + e.Error())
			}
		}
		os.Exit(0) // whoever started this is done, or gone: the kernel drops what is still asked of the device
	}()

	// the device: each request comes back answered, a packet from it or one of ours sent
	errors := 0
	line := make([]byte, 0, 2*maxPacket+1)
	for {
		if e := ioctl(fd, reapURB, base+reapAt); e != 0 {
			if gone(e) {
				fail(1, "the device is gone")
			}
			fail(2, "waiting for the device: "+e.Error())
		}
		at := int(uintptr(le.Uint64(mem[reapAt:])) - base)
		if at != inURBAt && (at < outAt || at >= memSize || (at-outAt)%slotSize != 0) {
			fail(2, "the kernel handed back a request that is not ours")
		}
		status := int32(le.Uint32(mem[at+4:]))
		if at != inURBAt {
			if status != 0 {
				say("a packet was not sent: error " + strconv.Itoa(int(-status)))
			}
			free((at - outAt) / slotSize)
			continue
		}
		switch {
		case status == 0:
			errors = 0
			if n := int(int32(le.Uint32(mem[at+28:]))); n > 0 && n <= packet {
				line = line[:2*n+1]
				hex.Encode(line, mem[inBufAt:inBufAt+n])
				line[2*n] = '\n'
				if _, err := os.Stdout.Write(line); err != nil {
					os.Exit(0)
				}
			}
		case gone(syscall.Errno(-status)):
			fail(1, "the device is gone")
		default:
			if errors++; errors > maxErrors {
				fail(2, "IN endpoint "+a[2]+": error "+strconv.Itoa(int(-status))+", "+strconv.Itoa(errors)+" times in a row")
			}
		}
		listen()
	}
}

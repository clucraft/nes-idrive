// nes-sound plays a game's sound on a sound device of the head unit. It is the NES game loader's
// (loader/service.js starts it while the NES app sends sound); loader/README.md says what it is for.
//
//	nes-sound <device> <rate>
//
// Standard input: the sound as the game makes it, signed 16-bit little-endian, left and right, <rate> samples
// a second. Standard output: a line of JSON for whoever started it, for each thing worth telling:
//
//	{"ev":"open","device":"..."}       the device is open
//	{"ev":"playing"} {"ev":"waiting"}  the device takes the sound / takes none (nothing is connected to the
//	                                   speakers: the app asks the head unit's audio manager for that)
//	{"ev":"busy","error":"..."}        the device cannot be opened yet (another program has it): tried again
//	{"ev":"error","error":"..."}       it cannot be played at all; the program ends
//	{"ev":"stat",...}                  every half minute while it plays: what was played, dropped, and ran dry
//
// The device is an ALSA one, "plug:smartx:CarLifeMedia_CF_48_STEREO" on the head unit: the input of the head
// unit's own sound mixer (SmartXbar) that no phone uses outside China. It is opened and written as the
// players of other apps for this head unit do (tvh-player: aurelmarius/bmw-apps, M850i-amn/idrive7-apps,
// clucraft/plex-idrive), which are heard on a car: libasound.so.2 loaded at run time, snd_pcm_open
// non-blocking, snd_pcm_set_params (S16_LE, interleaved, 2 channels, 48000, a buffer of 64 ms), snd_pcm_writei.
// Go has no ALSA of its own and this program is built without a C compiler, so libasound is called through
// github.com/ebitengine/purego (Apache-2.0), the one library here beside Go's own.
//
// The game's clock and the device's are two: a game makes a little less or more than <rate> samples in a
// second of the device's. So the sound is kept about 40 ms ahead of the device and played a little slower or
// faster (half a percent at most) to stay there; with none left it plays silence until there is enough again,
// and more than half a second of it waiting is cut down, so the sound never trails the picture.
//
// NES_SOUND_OUT=null plays to nowhere, and NES_SOUND_OUT=file:<path> writes what the device would get (S16LE
// stereo, 48000), both at the device's pace: for trying it where there is no such device.
//
// It ends when its input ends, or on SIGTERM, with the device closed first (a device left open stays busy).
// Started by the loader as a user that is not root, in the group the head unit gives its sound devices to.
//
// GPL-2.0-or-later (LICENSE). Build: npm run build:sound (tools/build-sound.js).
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ebitengine/purego"
)

const (
	outRate  = 48000
	period   = 480   // frames written at once: 10 ms
	bufferUs = 64000 // the device's buffer
	// ALSA's numbers (alsa/pcm.h)
	streamPlayback = 0
	formatS16LE    = 2
	accessRWInter  = 3
	modeNonblock   = 1
)

/* ---------- what is told ---------- */

var outMu sync.Mutex

func tell(ev string, more map[string]interface{}) {
	m := map[string]interface{}{"ev": ev}
	for k, v := range more {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	outMu.Lock()
	os.Stdout.Write(append(b, '\n'))
	outMu.Unlock()
}

/* ---------- the sound that waits: frames of left and right, as they came ---------- */

type ring struct {
	mu      sync.Mutex
	buf     []int16 // 2 * capacity
	head, n int     // the first frame, and how many
	dropped uint64  // frames cut off because too many waited
	ended   bool
}

func newRing(frames int) *ring { return &ring{buf: make([]int16, 2*frames)} }

func (r *ring) capFrames() int { return len(r.buf) / 2 }

// push adds frames; when they do not fit, the oldest go
func (r *ring) push(s []int16) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.capFrames()
	for i := 0; i+1 < len(s); i += 2 {
		if r.n == c {
			r.head = (r.head + 1) % c
			r.n--
			r.dropped++
		}
		at := (r.head + r.n) % c
		r.buf[2*at], r.buf[2*at+1] = s[i], s[i+1]
		r.n++
	}
}

func (r *ring) len() int { r.mu.Lock(); defer r.mu.Unlock(); return r.n }

// at: frame i from the first (the caller holds no lock: only the player takes frames out)
func (r *ring) at(i int) (int16, int16) {
	c := r.capFrames()
	k := (r.head + i) % c
	return r.buf[2*k], r.buf[2*k+1]
}

func (r *ring) take(n int) {
	r.mu.Lock()
	if n > r.n {
		n = r.n
	}
	r.head = (r.head + n) % r.capFrames()
	r.n -= n
	r.mu.Unlock()
}

func (r *ring) clear() { r.mu.Lock(); r.n = 0; r.mu.Unlock() }

/* ---------- from the game's rate to the device's, a little slower or faster to stay ahead ---------- */

type mixer struct {
	in      *ring
	inRate  int
	target  int     // frames of the game's kept waiting
	pos     float64 // where in the first waiting frame the next sample is
	going   bool
	ranDry  uint64
	lastL   int16
	lastR   int16
	fadeOut int
}

// fill writes one period into out (interleaved) and says how many frames of it are the game's
func (m *mixer) fill(out []int16) int {
	frames := len(out) / 2
	m.in.mu.Lock()
	have := m.in.n
	m.in.mu.Unlock()
	if !m.going {
		if have < m.target {
			m.silence(out, 0)
			return 0
		}
		m.going = true
		m.pos = 0
	}
	// a little faster with more than the target waiting, a little slower with less
	adj := 0.005 * float64(have-m.target) / float64(m.target)
	if adj > 0.005 {
		adj = 0.005
	} else if adj < -0.005 {
		adj = -0.005
	}
	step := float64(m.inRate) / outRate * (1 + adj)
	done := 0
	for ; done < frames; done++ {
		i := int(m.pos)
		if i+1 >= have {
			break
		}
		f := m.pos - float64(i)
		al, ar := m.in.at(i)
		bl, br := m.in.at(i + 1)
		m.lastL = int16(float64(al) + (float64(bl)-float64(al))*f)
		m.lastR = int16(float64(ar) + (float64(br)-float64(ar))*f)
		out[2*done], out[2*done+1] = m.lastL, m.lastR
		m.pos += step
	}
	used := int(m.pos)
	if used > have {
		used = have
	}
	m.in.take(used)
	m.pos -= float64(used)
	if done < frames {
		// ran dry: the last sample fades out (no click), then silence until enough waits again
		m.going = false
		m.ranDry++
		m.silence(out, done)
	}
	return done
}

func (m *mixer) silence(out []int16, from int) {
	frames := len(out) / 2
	for i := from; i < frames; i++ {
		m.lastL = int16(int(m.lastL) * 15 / 16)
		m.lastR = int16(int(m.lastR) * 15 / 16)
		out[2*i], out[2*i+1] = m.lastL, m.lastR
	}
}

/* ---------- where it goes ---------- */

type sink interface {
	// write plays one period; false: the device took none of it for a quarter of a second
	write(s []int16) (bool, error)
	close()
}

/* nowhere, or a file: at the device's pace */
type paced struct {
	f    *os.File
	next time.Time
}

func (p *paced) write(s []int16) (bool, error) {
	if p.next.IsZero() {
		p.next = time.Now()
	}
	p.next = p.next.Add(time.Second * time.Duration(len(s)/2) / outRate)
	if d := time.Until(p.next); d > 0 {
		time.Sleep(d)
	} else if d < -200*time.Millisecond {
		p.next = time.Now()
	}
	if p.f != nil {
		b := make([]byte, 2*len(s))
		for i, v := range s {
			b[2*i], b[2*i+1] = byte(v), byte(uint16(v)>>8)
		}
		if _, err := p.f.Write(b); err != nil {
			return false, err
		}
	}
	return true, nil
}
func (p *paced) close() {
	if p.f != nil {
		p.f.Close()
	}
}

/* the head unit's: libasound, called as tvh-player calls it */
type alsa struct {
	pcm       uintptr
	open      func(pcm *uintptr, name string, stream int32, mode int32) int32
	setParams func(pcm uintptr, format int32, access int32, channels uint32, rate uint32, softResample int32, latencyUs uint32) int32
	writei    func(pcm uintptr, buf *int16, frames uint) int
	recover   func(pcm uintptr, err int32, silent int32) int32
	drop      func(pcm uintptr) int32
	closePcm  func(pcm uintptr) int32
	strerror  func(err int32) string
}

// loadAlsa: libasound.so.2 and the functions of it used here
func loadAlsa() (a *alsa, err error) {
	defer func() {
		if r := recover(); r != nil {
			a, err = nil, fmt.Errorf("libasound.so.2: %v", r)
		}
	}()
	lib, e := purego.Dlopen("libasound.so.2", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if e != nil {
		return nil, fmt.Errorf("dlopen libasound.so.2: %v", e)
	}
	a = &alsa{}
	purego.RegisterLibFunc(&a.open, lib, "snd_pcm_open")
	purego.RegisterLibFunc(&a.setParams, lib, "snd_pcm_set_params")
	purego.RegisterLibFunc(&a.writei, lib, "snd_pcm_writei")
	purego.RegisterLibFunc(&a.recover, lib, "snd_pcm_recover")
	purego.RegisterLibFunc(&a.drop, lib, "snd_pcm_drop")
	purego.RegisterLibFunc(&a.closePcm, lib, "snd_pcm_close")
	purego.RegisterLibFunc(&a.strerror, lib, "snd_strerror")
	return a, nil
}

func (a *alsa) openDevice(name string) error {
	var pcm uintptr
	if rc := a.open(&pcm, name, streamPlayback, modeNonblock); rc < 0 {
		return fmt.Errorf("snd_pcm_open %s: %s", name, a.strerror(rc))
	}
	if rc := a.setParams(pcm, formatS16LE, accessRWInter, 2, outRate, 1, bufferUs); rc < 0 {
		a.closePcm(pcm)
		return fmt.Errorf("snd_pcm_set_params: %s", a.strerror(rc))
	}
	a.pcm = pcm
	return nil
}

func (a *alsa) write(s []int16) (bool, error) {
	left := uint(len(s) / 2)
	at := 0
	waited := 0
	for left > 0 {
		w := a.writei(a.pcm, &s[at], left)
		if w == -int(syscall.EAGAIN) {
			// full: it is read at the speakers' pace, or not at all while nothing is connected to them
			if waited >= 250 {
				return false, nil
			}
			time.Sleep(5 * time.Millisecond)
			waited += 5
			continue
		}
		if w < 0 {
			if rc := a.recover(a.pcm, int32(w), 1); rc < 0 {
				return false, fmt.Errorf("snd_pcm_writei: %s", a.strerror(int32(w)))
			}
			continue
		}
		at += 2 * w
		left -= uint(w)
	}
	return true, nil
}

func (a *alsa) close() {
	if a.pcm != 0 {
		a.drop(a.pcm)
		a.closePcm(a.pcm)
		a.pcm = 0
	}
}

/* ---------- the program ---------- */

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "nes-sound <device> <rate>: plays S16LE stereo from standard input")
		os.Exit(2)
	}
	device := os.Args[1]
	inRate, err := strconv.Atoi(os.Args[2])
	if err != nil || inRate < 8000 || inRate > 192000 {
		tell("error", map[string]interface{}{"error": "rate not understood: " + os.Args[2]})
		os.Exit(2)
	}
	if os.Getuid() == 0 && os.Getenv("NES_SOUND_AS_ROOT") != "1" {
		tell("error", map[string]interface{}{"error": "not as root"})
		os.Exit(2)
	}

	in := newRing(inRate / 2)
	mix := &mixer{in: in, inRate: inRate, target: inRate * 40 / 1000}
	quit := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(quit) }) }

	// the game's sound, as it comes
	go func() {
		b := make([]byte, 8192)
		s := make([]int16, 0, 4096)
		keep := 0 // bytes of a frame not whole yet, at the start of b
		for {
			n, e := os.Stdin.Read(b[keep:])
			n += keep
			whole := n - n%4
			s = s[:0]
			for i := 0; i < whole; i += 2 {
				s = append(s, int16(uint16(b[i])|uint16(b[i+1])<<8))
			}
			in.push(s)
			keep = copy(b, b[whole:n])
			if e != nil {
				if e != io.EOF {
					tell("error", map[string]interface{}{"error": "input: " + e.Error()})
				}
				stop()
				return
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() { <-sig; stop() }()
	stopped := func() bool {
		select {
		case <-quit:
			return true
		default:
			return false
		}
	}

	// the device: opened again every second while another program has it
	var out sink
	where := os.Getenv("NES_SOUND_OUT")
	switch {
	case where == "null":
		out = &paced{}
	case strings.HasPrefix(where, "file:"):
		f, e := os.Create(where[5:])
		if e != nil {
			tell("error", map[string]interface{}{"error": e.Error()})
			os.Exit(3)
		}
		out = &paced{f: f}
	default:
		a, e := loadAlsa()
		if e != nil {
			tell("error", map[string]interface{}{"error": e.Error()})
			os.Exit(3)
		}
		said := ""
		for {
			e = a.openDevice(device)
			if e == nil {
				break
			}
			if e.Error() != said {
				said = e.Error()
				tell("busy", map[string]interface{}{"error": said})
			}
			in.clear()
			select {
			case <-quit:
				os.Exit(0)
			case <-time.After(time.Second):
			}
		}
		out = a
	}
	tell("open", map[string]interface{}{"device": device, "rate": inRate})

	buf := make([]int16, 2*period)
	var played, silent uint64
	state := ""
	last := time.Now()
	for !stopped() {
		got := mix.fill(buf)
		ok, e := out.write(buf)
		if e != nil {
			tell("error", map[string]interface{}{"error": e.Error()})
			out.close()
			os.Exit(4)
		}
		now := "playing"
		if !ok {
			// not taken: what waits would only be late when it is, so it goes
			now = "waiting"
			in.clear()
			mix.going = false
		} else {
			played += uint64(got)
			silent += uint64(period - got)
		}
		if now != state {
			state = now
			tell(state, nil)
		}
		if time.Since(last) >= 30*time.Second {
			last = time.Now()
			if played > 0 || in.dropped > 0 {
				tell("stat", map[string]interface{}{"played": played, "silent": silent, "ranDry": mix.ranDry, "dropped": in.dropped, "waiting": in.len()})
			}
			played, silent = 0, 0
		}
	}
	out.close()
}

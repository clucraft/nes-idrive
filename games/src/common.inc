; common.inc - what the bundled cartridges share: the cartridge's header and tiles, start-up, the
; frame interrupt that shows what the game queued, the pad, and text.
;
; A game includes this file and has:
;   game_init    draws its screen; the picture is off, so it writes to the PPU directly
;   game_frame   one frame of the game: pad / pad_new are read; it queues what changes on screen
;
; Part of nes-idrive (GPL-2.0-or-later).

PPUCTRL     = $2000
PPUMASK     = $2001
PPUSTATUS   = $2002
OAMADDR     = $2003
PPUSCROLL   = $2005
PPUADDR     = $2006
PPUDATA     = $2007
DMCFREQ     = $4010
OAMDMA      = $4014
APUSTATUS   = $4015
JOY1        = $4016
APUFRAME    = $4017

; the pad's buttons, as read_pad leaves them in pad
PAD_A       = $80
PAD_B       = $40
PAD_SELECT  = $20
PAD_START   = $10
PAD_UP      = $08
PAD_DOWN    = $04
PAD_LEFT    = $02
PAD_RIGHT   = $01

; tiles (mkchr.js); a letter's tile is its ASCII code
T_BALL      = $04
T_HEAD      = $05
T_FOOD      = $06
T_WALL      = $07
T_BODY      = $08
T_DOT       = $09
T_LIGHT     = $0a

OAM         = $0200             ; the sprites, copied to the PPU each frame
ubuf        = $0100             ; what to write to the screen at the next frame (below the stack)
UBUF_SIZE   = 96                ;   entries: address high, low, length, tiles; a 0 ends the list

; a line for print_table: column, row, text
.macro TEXT col, row, string
    .byte >($2000 + (row) * 32 + (col)), <($2000 + (row) * 32 + (col)), string, 0
.endmacro
; an entry for queue_update: column, row, text
.macro UPDATE col, row, string
    .byte >($2000 + (row) * 32 + (col)), <($2000 + (row) * 32 + (col)), .strlen(string), string
.endmacro
; queue the UPDATE entry at addr
.macro QUEUE addr
    lda #<(addr)
    sta ptr
    lda #>(addr)
    sta ptr+1
    jsr queue_update
.endmacro

.segment "HEADER"
    .byte "NES", $1a
    .byte 1                     ; 16 KB of program
    .byte 1                     ; 8 KB of tiles
    .byte $00, $00              ; no mapper, no battery
    .res 8, 0

.segment "CHARS"
    .incbin "font.chr"

.segment "VECTORS"
    .word nmi, reset, irq

.segment "ZEROPAGE"
nmi_ready:  .res 1              ; 1: the frame's work is done, the interrupt may show it
mask:       .res 1              ; PPUMASK from the next frame: the picture on or off
frame:      .res 2              ; frames since power-on
pad:        .res 1              ; the buttons held
pad_old:    .res 1
pad_new:    .res 1              ; the buttons pressed since the last frame
ubuf_len:   .res 1
off_lo:     .res 1              ; a tile's place on the screen: row * 32 + column
off_hi:     .res 1
ptr:        .res 2
tmp:        .res 1
tmp2:       .res 1

.segment "CODE"

reset:
    sei
    cld
    ldx #$40
    stx APUFRAME                ; no interrupt from the sound chip
    ldx #$ff
    txs
    inx
    stx PPUCTRL                 ; no frame interrupt yet
    stx PPUMASK                 ; no picture
    stx DMCFREQ
    stx APUSTATUS               ; silent
    bit PPUSTATUS
@warm1:
    bit PPUSTATUS
    bpl @warm1
    txa
@clear:
    sta $00,x
    sta $0100,x
    sta $0300,x
    sta $0400,x
    sta $0500,x
    sta $0600,x
    sta $0700,x
    inx
    bne @clear
    lda #$f8                    ; every sprite below the screen
@hide:
    sta OAM,x
    inx
    bne @hide
@warm2:
    bit PPUSTATUS
    bpl @warm2
    jsr palette
    jsr clear_screen
    jsr game_init
    jsr screen_on
@forever:
    jsr read_pad
    jsr game_frame
    jsr wait_frame
    jmp @forever

; The frame interrupt, at the start of the vertical blank: sprites and queued tiles to the PPU.
; While the game is still at work on a frame (nmi_ready 0) it leaves the PPU alone.
nmi:
    pha
    txa
    pha
    tya
    pha
    lda nmi_ready
    beq @count
    bit PPUSTATUS
    lda #0
    sta OAMADDR
    lda #>OAM
    sta OAMDMA
    ldx #0
@entry:
    lda ubuf,x
    beq @shown
    sta PPUADDR
    inx
    lda ubuf,x
    sta PPUADDR
    inx
    ldy ubuf,x
    inx
@tile:
    lda ubuf,x
    sta PPUDATA
    inx
    dey
    bne @tile
    beq @entry
@shown:
    sta ubuf                    ; (A is 0) the list is empty again
    sta ubuf_len
    sta nmi_ready
    lda #%10000000              ; the interrupt on, tiles and sprites from the first table
    sta PPUCTRL
    lda #0
    sta PPUSCROLL
    sta PPUSCROLL
    lda mask
    sta PPUMASK
@count:
    inc frame
    bne @out
    inc frame+1
@out:
    pla
    tay
    pla
    tax
    pla
irq:
    rti

; The picture on, from the next frame.
screen_on:
    lda #%00011110              ; background and sprites, also in the left 8 pixels
    sta mask
    lda #%10000000
    sta PPUCTRL
    ; (falls through)

; The frame is done: wait until the interrupt has shown it.
wait_frame:
    lda #1
    sta nmi_ready
@wait:
    lda nmi_ready
    bne @wait
    rts

; The picture off from the next frame on, to draw a whole screen.
screen_off:
    lda #0
    sta mask
    jmp wait_frame

; black, white, green, red: every palette, background and sprites
palette:
    lda #$3f
    sta PPUADDR
    lda #$00
    sta PPUADDR
    ldy #8
@set:
    ldx #0
@colour:
    lda colours,x
    sta PPUDATA
    inx
    cpx #4
    bne @colour
    dey
    bne @set
    rts

; spaces on the whole screen, every tile in palette 0 (picture off)
clear_screen:
    lda #$20
    sta PPUADDR
    lda #$00
    sta PPUADDR
    lda #' '
    ldx #0
    ldy #3
@pages:                         ; 768 tiles
    sta PPUDATA
    inx
    bne @pages
    dey
    bne @pages
@rest:                          ; 192 more: 960
    sta PPUDATA
    inx
    cpx #192
    bne @rest
    lda #0
    ldx #64
@attributes:
    sta PPUDATA
    dex
    bne @attributes
    rts

; pad 1 into pad (PAD_...), the buttons new since the last call into pad_new
read_pad:
    lda pad
    sta pad_old
    lda #1
    sta JOY1
    lda #0
    sta JOY1
    ldx #8
@button:
    lda JOY1
    lsr a
    rol pad
    dex
    bne @button
    lda pad_old
    eor #$ff
    and pad
    sta pad_new
    rts

; X = column, Y = row: the tile's place into off_lo / off_hi (X and Y are kept)
calc_off:
    tya
    lsr a
    lsr a
    lsr a
    sta off_hi
    tya
    and #7
    asl a
    asl a
    asl a
    asl a
    asl a
    sta off_lo
    txa
    ora off_lo
    sta off_lo
    rts

; the lines of TEXT at ptr, up to a 0 (picture off; at most 255 bytes of them)
print_table:
    ldy #0
@line:
    lda (ptr),y
    beq @done
    sta PPUADDR
    iny
    lda (ptr),y
    sta PPUADDR
    iny
@letter:
    lda (ptr),y
    beq @next
    sta PPUDATA
    iny
    bne @letter
@next:
    iny
    bne @line
@done:
    rts

; the UPDATE entry at ptr onto the list for the next frame
queue_update:
    ldy #2
    lda (ptr),y
    clc
    adc #3
    sta tmp                     ; its size
    ldy #0
    ldx ubuf_len
@copy:
    lda (ptr),y
    sta ubuf,x
    inx
    iny
    cpy tmp
    bne @copy
    lda #0
    sta ubuf,x
    stx ubuf_len
    rts

; tile A at off_lo / off_hi onto the list (Y is kept)
queue_tile:
    pha
    ldx ubuf_len
    lda off_hi
    clc
    adc #$20
    sta ubuf,x
    inx
    lda off_lo
    sta ubuf,x
    inx
    lda #1
    sta ubuf,x
    inx
    pla
    sta ubuf,x
    inx
    lda #0
    sta ubuf,x
    stx ubuf_len
    rts

; the three digits at ptr as tiles at column X, row Y, onto the list
queue3:
    jsr calc_off
    ldx ubuf_len
    lda off_hi
    clc
    adc #$20
    sta ubuf,x
    inx
    lda off_lo
    sta ubuf,x
    inx
    lda #3
    sta ubuf,x
    inx
    ldy #0
@digit:
    lda (ptr),y
    ora #'0'
    sta ubuf,x
    inx
    iny
    cpy #3
    bne @digit
    lda #0
    sta ubuf,x
    stx ubuf_len
    rts

; one more on the three digits at ptr (999 goes to 000)
bump3:
    ldy #2
@digit:
    lda (ptr),y
    clc
    adc #1
    cmp #10
    bcc @store
    lda #0
    sta (ptr),y
    dey
    bpl @digit
    rts
@store:
    sta (ptr),y
    rts

.segment "RODATA"
colours:
    .byte $0f, $30, $2a, $16

; Pad Test - shows what the console gets from pad 1: each button lights while it is held and counts
; its presses. A clock counts the frames (60 a second), and a ball crosses the screen one pixel a
; frame, to see that the picture runs at full speed and evenly. A dotted frame marks the edge of
; what a TV shows (the top and bottom 8 lines are off most screens).
;
; Written for nes-idrive, to try the app without a game of one's own. GPL-2.0-or-later.

.include "common.inc"

ROW0        = 8                 ; the first button's row; one button every two rows
LIGHTCOL    = 16
COUNTCOL    = 20
TIMEROW     = 24
TIMECOL     = 13
BALLROW     = 26
BALL        = 32                ; the ball's sprite: the ninth

.segment "ZEROPAGE"
button:     .res 1
tick:       .res 1              ; frames into the tenth of a second
ballx:      .res 1
ballback:   .res 1              ; 1: the ball goes left

.segment "BSS"
count:      .res 24             ; three digits a button
time:       .res 5              ; minutes (2 digits), seconds (2), tenths

.segment "RODATA"
masks:
    .byte PAD_UP, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_SELECT, PAD_START, PAD_B, PAD_A
limits:
    .byte 10, 10, 6, 10, 10
texts:
    TEXT 12, 3, "PAD TEST"
    TEXT 3, 5, "BUTTONS LIGHT UP AND COUNT"
    TEXT 8, ROW0 + 0, "UP     [ ]  000"
    TEXT 8, ROW0 + 2, "DOWN   [ ]  000"
    TEXT 8, ROW0 + 4, "LEFT   [ ]  000"
    TEXT 8, ROW0 + 6, "RIGHT  [ ]  000"
    TEXT 8, ROW0 + 8, "SELECT [ ]  000"
    TEXT 8, ROW0 + 10, "START  [ ]  000"
    TEXT 8, ROW0 + 12, "B      [ ]  000"
    TEXT 8, ROW0 + 14, "A      [ ]  000"
    TEXT 8, TIMEROW, "TIME 00:00.0"
    .byte 0
.assert * - texts < 256, error, "print_table takes 255 bytes"

.segment "CODE"

game_init:
    lda #<texts
    sta ptr
    lda #>texts
    sta ptr+1
    jsr print_table
    ; the frame: rows 1 and 28, columns 0 and 31
    lda #$20
    sta PPUADDR
    lda #$20
    sta PPUADDR
    ldx #32
    jsr @dots
    lda #$23
    sta PPUADDR
    lda #$80
    sta PPUADDR
    ldx #32
    jsr @dots
    lda #%00000100              ; the next writes go down the screen
    sta PPUCTRL
    lda #$20
    sta PPUADDR
    lda #$40
    sta PPUADDR
    ldx #26
    jsr @dots
    lda #$20
    sta PPUADDR
    lda #$5f
    sta PPUADDR
    ldx #26
    jsr @dots
    lda #0
    sta PPUCTRL
    lda #16
    sta ballx
    rts
@dots:
    lda #T_DOT
@dot:
    sta PPUDATA
    dex
    bne @dot
    rts

game_frame:
    ldx #0
@button:
    stx button
    txa
    asl a
    asl a
    tay                         ; its sprite: the light between the brackets
    lda masks,x
    and pad
    beq @dark
    txa
    asl a
    clc
    adc #ROW0
    asl a
    asl a
    asl a
    sec
    sbc #1                      ; (a sprite shows one line lower)
    bne @light
@dark:
    lda #$f8
@light:
    sta OAM,y
    lda #T_LIGHT
    sta OAM+1,y
    lda #0
    sta OAM+2,y
    lda #LIGHTCOL * 8
    sta OAM+3,y
    ldx button
    lda masks,x
    and pad_new
    beq @next
    ; a press: one more on its count
    lda button
    asl a
    clc
    adc button
    clc
    adc #<count
    sta ptr
    lda #>count
    adc #0
    sta ptr+1
    jsr bump3
    lda button
    asl a
    clc
    adc #ROW0
    tay
    ldx #COUNTCOL
    jsr queue3
@next:
    ldx button
    inx
    cpx #8
    bne @button

    ; the clock: a tenth of a second every 6 frames
    inc tick
    lda tick
    cmp #6
    bcc @ball
    lda #0
    sta tick
    ldx #4
@carry:
    inc time,x
    lda time,x
    cmp limits,x
    bcc @clock
    lda #0
    sta time,x
    dex
    bpl @carry
@clock:
    ldx ubuf_len
    lda #>($2000 + TIMEROW * 32 + TIMECOL)
    sta ubuf,x
    inx
    lda #<($2000 + TIMEROW * 32 + TIMECOL)
    sta ubuf,x
    inx
    lda #7
    sta ubuf,x
    inx
    lda time
    ora #'0'
    sta ubuf,x
    inx
    lda time+1
    ora #'0'
    sta ubuf,x
    inx
    lda #':'
    sta ubuf,x
    inx
    lda time+2
    ora #'0'
    sta ubuf,x
    inx
    lda time+3
    ora #'0'
    sta ubuf,x
    inx
    lda #'.'
    sta ubuf,x
    inx
    lda time+4
    ora #'0'
    sta ubuf,x
    inx
    lda #0
    sta ubuf,x
    stx ubuf_len

@ball:
    lda ballback
    bne @left
    inc ballx
    lda ballx
    cmp #232
    bcc @put
    lda #1
    sta ballback
    bne @put
@left:
    dec ballx
    lda ballx
    cmp #17
    bcs @put
    lda #0
    sta ballback
@put:
    lda #BALLROW * 8 - 1
    sta OAM+BALL
    lda #T_BALL
    sta OAM+BALL+1
    lda #0
    sta OAM+BALL+2
    lda ballx
    sta OAM+BALL+3
    rts

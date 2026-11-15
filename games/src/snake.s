; Snake - steer the snake to the apples; each one makes it longer, and now and then faster. It ends
; at a wall or at the snake itself. Only the direction buttons steer, one at a time, so it plays
; well with the iDrive controller's push. Start pauses.
;
; Written for nes-idrive, to try the app without a game of one's own. GPL-2.0-or-later.

.include "common.inc"

; the field: a wall around columns 2 to 29, rows 5 to 26
LEFTCOL     = 1
RIGHTCOL    = 30
TOPROW      = 4
BOTROW      = 27
MSGROW      = 3
SCORECOL    = 16
BESTCOL     = 26
SCOREROW    = 2

; a cell of the map: empty, a piece of the snake (the direction to the piece nearer its head), ...
D_UP        = 1
D_DOWN      = 2
D_LEFT      = 3
D_RIGHT     = 4
C_WALL      = 5
C_FOOD      = 6

; state
S_READY     = 0                 ; a new field, until a button
S_PLAY      = 1
S_PAUSE     = 2
S_OVER      = 3

SLOWEST     = 12                ; frames a step, at the start
FASTEST     = 6
FASTER_EVERY = 4                ; apples

.segment "ZEROPAGE"
state:      .res 1
hx:         .res 1              ; the head
hy:         .res 1
tx:         .res 1              ; the tail's end
ty:         .res 1
nx:         .res 1
ny:         .res 1
dir:        .res 1              ; the way it goes
want:       .res 1              ; the way last pushed
wait:       .res 1              ; frames to the next step
speed:      .res 1              ; frames a step
eaten:      .res 1              ; apples since it last got faster
hold:       .res 1              ; frames a new game cannot start yet
rng:        .res 2
mp:         .res 2              ; a cell of the map

.segment "BSS"
map:        .res 960            ; a byte a tile of the screen, as the tiles lie in the PPU
score:      .res 3              ; digits
best:       .res 3
.assert <map = 0, error, "the map starts a page: a cell's address is the tile's, moved"

.segment "RODATA"
texts:
    TEXT 2, SCOREROW, "SNAKE"
    TEXT 10, SCOREROW, "SCORE 000"
    TEXT 21, SCOREROW, "BEST 000"
    .byte 0
; (all as long as the field is wide, so each takes the last one's place)
msg_ready:  UPDATE 2, MSGROW, " PUSH A DIRECTION TO START  "
msg_none:   UPDATE 2, MSGROW, "                            "
msg_pause:  UPDATE 2, MSGROW, "           PAUSED           "
msg_over:   UPDATE 2, MSGROW, " GAME OVER - PUSH FOR A NEW "
msg_full:   UPDATE 2, MSGROW, "  ALL OF IT! PUSH FOR A NEW "
.assert msg_none - msg_ready = 31 && msg_pause - msg_none = 31 && msg_over - msg_pause = 31 && msg_full - msg_over = 31 && * - msg_full = 31, error, "a message is 28 letters"
dxs:        .byte 0, 0, 0, $ff, 1
dys:        .byte 0, $ff, 1, 0, 0
opposite:   .byte 0, D_DOWN, D_UP, D_RIGHT, D_LEFT

.segment "CODE"

game_init:
    lda #<texts
    sta ptr
    lda #>texts
    sta ptr+1
    jsr print_table
    lda #$a7                    ; (any start but 0; the first button's moment stirs it)
    sta rng
    sta rng+1
    ; (falls through)

; A new field with a short snake in the middle (picture off).
new_game:
    lda #0
    tax
@clear:
    sta map,x
    sta map+$100,x
    sta map+$200,x
    inx
    bne @clear
@rest:
    sta map+$300,x
    inx
    cpx #192
    bne @rest

    ldy #TOPROW
@row:
    sty ny
    ldx #LEFTCOL
    jsr cell
    lda off_hi
    clc
    adc #$20
    sta PPUADDR
    lda off_lo
    sta PPUADDR
@column:
    lda ny
    cmp #TOPROW
    beq @wall
    cmp #BOTROW
    beq @wall
    cpx #LEFTCOL
    beq @wall
    cpx #RIGHTCOL
    beq @wall
    lda #' '
    sta PPUDATA
    bne @next
@wall:
    lda #T_WALL
    sta PPUDATA
    txa
    sec
    sbc #LEFTCOL
    tay
    lda #C_WALL
    sta (mp),y
@next:
    inx
    cpx #RIGHTCOL + 1
    bne @column
    ldy ny
    iny
    cpy #BOTROW + 1
    bne @row

    ; the snake: three pieces going right
    ldx #14
    ldy #15
    jsr cell
    lda off_hi
    clc
    adc #$20
    sta PPUADDR
    lda off_lo
    sta PPUADDR
    lda #T_BODY
    sta PPUDATA
    sta PPUDATA
    lda #T_HEAD
    sta PPUDATA
    lda #D_RIGHT
    ldy #0
    sta (mp),y
    iny
    sta (mp),y
    iny
    sta (mp),y
    sta dir
    lda #14
    sta tx
    lda #16
    sta hx
    lda #15
    sta ty
    sta hy
    lda #0
    sta want
    sta eaten
    sta score
    sta score+1
    sta score+2
    sta state                   ; S_READY
    lda #SLOWEST
    sta speed
    sta wait
    jsr show_score
    jsr show_best
    QUEUE msg_ready
    rts

game_frame:
    lda state
    cmp #S_PLAY
    beq @play
    cmp #S_PAUSE
    beq @pause
    cmp #S_OVER
    beq @over

    ; ready: any button starts it
    lda pad_new
    beq @done
    lda frame
    eor rng
    sta rng
    lda frame+1
    eor rng+1
    ora #1
    sta rng+1
    jsr place_food
    lda state
    bne @done                   ; (no room for an apple: cannot be, on a new field)
    lda #S_PLAY
    sta state
    QUEUE msg_none
    jmp steer

@pause:
    lda pad_new
    and #PAD_START
    beq @done
    lda #S_PLAY
    sta state
    QUEUE msg_none
@done:
    rts

@over:
    lda hold
    beq @again
    dec hold
    rts
@again:
    lda pad_new
    beq @done
    jsr screen_off
    jsr new_game
    jmp screen_on

@play:
    lda pad_new
    and #PAD_START
    beq @on
    lda #S_PAUSE
    sta state
    QUEUE msg_pause
    rts
@on:
    jsr steer
    dec wait
    bne @done
    lda speed
    sta wait
    ; (falls through)

; One step: the head goes on, the tail follows unless there was an apple.
step:
    ldx want
    beq @go
    lda opposite,x
    cmp dir
    beq @go                     ; not straight back into itself
    stx dir
@go:
    ldx dir
    lda hx
    clc
    adc dxs,x
    sta nx
    lda hy
    clc
    adc dys,x
    sta ny
    ldx nx
    ldy ny
    jsr cell
    ldy #0
    lda (mp),y
    sta tmp                     ; what is there
    beq @move
    cmp #C_FOOD
    beq @move
    jmp crash                   ; a wall, or the snake
@move:
    lda dir
    sta (mp),y
    lda #T_HEAD
    jsr queue_tile
    ldx hx
    ldy hy
    jsr cell
    ldy #0
    lda dir
    sta (mp),y                  ; the old head: a piece that leads to the new one
    lda #T_BODY
    jsr queue_tile
    lda nx
    sta hx
    lda ny
    sta hy
    lda tmp
    cmp #C_FOOD
    beq @ate
    ; the tail's end goes
    ldx tx
    ldy ty
    jsr cell
    ldy #0
    lda (mp),y
    sta tmp2                    ; where the next piece is
    lda #0
    sta (mp),y
    lda #' '
    jsr queue_tile
    ldx tmp2
    lda tx
    clc
    adc dxs,x
    sta tx
    lda ty
    clc
    adc dys,x
    sta ty
    rts
@ate:
    lda #<score
    sta ptr
    lda #>score
    sta ptr+1
    jsr bump3
    jsr show_score
    inc eaten
    lda eaten
    cmp #FASTER_EVERY
    bcc @apple
    lda #0
    sta eaten
    lda speed
    cmp #FASTEST + 1
    bcc @apple
    dec speed
@apple:
    ; (falls through)

; An apple on a free cell; with none left the game is won.
place_food:
    lda #0
    sta tmp2                    ; 256 tries by chance
@try:
    jsr rand
    and #31
    cmp #LEFTCOL + 1
    bcc @miss
    cmp #RIGHTCOL
    bcs @miss
    sta nx
    jsr rand
    and #31
    cmp #TOPROW + 1
    bcc @miss
    cmp #BOTROW
    bcs @miss
    tay
    ldx nx
    jsr cell
    ldy #0
    lda (mp),y
    beq @here
@miss:
    dec tmp2
    bne @try
    ; then the first free cell there is
    ldy #TOPROW + 1
@row:
    ldx #LEFTCOL + 1
@column:
    stx nx
    sty ny
    jsr cell
    ldy #0
    lda (mp),y
    beq @here
    ldx nx
    ldy ny
    inx
    cpx #RIGHTCOL
    bne @column
    iny
    cpy #BOTROW
    bne @row
    jsr game_over
    QUEUE msg_full
    rts
@here:
    lda #C_FOOD
    sta (mp),y
    lda #T_FOOD
    jmp queue_tile

crash:
    jsr game_over
    QUEUE msg_over
    rts

; The game ends: the score may be the best so far.
game_over:
    lda #S_OVER
    sta state
    lda #45
    sta hold
    ldx #0
@compare:
    lda score,x
    cmp best,x
    bcc @done
    bne @better
    inx
    cpx #3
    bne @compare
@done:
    rts
@better:
    lda score
    sta best
    lda score+1
    sta best+1
    lda score+2
    sta best+2
    ; (falls through)

show_best:
    lda #<best
    sta ptr
    lda #>best
    sta ptr+1
    ldx #BESTCOL
    ldy #SCOREROW
    jmp queue3

show_score:
    lda #<score
    sta ptr
    lda #>score
    sta ptr+1
    ldx #SCORECOL
    ldy #SCOREROW
    jmp queue3

; The direction held on the pad is the way to go next.
steer:
    lda pad
    and #PAD_UP
    beq @down
    lda #D_UP
    bne @set
@down:
    lda pad
    and #PAD_DOWN
    beq @left
    lda #D_DOWN
    bne @set
@left:
    lda pad
    and #PAD_LEFT
    beq @right
    lda #D_LEFT
    bne @set
@right:
    lda pad
    and #PAD_RIGHT
    beq @none
    lda #D_RIGHT
@set:
    sta want
@none:
    rts

; The cell at column X, row Y: mp to its byte in the map, off_lo / off_hi its tile (X and Y are kept).
cell:
    jsr calc_off
    lda off_lo
    sta mp
    lda off_hi
    clc
    adc #>map
    sta mp+1
    rts

; A number by chance in A: eight steps of a 16-bit shift register.
rand:
    ldx #8
@step:
    lsr rng+1
    ror rng
    bcc @same
    lda rng+1
    eor #$b4
    sta rng+1
@same:
    dex
    bne @step
    lda rng
    rts

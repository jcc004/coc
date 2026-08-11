import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'
import {
  cardFraming,
  faceCrop,
  faceCroppedCardIds,
  WHOLE_FRAMING,
  type CardFaceCrop,
} from './card-crops.ts'
import { ALL_CARDS, cardById } from './cards.ts'

/*
 * The art is a purpose-made set, already cropped tight on each subject — for
 * fifty-five of sixty. Five (Golem, Lava Hound, Ice Golem, Cannon Cart, Ice Hound)
 * compose their subject smaller in the canvas than the rest of the set and are
 * corrected individually in `FACE_CROPS`; see that table's own doc comment in
 * `card-crops.ts` for how each one was found and why. Two things are worth
 * pinning here: that the cropped set is exactly those five and not some other
 * count, and that the face-crop arithmetic itself is right — tested directly on
 * `faceCrop` below, not only through whatever the table currently holds.
 */

function faceCrops(): { id: number; crop: CardFaceCrop }[] {
  const found: { id: number; crop: CardFaceCrop }[] = []
  for (const card of ALL_CARDS) {
    const framing = cardFraming(card.id)
    if (framing.kind === 'face') found.push({ id: card.id, crop: framing })
  }
  return found
}

describe('cardFraming', () => {
  it('frames every one of the sixty cards', () => {
    for (const card of ALL_CARDS) {
      const framing = cardFraming(card.id)
      assert.ok(
        framing.kind === 'face' || framing.kind === 'whole',
        `card ${card.id} (${card.name}) has no framing`,
      )
    }
  })

  it('frames fifty-five of sixty whole, and names exactly the five exceptions', () => {
    // Named per card rather than counted — a count would keep passing while the
    // wrong card was cropped, or while a sixth crop went unnoticed. These five are
    // the ones found by rendering all sixty at real tile size; see `FACE_CROPS`'s
    // doc comment in card-crops.ts for what each one's actual defect was.
    const cropped = faceCrops().map(({ id }) => `${id} ${cardById(id)?.name}`)
    assert.deepEqual(cropped, [
      '23 Golem',
      '25 Lava Hound',
      '27 Ice Golem',
      '39 Cannon Cart',
      '59 Ice Hound',
    ])
    assert.deepEqual(faceCroppedCardIds(), [23, 25, 27, 39, 59])
  })

  it('hands out the one shared whole framing, so two tiles compare by identity', () => {
    assert.equal(cardFraming(1), WHOLE_FRAMING)
    assert.equal(cardFraming(CARD_ID_MAX), WHOLE_FRAMING)
  })

  it('gives an unknown id the default instead of throwing', () => {
    assert.deepEqual(cardFraming(0), WHOLE_FRAMING)
    assert.deepEqual(cardFraming(CARD_ID_MAX + 1), WHOLE_FRAMING)
    assert.deepEqual(cardFraming(-3), WHOLE_FRAMING)
  })

  /*
   * These three run over today's real entries, not vacuously — and they stay the
   * guard rails for the next one too, whether that is another per-card fix or a
   * wholesale regeneration of the art: they fail rather than pass silently if an
   * entry names a card that does not exist or a window that runs off the edge of
   * its picture.
   */
  it('crops only real card ids', () => {
    for (const id of faceCroppedCardIds()) {
      assert.ok(id >= CARD_ID_MIN && id <= CARD_ID_MAX, `crop ${id} is outside 1–60`)
      assert.ok(cardById(id), `crop ${id} names no card`)
    }
  })

  it('keeps every window inside the picture it crops', () => {
    for (const { id, crop } of faceCrops()) {
      const half = 50 / crop.zoom
      const name = cardById(id)?.name ?? id
      assert.ok(crop.y >= half - 1e-9, `${name}: y ${crop.y} runs off the top (half ${half})`)
      assert.ok(crop.y <= 100 - half + 1e-9, `${name}: y ${crop.y} runs off the bottom`)
      assert.ok(crop.x >= half - 1e-9, `${name}: x ${crop.x} runs off the left`)
      assert.ok(crop.x <= 100 - half + 1e-9, `${name}: x ${crop.x} runs off the right`)
    }
  })

  /*
   * The test above only checks the *post-clamp* value stays in range — it would
   * pass silently even if `clampCenter` had actually substituted a different
   * number than the one written in `FACE_CROPS`. Every entry here keeps a real
   * margin from its own clamp floor (`50 / zoom`) on purpose — Cannon Cart, the
   * tightest of the five at `zoom: 1.5`, still has a floor of `33.3`, comfortably
   * clear of both its `x: 44` and `y: 54` — so nothing here relies on the clamp to
   * do anything today. Pinning the table's exact values here, unclamped, is what
   * would fail loudly if a future edit ever pushed one of them past its floor,
   * instead of the chosen crop point quietly drifting from what someone actually
   * reviewed.
   */
  it('never actually needs to clamp its five current entries', () => {
    assert.deepEqual(cardFraming(23), { kind: 'face', x: 50, y: 50, zoom: 1.15 })
    assert.deepEqual(cardFraming(25), { kind: 'face', x: 50, y: 48, zoom: 1.2 })
    assert.deepEqual(cardFraming(27), { kind: 'face', x: 50, y: 54, zoom: 1.28 })
    assert.deepEqual(cardFraming(39), { kind: 'face', x: 44, y: 54, zoom: 1.5 })
    assert.deepEqual(cardFraming(59), { kind: 'face', x: 46, y: 50, zoom: 1.2 })
  })

  it('never zooms out past the frame, nor so far in that the art cannot carry it', () => {
    for (const { id, crop } of faceCrops()) {
      const name = cardById(id)?.name ?? id
      assert.ok(crop.zoom >= 1, `${name}: zoom ${crop.zoom} is under 1`)
      assert.ok(crop.zoom <= 3, `${name}: zoom ${crop.zoom} crops past what 320px can carry`)
    }
  })
})

/*
 * The clamp arithmetic itself, tested directly on `faceCrop` rather than only
 * through whatever cards `FACE_CROPS` currently corrects — the same reasoning
 * as the top-of-file comment: today's entries exercise the arithmetic that already
 * matters, but not every value combination it has to handle correctly.
 */
describe('faceCrop', () => {
  it('passes a window that already fits through untouched', () => {
    assert.deepEqual(faceCrop(50, 50, 2), { kind: 'face', x: 50, y: 50, zoom: 2 })
  })

  it('pulls a window back inside the picture rather than showing empty frame', () => {
    // At zoom 2 the window is half the picture, so its center cannot go nearer an
    // edge than 25% without part of the frame falling outside the image.
    assert.deepEqual(faceCrop(0, 0, 2), { kind: 'face', x: 25, y: 25, zoom: 2 })
    assert.deepEqual(faceCrop(100, 100, 2), { kind: 'face', x: 75, y: 75, zoom: 2 })
  })

  it('clamps a tight crop less, because a small window can sit nearer the edge', () => {
    // The whole point of the clamp being a function of zoom: at 4 the window is a
    // quarter of the picture, so 12.5% is as close to the top as a head can be.
    assert.deepEqual(faceCrop(10, 5, 4), { kind: 'face', x: 12.5, y: 12.5, zoom: 4 })
  })

  it('collapses to the center at zoom 1, where the window is the whole picture', () => {
    assert.deepEqual(faceCrop(20, 80, 1), { kind: 'face', x: 50, y: 50, zoom: 1 })
  })
})

describe('the art behind the framing', () => {
  /*
   * This replaces a test that asserted the *opposite*: the wiki art had one Baby
   * Dragon file serving cards 11 and 38, so the two tiles were the same picture and
   * the test pinned their crops as equal. The purpose-made set draws each card
   * separately, so that limitation is gone, and what is worth guarding now is that
   * it stays gone — a regeneration that reused one file for two cards would give the
   * grid two identical tiles, which reads as a bug in the grid.
   */
  it('gives every one of the sixty cards its own picture', () => {
    const byImage = new Map<string, string[]>()
    for (const card of ALL_CARDS) {
      const shared = byImage.get(card.image) ?? []
      shared.push(`${card.id} ${card.name}`)
      byImage.set(card.image, shared)
    }
    const reused = [...byImage.entries()]
      .filter(([, cards]) => cards.length > 1)
      .map(([image, cards]) => `${image}: ${cards.join(', ')}`)

    assert.deepEqual(reused, [])
    assert.equal(byImage.size, ALL_CARDS.length)
  })

  it('draws the two Baby Dragons separately, one per deck', () => {
    // The pair the old test was about, called out by name: they are different cards
    // in different decks, and now different pictures, so the deck frame is no longer
    // the only thing telling them apart.
    const home = cardById(11)
    const builder = cardById(38)
    assert.equal(home?.name, 'Baby Dragon')
    assert.equal(builder?.name, 'Baby Dragon (Builder)')
    assert.notEqual(home?.image, builder?.image)
  })
})

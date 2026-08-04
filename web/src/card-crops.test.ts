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
 * The art is a purpose-made set, already cropped tight on each subject, so every
 * tile is framed whole and the crop table is empty. Two things are worth pinning:
 * that it really is *every* card and not fifty-nine of them, and that the face-crop
 * path still works — it is kept for the next time the art is regenerated, and an
 * empty table means the usual "check each entry" tests would pass vacuously. So the
 * arithmetic is tested directly, on `faceCrop`, rather than over no data at all.
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

  it('frames all sixty whole, because the art arrives already cropped', () => {
    // The switchover this file exists to record: the pictures are 256×320 and tight
    // on their subject, and `.card-tile__frame` is 4:5 to match, so re-cropping
    // would zoom into a face that already fills the frame. Named per card rather
    // than counted — a count would keep passing while the wrong one was cropped.
    const cropped = faceCrops().map(({ id }) => `${id} ${cardById(id)?.name}`)
    assert.deepEqual(cropped, [])
    assert.deepEqual(faceCroppedCardIds(), [])
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
   * These three describe the crop table as it *would* be used. They pass over an
   * empty table today; they are the guard rails for the next set of art, and they
   * fail rather than pass silently if somebody adds an entry for a card that does
   * not exist or a window that runs off the edge of its picture.
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

  it('never zooms out past the frame, nor so far in that the art cannot carry it', () => {
    for (const { id, crop } of faceCrops()) {
      const name = cardById(id)?.name ?? id
      assert.ok(crop.zoom >= 1, `${name}: zoom ${crop.zoom} is under 1`)
      assert.ok(crop.zoom <= 3, `${name}: zoom ${crop.zoom} crops past what 320px can carry`)
    }
  })
})

/*
 * The face path, kept for the next regeneration of the art and therefore tested on
 * its own rather than through a table that has no entries in it.
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

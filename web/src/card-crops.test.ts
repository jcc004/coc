import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'
import {
  cardFraming,
  DEFAULT_CROP,
  overriddenCardIds,
  wholeFramedCardIds,
  type CardFaceCrop,
} from './card-crops.ts'
import { ALL_CARDS, cardById } from './cards.ts'

/*
 * The crop table is hand-tuned by eye, which is exactly the kind of data that rots
 * — a card renamed, an id renumbered, a decimal fat-fingered — and the symptom is a
 * tile that quietly frames a patch of grass. None of that is visible in a
 * screenshot of the other fifty-nine, so it is checked here instead.
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

  it('has been tuned for all sixty, leaving none on the untested default', () => {
    // The default is the safety net for a card the table has not seen — a new one
    // in next year's manifest. Every card that exists today has been looked at, so
    // a gap here means one was added and never framed.
    const missing = ALL_CARDS.filter((card) => !overriddenCardIds().includes(card.id)).map(
      (card) => `${card.id} ${card.name}`,
    )
    assert.deepEqual(missing, [])
  })

  it('gives an unknown id the default instead of throwing', () => {
    assert.deepEqual(cardFraming(0), DEFAULT_CROP)
    assert.deepEqual(cardFraming(CARD_ID_MAX + 1), DEFAULT_CROP)
    assert.deepEqual(cardFraming(-3), DEFAULT_CROP)
  })

  it('overrides only real card ids', () => {
    for (const id of overriddenCardIds()) {
      assert.ok(id >= CARD_ID_MIN && id <= CARD_ID_MAX, `override ${id} is outside 1–60`)
      assert.ok(cardById(id), `override ${id} names no card`)
    }
  })

  it('keeps every window inside the picture it crops', () => {
    // The window is 1/zoom of the image tall and centred on `y`, so a centre
    // nearer an edge than half a window would show empty frame beside the art.
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
    // Below 1 the image would be shorter than the frame; past ~3 a 256px source is
    // showing under 64 real pixels, which no amount of upscaling rescues.
    for (const { id, crop } of faceCrops()) {
      const name = cardById(id)?.name ?? id
      assert.ok(crop.zoom >= 1, `${name}: zoom ${crop.zoom} is under 1`)
      assert.ok(crop.zoom <= 3, `${name}: zoom ${crop.zoom} crops past what 256px can carry`)
    }
  })

  it('frames the vehicles and the building whole rather than cropping a face', () => {
    // Named, not counted: the point of the list is *which* cards have no face, and
    // a count would keep passing while the wrong five were in it.
    const whole = wholeFramedCardIds().map((id) => cardById(id)?.name)
    assert.deepEqual(whole, [
      'Balloon',
      'Furnace',
      'Cannon Cart',
      'Drop Ship',
      'Rocket Balloon',
    ])
  })

  it('gives the two Baby Dragons the same crop, since they share one picture', () => {
    const home = cardById(11)
    const builder = cardById(38)
    assert.equal(home?.image, builder?.image)
    assert.deepEqual(cardFraming(11), cardFraming(38))
  })
})

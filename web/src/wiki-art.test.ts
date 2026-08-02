import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WIKI_ART } from './wiki-art.generated.ts'
import { artFor, normaliseArtName, townHallArt } from './wiki-art.ts'

/*
 * The map in wiki-art.generated.ts is machine-written from the wiki; the lookup
 * around it is not, and it is the piece that rots quietly. Two failure modes are
 * worth catching in a test rather than in a screenshot months later:
 *
 *  - a name that used to resolve stops resolving (the wiki renamed or lost a file,
 *    or a regeneration dropped it), and
 *  - a name that should NOT resolve starts resolving to something adjacent, which
 *    shows a confidently wrong troop icon — worse than a missing one.
 *
 * The names asserted below have been in the game since launch, so a failure here
 * is a real regression and not the wiki reorganising this week's content.
 */

describe('normaliseArtName', () => {
  it('folds case', () => {
    assert.equal(normaliseArtName('Barbarian King'), 'barbarianking')
    assert.equal(normaliseArtName('BARBARIAN KING'), 'barbarianking')
    assert.equal(normaliseArtName('barbarian king'), 'barbarianking')
  })

  it('drops the punctuation the API and the wiki disagree about', () => {
    // The API ships these with dots; nothing else in the pipeline needs to care.
    assert.equal(normaliseArtName('P.E.K.K.A'), 'pekka')
    assert.equal(normaliseArtName('L.A.S.S.I'), 'lassi')
    assert.equal(normaliseArtName('C.O.O.K.I.E'), 'cookie')
  })

  it('treats spacing and hyphenation as noise', () => {
    assert.equal(normaliseArtName('Super  Barbarian'), 'superbarbarian')
    assert.equal(normaliseArtName('  Super Barbarian  '), 'superbarbarian')
    assert.equal(normaliseArtName('Super-Barbarian'), 'superbarbarian')
    assert.equal(normaliseArtName('SuperBarbarian'), 'superbarbarian')
  })

  it('folds both apostrophe glyphs to the same key', () => {
    assert.equal(normaliseArtName("Builder's Workshop"), normaliseArtName('Builder’s Workshop'))
  })

  it('strips accents, so a decorated spelling still lands on the plain key', () => {
    assert.equal(normaliseArtName('Bàrbarian'), 'barbarian')
    assert.equal(normaliseArtName('Valkýrie'), 'valkyrie')
  })

  it('collapses a name with nothing to key on to the empty string', () => {
    assert.equal(normaliseArtName(''), '')
    assert.equal(normaliseArtName('  ...  '), '')
  })
})

describe('artFor', () => {
  it('resolves long-standing names to a vendored path', () => {
    for (const [kind, name] of [
      ['hero', 'Barbarian King'],
      ['hero', 'Archer Queen'],
      ['troop', 'Barbarian'],
      ['troop', 'P.E.K.K.A'],
      ['spell', 'Lightning Spell'],
      ['equipment', 'Giant Gauntlet'],
    ] as const) {
      const src = artFor(kind, name)
      assert.ok(src, `${kind}/${name} should resolve`)
      // The extension follows whatever the wiki's thumbnailer returned — it
      // answers WebP even for a `File:….png` — so this must not pin one format.
      assert.match(src, /^\/coc\/wiki\/[a-z]+\/[a-z0-9-]+\.(webp|png|jpg)$/)
    }
  })

  it('names every vendored file by a format a browser can decode', () => {
    /*
     * Guards what made these wrong before: the script assumed `.png` and wrote
     * WebP bytes under it. That renders in dev, but production types static
     * files by extension and the deployed Nginx sends
     * X-Content-Type-Options: nosniff, so bytes and declared type must agree.
     */
    for (const src of Object.values(WIKI_ART)) {
      assert.match(src, /\.(webp|png|jpg)$/, `${src} has no usable image extension`)
    }
  })

  it('resolves the same name however it is punctuated or cased', () => {
    const expected = artFor('troop', 'P.E.K.K.A')
    assert.ok(expected)
    assert.equal(artFor('troop', 'pekka'), expected)
    assert.equal(artFor('troop', 'P E K K A'), expected)
    assert.equal(artFor('troop', 'p.e.k.k.a'), expected)
  })

  it('returns nothing for a name it has no art for', () => {
    assert.equal(artFor('troop', 'Nonexistent Wizard'), undefined)
    assert.equal(artFor('equipment', 'Gauntlet of Nothing'), undefined)
    assert.equal(artFor('troop', ''), undefined)
  })

  it('never falls back from a "Super" form to the base unit', () => {
    // Super Goblin is not a unit, so it has no art — and must not borrow the
    // Goblin's, which does. This is the whole no-wrong-icon rule in one case.
    assert.ok(artFor('troop', 'Goblin'))
    assert.equal(artFor('troop', 'Super Goblin'), undefined)
  })

  it('resolves the Super forms that do have their own art', () => {
    const barbarian = artFor('troop', 'Barbarian')
    const superBarbarian = artFor('troop', 'Super Barbarian')
    assert.ok(superBarbarian)
    assert.notEqual(superBarbarian, barbarian)
  })

  it('keeps kinds apart, so a hero cannot answer for a spell', () => {
    assert.ok(artFor('hero', 'Barbarian King'))
    assert.equal(artFor('spell', 'Barbarian King'), undefined)
    assert.ok(artFor('equipment', 'Giant Gauntlet'))
    assert.equal(artFor('troop', 'Giant Gauntlet'), undefined)
  })
})

describe('townHallArt', () => {
  it('covers every Town Hall the game currently has', () => {
    for (let level = 1; level <= 18; level++) {
      assert.ok(townHallArt(level), `TH${level} should resolve`)
    }
  })

  it('returns nothing outside the vendored range, rather than the nearest level', () => {
    assert.equal(townHallArt(0), undefined)
    assert.equal(townHallArt(-1), undefined)
    // A Town Hall 19 profile must render its bare number, not a TH18 badge.
    assert.equal(townHallArt(19), undefined)
  })

  it('rejects a level that is not a whole number', () => {
    assert.equal(townHallArt(12.5), undefined)
    assert.equal(townHallArt(Number.NaN), undefined)
    assert.equal(townHallArt(Number.POSITIVE_INFINITY), undefined)
  })
})

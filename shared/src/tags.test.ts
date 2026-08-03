import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  encodeTagForPath,
  InvalidTagError,
  isValidTag,
  normalizeTag,
  usesCanonicalAlphabet,
} from './tags.ts'

/*
 * `normalizeTag` is the front door for every tag in the system — path parameters,
 * query strings, pasted text and stored rows all pass through it — so what it
 * accepts and how it refuses the rest is a contract, not an implementation detail.
 *
 * The refusal half matters as much as the acceptance half: the app's `onError`
 * branches on `InvalidTagError` to answer 400, and anything else thrown from here
 * becomes a 500. These tests therefore assert the *error type*, not just that
 * something threw.
 */

describe('normalizeTag accepts the shapes people actually send', () => {
  it('returns the canonical #TAG for a bare tag', () => {
    assert.equal(normalizeTag('abc123'), '#ABC123')
  })

  it('accepts a leading hash and keeps exactly one', () => {
    assert.equal(normalizeTag('#abc123'), '#ABC123')
  })

  it('accepts a percent-encoded hash, which is how a tag arrives from a URL', () => {
    assert.equal(normalizeTag('%23ABC123'), '#ABC123')
    assert.equal(normalizeTag('%23abc123'), '#ABC123')
  })

  it('strips whitespace from both ends and from the middle', () => {
    assert.equal(normalizeTag('  #ABC 123  '), '#ABC123')
    assert.equal(normalizeTag('\t#abc\n123 '), '#ABC123')
  })

  it('folds the letter O to zero, because the alphabet has no O', () => {
    // The single most common transcription error: O and 0 are the same glyph to
    // anyone reading a tag off a phone screen.
    assert.equal(normalizeTag('#2PPOJCCLV'), '#2PP0JCCLV')
    assert.equal(normalizeTag('ooo'), '#000')
  })

  it('accepts the shortest and longest tags, three and twelve characters', () => {
    assert.equal(normalizeTag('abc'), '#ABC')
    assert.equal(normalizeTag('a'.repeat(12)), `#${'A'.repeat(12)}`)
  })

  it('is idempotent — normalising its own output changes nothing', () => {
    const once = normalizeTag('#2ppojccLV')
    assert.equal(normalizeTag(once), once)
  })
})

describe('normalizeTag reports malformed input as InvalidTagError, never anything else', () => {
  /**
   * Asserting the *type* is the point. `onError` turns `InvalidTagError` into a 400
   * with the tag rule as a hint and everything else into a 500, so a different error
   * class here is a different HTTP status out there.
   */
  function assertInvalid(input: string, why: string): void {
    assert.throws(
      () => normalizeTag(input),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTagError, `${why} must be an InvalidTagError`)
        assert.equal(error.input, input, 'the error must carry the input it refused')
        return true
      },
      why,
    )
  }

  it('refuses a lone percent sign rather than throwing URIError', () => {
    // A path parameter is already decoded by the time it reaches us, so `%25` on
    // the wire is the string "%" here. `decodeURIComponent` throws URIError on it,
    // which used to escape as a 500 and a stack trace.
    assertInvalid('%', 'a bare percent')
  })

  it('refuses a truncated percent-escape rather than throwing URIError', () => {
    assertInvalid('%ZZ', 'a percent followed by non-hex')
    assertInvalid('%E0%A4%A', 'a truncated UTF-8 escape')
    assertInvalid('ABC%', 'a trailing percent')
    assertInvalid('%%%', 'nothing but percents')
  })

  it('refuses input that is too short or too long', () => {
    assertInvalid('', 'the empty string')
    assertInvalid('ab', 'two characters')
    assertInvalid('#ab', 'two characters behind a hash')
    assertInvalid('a'.repeat(13), 'thirteen characters')
  })

  it('refuses input that is not alphanumeric', () => {
    assertInvalid('#!!!', 'punctuation')
    assertInvalid('abc-123', 'a hyphen')
    assertInvalid('%23!!', 'punctuation behind an encoded hash')
    assertInvalid('ab#c', 'a hash that is not leading')
  })

  it('refuses whitespace-only input, which trims to nothing', () => {
    assertInvalid('   ', 'spaces')
  })
})

describe('isValidTag answers the same question without throwing', () => {
  it('is true for everything normalizeTag accepts', () => {
    for (const input of ['abc', '#abc123', '%23ABC123', '  #ABC 123  ', '2PP0JCCLV']) {
      assert.equal(isValidTag(input), true, `${JSON.stringify(input)} should be valid`)
    }
  })

  it('is false for malformed input, including undecodable input', () => {
    for (const input of ['', 'ab', '%', '%ZZ', 'abc-123', 'a'.repeat(13)]) {
      assert.equal(isValidTag(input), false, `${JSON.stringify(input)} should be invalid`)
    }
  })
})

describe('usesCanonicalAlphabet is advisory, not a gate', () => {
  it('accepts a tag drawn from the documented base-14 alphabet', () => {
    assert.equal(usesCanonicalAlphabet('#2PP0JCCLV'), true)
    assert.equal(usesCanonicalAlphabet('2gcj2qpu'), true)
  })

  it('accepts a tag written with O, because normalisation folds it to zero first', () => {
    assert.equal(usesCanonicalAlphabet('#2PPOJCCLV'), true)
  })

  it('rejects a structurally valid tag using letters outside the alphabet', () => {
    // Still worth sending upstream — the API is the only authority on whether a
    // tag exists — which is why this is a separate advisory function.
    assert.equal(usesCanonicalAlphabet('#ABC123'), false)
    assert.equal(isValidTag('#ABC123'), true, 'and structurally it is still a tag')
  })

  it('is false rather than throwing for input that is not a tag at all', () => {
    for (const input of ['', 'ab', '%', '%ZZ']) {
      assert.equal(usesCanonicalAlphabet(input), false)
    }
  })
})

describe('encodeTagForPath produces a path segment', () => {
  it('percent-encodes the hash, since a bare # would start a fragment', () => {
    assert.equal(encodeTagForPath('#2PP0JCCLV'), '%232PP0JCCLV')
    assert.equal(encodeTagForPath('2pp0jccLV'), '%232PP0JCCLV')
  })

  it('normalises before encoding, so two spellings give one path', () => {
    assert.equal(encodeTagForPath('%23abc 123'), encodeTagForPath('#ABC123'))
  })

  it('throws InvalidTagError on undecodable input instead of building a bad URL', () => {
    // This is the call the CoC client makes first, so an unhandled throw here is
    // what turned a malformed tag into a 500 on the player and clan routes.
    assert.throws(() => encodeTagForPath('%ZZ'), InvalidTagError)
    assert.throws(() => encodeTagForPath('%'), InvalidTagError)
  })
})

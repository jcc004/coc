import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import {
  api,
  ApiError,
  setPasswordChangeRequiredHandler,
  setUnauthorizedHandler,
  // `api.ts` exports a `describe` of its own, and so does the test runner.
  describe as describeCause,
} from './api.ts'

/**
 * What `api.ts` does with a failure, which is the part of it that is not a list of
 * endpoints.
 *
 * Two statuses are not the caller's business: a 401 means the session went away
 * under a tab that was already open, and a 403 carrying `passwordChangeRequired`
 * means an admin flagged the account since it signed in. Both have to unwind the
 * whole app rather than surface as red text inside whichever panel happened to ask
 * first — and both have exceptions, because the login form's 401 *is* its answer.
 * Getting the exception wrong in either direction is invisible until somebody
 * cannot sign in.
 *
 * `fetch` is replaced with a real `Response`, not a hand-rolled shape: the body is
 * parsed with `response.json()` inside a `catch`, and only a genuine `Response` gets
 * that path right for the 502 HTML case.
 */

const UNAUTHORIZED_BODY = {
  error: { status: 401, reason: 'unauthorized', message: 'Sign in to continue.' },
}

const PASSWORD_CHANGE_BODY = {
  error: {
    status: 403,
    reason: 'passwordChangeRequired',
    message: 'Change your password to continue.',
    hint: 'An admin issued you a temporary one.',
  },
}

const FORBIDDEN_BODY = {
  error: {
    status: 403,
    reason: 'forbidden',
    message: 'An admin assigns ownership of a base.',
    hint: 'Ask an admin.',
  },
}

/** The page nginx serves when the API is down: a 502 whose body is not JSON. */
const GATEWAY_HTML = '<html><head><title>502 Bad Gateway</title></head></html>'

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Sent {
  input: RequestInfo | URL
  init: RequestInit | undefined
}

/** Every request in the test gets the same answer. Returns what was sent, as it fills. */
function serving(response: Response): Sent[] {
  const sent: Sent[] = []
  mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ input, init })
    return Promise.resolve(response)
  })
  return sent
}

/** The `ApiError` a call threw. Fails the test if it threw something else, or nothing. */
async function rejection(call: () => Promise<unknown>): Promise<ApiError> {
  try {
    await call()
  } catch (cause) {
    assert.ok(cause instanceof ApiError, 'every failure out of `api` is an ApiError')
    return cause
  }
  throw new Error('the request resolved when it was expected to fail')
}

afterEach(() => {
  mock.restoreAll()
  // Module-level in `api.ts`, so a handler left set here is one the next test inherits.
  setUnauthorizedHandler(null)
  setPasswordChangeRequiredHandler(null)
})

describe('a 401', () => {
  it('unwinds the app to the login screen', async () => {
    let bounced = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    serving(answer(401, UNAUTHORIZED_BODY))

    const failure = await rejection(() => api.savedClans())

    assert.equal(bounced, 1)
    // Still thrown as well: the caller has to stop, not carry on with no data.
    assert.equal(failure.status, 401)
  })

  it('is left to the login form, which asked the question it answers', async () => {
    let bounced = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    serving(answer(401, { error: { status: 401, reason: 'invalidCredentials', message: 'Wrong.' } }))

    const failure = await rejection(() => api.login('rae@example.com', 'nope'))

    // Bouncing here would clear the form and look like nothing happened.
    assert.equal(bounced, 0)
    assert.equal(failure.message, 'Wrong.')
  })

  it('is left to the boot probe, where it is the normal not-signed-in answer', async () => {
    let bounced = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    serving(answer(401, UNAUTHORIZED_BODY))

    await rejection(() => api.me())

    assert.equal(bounced, 0)
  })

  it('is left to the password form, where it means the current password is wrong', async () => {
    let bounced = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    serving(answer(401, { error: { status: 401, reason: 'invalidCredentials', message: 'Wrong.' } }))

    await rejection(() => api.changePassword('wrong', 'AlsoWrong123!'))

    assert.equal(bounced, 0)
  })

  it('does not reach the forced-password-change handler', async () => {
    let prompted = 0
    setPasswordChangeRequiredHandler(() => {
      prompted += 1
    })
    serving(answer(401, UNAUTHORIZED_BODY))

    await rejection(() => api.savedClans())

    assert.equal(prompted, 0)
  })
})

describe('a 403', () => {
  it('prompts for a password change when that is the reason given', async () => {
    let prompted = 0
    setPasswordChangeRequiredHandler(() => {
      prompted += 1
    })
    serving(answer(403, PASSWORD_CHANGE_BODY))

    const failure = await rejection(() => api.savedClans())

    assert.equal(prompted, 1)
    assert.equal(failure.reason, 'passwordChangeRequired')
  })

  /*
   * The routing is on the `reason` in the body and not on the status, because most
   * 403s here are ordinary refusals — assigning an owner as a member, say — and
   * throwing up a change-your-password screen over one would be nonsense.
   */
  it('is an ordinary refusal for any other reason', async () => {
    let prompted = 0
    setPasswordChangeRequiredHandler(() => {
      prompted += 1
    })
    serving(answer(403, FORBIDDEN_BODY))

    const failure = await rejection(() => api.assignOwner('#G88CYQP', 2))

    assert.equal(prompted, 0)
    // And the server's own wording survives, because it is what states the rule.
    assert.equal(failure.message, 'An admin assigns ownership of a base.')
  })

  it('does not reach the unauthorized handler', async () => {
    let bounced = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    serving(answer(403, PASSWORD_CHANGE_BODY))

    await rejection(() => api.savedClans())

    assert.equal(bounced, 0)
  })

  it('fires nothing at all when no handler has been set', async () => {
    serving(answer(403, PASSWORD_CHANGE_BODY))
    // Before the session hook mounts there is no handler; the call must still fail
    // cleanly rather than throw on a null call.
    assert.equal((await rejection(() => api.savedClans())).status, 403)
  })
})

describe('ApiError', () => {
  it('carries the whole error body through to the caller', async () => {
    serving(answer(403, FORBIDDEN_BODY))

    const failure = await rejection(() => api.assignOwner('#G88CYQP', 2))

    assert.equal(failure.status, 403)
    assert.equal(failure.reason, 'forbidden')
    assert.equal(failure.message, 'An admin assigns ownership of a base.')
    assert.equal(failure.hint, 'Ask an admin.')
    assert.equal(failure.name, 'ApiError')
  })

  it('reads as a sentence when the body is not JSON at all', async () => {
    serving(new Response(GATEWAY_HTML, { status: 502, headers: { 'Content-Type': 'text/html' } }))

    const failure = await rejection(() => api.savedClans())

    // The parse failure is swallowed on purpose: "Unexpected token <" tells a user
    // nothing, and the status is the only fact there is.
    assert.equal(failure.status, 502)
    assert.equal(failure.reason, 'unknown')
    assert.equal(failure.message, 'Request failed with status 502')
    assert.equal(failure.hint, undefined)
  })

  it('reads the same way for an empty body', async () => {
    serving(answer(500))

    const failure = await rejection(() => api.savedClans())

    assert.equal(failure.reason, 'unknown')
    assert.equal(failure.message, 'Request failed with status 500')
  })
})

describe('describe', () => {
  it('uses an ApiError message verbatim, because it was written for a person', () => {
    assert.equal(
      describeCause(new ApiError(403, 'forbidden', 'An admin assigns ownership of a base.')),
      'An admin assigns ownership of a base.',
    )
    assert.equal(describeCause(new ApiError(0, 'network', 'Request failed')), 'Request failed')
  })

  it('says the server could not be reached for anything else', () => {
    // Anything reaching a catch block that is not an ApiError is a fetch that never
    // got an answer, whatever shape it arrived in.
    assert.equal(describeCause(new TypeError('Failed to fetch')), 'Could not reach the server.')
    assert.equal(describeCause('Failed to fetch'), 'Could not reach the server.')
    assert.equal(describeCause(undefined), 'Could not reach the server.')
    assert.equal(describeCause(null), 'Could not reach the server.')
  })
})

describe('the request itself', () => {
  it('parses and returns the body of a successful response, firing no handler', async () => {
    let bounced = 0
    let prompted = 0
    setUnauthorizedHandler(() => {
      bounced += 1
    })
    setPasswordChangeRequiredHandler(() => {
      prompted += 1
    })
    serving(answer(200, { clans: [] }))

    assert.deepEqual(await api.savedClans(), { clans: [] })
    assert.deepEqual([bounced, prompted], [0, 0])
  })

  it('normalizes and encodes a tag into the path', async () => {
    const sent = serving(answer(200, { tag: '#G88CYQP' }))

    await api.player(' g88cyqp ')

    // An unencoded `#` would truncate the URL at the first character of the tag.
    assert.equal(sent[0]?.input, '/api/players/%23G88CYQP')
  })

  it('sends the session cookie and nothing else on a GET', async () => {
    const sent = serving(answer(200, { clans: [] }))

    await api.savedClans()

    const init = sent[0]?.init
    // The cookie is the whole mechanism; there is no token in JS or in storage.
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.body, undefined)
    // No Content-Type, because there is no content.
    assert.deepEqual(init?.headers, { Accept: 'application/json' })
  })

  it('serializes a body and declares it', async () => {
    const sent = serving(answer(200, { ok: true }))

    await api.logout()

    const init = sent[0]?.init
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, '{}')
    assert.deepEqual(init?.headers, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
  })
})

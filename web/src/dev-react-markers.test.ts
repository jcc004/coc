import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The half of `update.sh`'s development-React alarm that lives in React rather than
 * in the script.
 *
 * `deploy/update.sh` warns when the built bundle contains text that only React's
 * development build carries (`dev_react_markers` there). That replaced a byte limit
 * that stopped meaning anything once the app grew past it, and it trades one way of
 * going quiet for another: React owns that wording, so an upgrade can change it and
 * leave an alarm that still runs and can no longer fire. Nothing fails, and nothing
 * would until somebody deployed a development build for a day, which is how the
 * alarm came to exist. This fails on the upgrade instead.
 *
 * The list is read out of `update.sh` rather than retyped here, so there is one copy.
 * Each marker has to be in React's development build and absent from its production
 * build; both directions matter, since a marker the production build also carries
 * would warn on every deploy.
 */

const nodeRequire = createRequire(import.meta.url)

/**
 * A file from inside a package's `cjs/` directory. React's `exports` map does not
 * expose `cjs/`, so a subpath import throws, but it does expose `package.json`, which
 * is enough to find the directory.
 */
function packageFile(pkg: string, file: string): string {
  const root = dirname(nodeRequire.resolve(`${pkg}/package.json`))
  return readFileSync(join(root, file), 'utf8')
}

/**
 * `dev_react_markers=( … )` out of `deploy/update.sh`: one single-quoted string per
 * line, with blank and comment lines allowed between them.
 */
function markersFromUpdateScript(): string[] {
  const script = readFileSync(new URL('../../deploy/update.sh', import.meta.url), 'utf8')
  const block = /^dev_react_markers=\(\n([\s\S]*?)^\)/m.exec(script)
  assert.ok(block, 'dev_react_markers=( … ) is gone from deploy/update.sh, or was reformatted')
  return (block[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      // Anything else is an error rather than a skip: a double-quoted marker would
      // otherwise drop out of this test while staying in the script, and go unchecked.
      const quoted = /^'([^']+)'$/.exec(line)
      assert.ok(quoted, `cannot read this dev_react_markers line as a single-quoted string: ${line}`)
      return quoted[1] ?? ''
    })
}

describe('the development-React alarm in deploy/update.sh', () => {
  const markers = markersFromUpdateScript()
  // What Vite bundles for this app: `react`, and `react-dom/client`.
  const development =
    packageFile('react', 'cjs/react.development.js') +
    packageFile('react-dom', 'cjs/react-dom-client.development.js')
  const production =
    packageFile('react', 'cjs/react.production.js') +
    packageFile('react-dom', 'cjs/react-dom-client.production.js')

  it('has at least one marker to look for', () => {
    assert.ok(markers.length >= 1, 'no markers were read out of update.sh')
  })

  for (const marker of markers) {
    it(`"${marker}" is in React's development build and not its production one`, () => {
      assert.ok(
        development.includes(marker),
        `React's development build no longer contains "${marker}". An upgrade changed the ` +
          'wording: update dev_react_markers in deploy/update.sh, or the alarm cannot fire.',
      )
      assert.ok(
        !production.includes(marker),
        `React's production build contains "${marker}", so update.sh would warn on every ` +
          'deploy. Remove it from dev_react_markers in deploy/update.sh.',
      )
    })
  }
})

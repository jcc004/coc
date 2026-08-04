/**
 * The changelog payload, alone in a module so it can be a chunk of its own.
 *
 * This file exists for one reason and it is a measured one. `__BUILD_CHANGES__` is
 * the whole commit-message history — 130KB and growing by every commit — and a
 * `define` substitutes it into whichever module names the identifier. Named from
 * `changelog.ts`, which `App.tsx` imports, it landed in the main bundle: 374KB
 * became 507KB, past Vite's own 500KB chunk warning, for a page most sessions never
 * open. **And this app redeploys on every commit**, so that bundle is re-fetched
 * constantly and the payload inside it only ever grows.
 *
 * Nothing but the identifier is here, and nothing imports this statically. That is
 * what lets Rollup put it in a separate chunk, fetched by `loadChanges()` when
 * somebody actually opens `#/whats-new`.
 *
 * It is **not** a generated file. There is no build step that writes it and nothing
 * in it to hand-edit — the value arrives through `vite.config.ts`'s `define`, the
 * same way `build-info.ts` receives the commit and the build time. The three
 * machine-written modules `CLAUDE.md` names are still three.
 */

declare const __BUILD_CHANGES__: string

/** The JSON `vite.config.ts` baked in. `''` when the build had no git. */
export const BUILD_CHANGES_JSON: string = __BUILD_CHANGES__

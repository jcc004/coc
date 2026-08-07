import type { Context } from 'hono'
import type { ApiErrorResponse } from '@coc/shared'

/**
 * The one error envelope every route answers with. Lives here rather than in
 * `app.ts` so the auth middleware can produce the same shape without importing
 * the app it is mounted on.
 */
export function errorBody(
  status: number,
  reason: string,
  message: string,
  hint?: string,
): ApiErrorResponse {
  return { error: { status, reason, message, ...(hint ? { hint } : {}) } }
}

/**
 * Best-effort JSON body as a plain object: `{}` for no body, invalid JSON, or
 * a JSON value that parsed but isn't an object (an array, a bare string or
 * number). Every write route reads its body this way and then checks the
 * specific fields it needs, rather than rejecting up front on a shape none of
 * them can name yet — that's each route's own job, field by field.
 *
 * Was copy-pasted identically into `auth/routes.ts`, `cards/routes.ts`,
 * `cards/trade-routes.ts`, `progress/routes.ts` and `shared-data/routes.ts`.
 * `base-order/routes.ts` has its own `readJson` that returns the parsed value
 * unnarrowed — a real difference, not the same duplication, so it stays
 * local rather than being folded in here.
 *
 * Typed against the bare Hono `Context`, not this app's `AuthContext`: the
 * body only ever touches `c.req`, and importing `AuthContext` from
 * `auth/middleware.ts` here would point the dependency back at a module that
 * already imports `errorBody` from this one.
 */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

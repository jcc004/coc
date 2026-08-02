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

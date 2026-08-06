/**
 * A signed-in user's own base ordering, as it crosses the wire —
 * `server/src/base-order/routes.ts` is the only code that answers with or
 * accepts this shape.
 *
 * `GET /api/base-order` answers `BaseOrderResponse`: the caller's saved order,
 * exactly as stored, which may be a subset of what they currently own — see
 * `web/src/base-order.ts`'s `reconcileOrder` for how the client fills that back
 * in for display.
 *
 * `PUT /api/base-order`'s body is **not** wrapped in `{ tags }` the way the
 * response is — it is the bare array, `SaveBaseOrderRequest`. There is only ever
 * one thing being replaced, so a wrapper key would be nothing to unwrap on
 * either end; `parseTagOrder` on the server rejects a body that is not itself an
 * array. The response to a successful `PUT` is a `BaseOrderResponse`, the same
 * shape `GET` answers with.
 */
export interface BaseOrderResponse {
  tags: string[]
}

/** What `PUT /api/base-order` accepts: the caller's whole new order. */
export type SaveBaseOrderRequest = string[]

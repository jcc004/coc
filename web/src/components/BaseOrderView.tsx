import { useMemo, useState, type DragEvent } from 'react'
import type { SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { alphabetizeTags, moveTag, useBaseOrder } from '../base-order.ts'
import { tagsInScope } from '../base-scope.ts'
import { useOwners, useOwnersState } from '../owners.ts'
import { ErrorPanel, Loading } from './primitives.tsx'

/**
 * `#/base-order` — the order this account's own bases appear in, wherever a
 * later page chooses to read it. Setting the order is all this page does;
 * `CardsView`'s Mine picker and `ProgressGridView`'s "just me" Owner filter
 * both read it (via `useBaseOrder`'s read side, `applyBaseOrder`), but neither
 * writes to it — this is the only page that calls `reorder()`.
 *
 * The list is this account's owned tags only (`tagsInScope(..., 'mine', ...)`,
 * the same rule `CardsView`'s Mine filter uses), reconciled against whatever
 * order was last saved by `useBaseOrder`. Reordering is native HTML5
 * drag-and-drop — `draggable` plus the three DOM events below — because nothing
 * in this app pulls in a library for an interaction it can hand-roll, and this is
 * the first drag-and-drop here to make that call for. The **Move up / Move
 * down** buttons beside each row are not a fallback bolted on afterward: a mouse
 * drag has no keyboard or screen-reader equivalent at all, so without them this
 * page would have a control only some visitors could use.
 *
 * Every reorder saves immediately (`useBaseOrder`'s `reorder`) rather than
 * behind a Save button — the server accepts a partial list, so there is no
 * correctness reason to batch, and a page that has to be told to keep what it
 * already shows you is one more step to forget.
 */

function DragHandle() {
  return (
    <span className="base-order-list__handle" aria-hidden="true">
      ⠿
    </span>
  )
}

function BaseOrderRow({
  tag,
  label,
  index,
  count,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
  onSendToTop,
  onSendToEnd,
}: {
  tag: string
  label: string
  index: number
  count: number
  dragging: boolean
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
  onMove: (delta: -1 | 1) => void
  onSendToTop: () => void
  onSendToEnd: () => void
}) {
  const className = [
    'base-order-list__item',
    dragging ? 'base-order-list__item--dragging' : '',
    dropTarget ? 'base-order-list__item--over' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={className}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <DragHandle />
      <span className="base-order-list__label">{label}</span>
      <span className="base-order-list__tag tag-cell">{tag}</span>
      <span className="base-order-list__move">
        <button
          type="button"
          className="icon-button"
          onClick={onSendToTop}
          disabled={index === 0}
          aria-label={`Move ${label} to top`}
        >
          ⇈
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={`Move ${label} up`}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label={`Move ${label} down`}
        >
          ↓
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onSendToEnd}
          disabled={index === count - 1}
          aria-label={`Move ${label} to bottom`}
        >
          ⇊
        </button>
      </span>
    </li>
  )
}

export function BaseOrderView({ user }: { user: SessionUser }) {
  const ownersState = useOwnersState()
  const owners = useOwners()

  /* Same "landed or given up" gate `CardsView` uses for its own Mine/All default —
     an empty first snapshot would say this account owns nothing before the owner
     list has actually arrived, and reconciling against that would drop every tag
     from a saved order before there was anything real to compare it to. */
  const ownersReady = ownersState.status === 'ready' || ownersState.status === 'error'

  const scopedBases = useMemo(
    () => owners.map((entry) => ({ tag: entry.tag, ownerUserId: entry.ownerUserId ?? null })),
    [owners],
  )
  const myTags = useMemo(
    () => tagsInScope(scopedBases, 'mine', user.id),
    [scopedBases, user.id],
  )

  const { labelOf } = useBaseLabels(owners, [], myTags)
  const order = useBaseOrder(myTags, ownersReady)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  function handleDragStart(event: DragEvent<HTMLLIElement>, index: number) {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    // Firefox refuses to start a drag unless something is actually placed in
    // the data transfer; the index is never read back out.
    event.dataTransfer.setData('text/plain', String(index))
  }

  function handleDragOver(event: DragEvent<HTMLLIElement>, index: number) {
    // A drop only fires on an element whose dragover handler calls this —
    // native drag-and-drop's own opt-in.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (index !== overIndex) setOverIndex(index)
  }

  function handleDrop(event: DragEvent<HTMLLIElement>, index: number) {
    event.preventDefault()
    const from = dragIndex
    setDragIndex(null)
    setOverIndex(null)
    if (from === null || from === index) return
    order.reorder(moveTag(order.tags, from, index))
  }

  function handleDragEnd() {
    setDragIndex(null)
    setOverIndex(null)
  }

  function moveBy(index: number, delta: -1 | 1) {
    order.reorder(moveTag(order.tags, index, index + delta))
  }

  function sendToTop(index: number) {
    order.reorder(moveTag(order.tags, index, 0))
  }

  function sendToEnd(index: number) {
    order.reorder(moveTag(order.tags, index, order.tags.length))
  }

  function alphabetize() {
    order.reorder(alphabetizeTags(order.tags, labelOf))
  }

  const loading = !ownersReady || order.status === 'loading'

  return (
    <section className="card">
      <h1 className="section-title">Base order</h1>
      <p className="empty-hint">
        Drag a base — or use the arrows — to set the order your own bases are listed in.{' '}
        {order.saving ? 'Saving…' : null}
      </p>

      {!loading && order.tags.length > 1 ? (
        <p>
          <button type="button" className="chip" onClick={alphabetize}>
            Alphabetize
          </button>
        </p>
      ) : null}

      {order.error ? <ErrorPanel error={order.error} /> : null}

      {loading ? <Loading what="your base order" /> : null}

      {!loading && myTags.length === 0 ? (
        <p className="empty-hint">
          You do not own any bases yet — ask an admin to assign one to your account.
        </p>
      ) : null}

      {!loading && order.tags.length > 0 ? (
        <ol className="base-order-list" aria-label="Your bases, in order">
          {order.tags.map((tag, index) => (
            <BaseOrderRow
              key={tag}
              tag={tag}
              label={labelOf(tag)}
              index={index}
              count={order.tags.length}
              dragging={dragIndex === index}
              dropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
              onDragStart={(event) => handleDragStart(event, index)}
              onDragOver={(event) => handleDragOver(event, index)}
              onDrop={(event) => handleDrop(event, index)}
              onDragEnd={handleDragEnd}
              onMove={(delta) => moveBy(index, delta)}
              onSendToTop={() => sendToTop(index)}
              onSendToEnd={() => sendToEnd(index)}
            />
          ))}
        </ol>
      ) : null}
    </section>
  )
}

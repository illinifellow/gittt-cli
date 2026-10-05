/**
 * Mouse targets measured from the real layout. Every clickable element is a
 * `Clickable` box; on each mouse report its screen rectangle is read from ink's
 * computed yoga layout at that moment, so hits stay exact however the screen
 * is arranged. The smallest box under the pointer wins; a press may return a
 * drag handler that receives the following moves until the button is released.
 */
import { Box, type BoxProps, type DOMElement } from "ink"
import { useEffect, useRef, type ReactNode } from "react"
import type { MouseEvent } from "./index"

/** A mouse report with coordinates relative to the target box that receives it. */
export type LocalMouseEvent = MouseEvent & { localX: number; localY: number }

/** What a target does with the mouse. */
interface MouseHandlers {
  onClick?: (event: LocalMouseEvent) => void
  onDoubleClick?: (event: LocalMouseEvent) => void
  onRightClick?: (event: LocalMouseEvent) => void
  /** `step` is -1 for wheel up or left, 1 for down or right; `event.kind` tells the axis. */
  onWheel?: (step: number, event: LocalMouseEvent) => void
  /**
   * Left press; a returned function receives every drag move and the release, in coordinates local to this box.
   * A release on the press cell still counts as a click for the targets underneath.
   */
  onPress?: (event: LocalMouseEvent) => ((event: LocalMouseEvent) => void) | void
}

interface Target {
  node: { current: DOMElement | null }
  handlers: { current: MouseHandlers }
}

const targets = new Set<Target>()
let dragging: ((event: LocalMouseEvent) => void) | null = null

const rectangleOf = (element: DOMElement) => {
  let left = 0
  let top = 0
  for (let current: DOMElement | undefined = element; current; current = current.parentNode) {
    if (!current.yogaNode) continue
    left += current.yogaNode.getComputedLeft()
    top += current.yogaNode.getComputedTop()
  }
  return { left, top, width: element.yogaNode?.getComputedWidth() ?? 0, height: element.yogaNode?.getComputedHeight() ?? 0 }
}

/**
 * A box that answers the mouse. One-row boxes clip what does not fit instead of wrapping onto a second row.
 * @param props.children what the box holds
 * @param props.onClick a left click, or a press on an `onPress` target released without moving
 * @param props.onDoubleClick a second left press on the same cell within 400 ms
 * @param props.onRightClick a right press
 * @param props.onWheel wheel or trackpad scrolling over the box
 * @param props.onPress a left press; may return the drag handler
 * @param props.box every other prop goes to ink's Box
 */
export const Clickable = ({ children, onClick, onDoubleClick, onRightClick, onWheel, onPress, ...box }: BoxProps & MouseHandlers & { children?: ReactNode }) => {
  const node = useRef<DOMElement | null>(null)
  const handlers = useRef<MouseHandlers>({})
  handlers.current = { onClick, onDoubleClick, onRightClick, onWheel, onPress }
  useEffect(() => {
    const target: Target = { node, handlers }
    targets.add(target)
    return () => void targets.delete(target)
  }, [])
  return <Box ref={node} overflow={box.height === 1 ? "hidden" : undefined} {...box}>{children}</Box>
}

const pick = (event: MouseEvent, wants: (handlers: MouseHandlers) => unknown) => {
  let best: { handlers: MouseHandlers; area: number; left: number; top: number } | null = null
  for (const target of targets) {
    const element = target.node.current
    if (!element || !wants(target.handlers.current)) continue
    const { left, top, width, height } = rectangleOf(element)
    if (event.x < left || event.x >= left + width || event.y < top || event.y >= top + height) continue
    const area = width * height
    if (!best || area <= best.area) best = { handlers: target.handlers.current, area, left, top }
  }
  return best ? { handlers: best.handlers, event: { ...event, localX: event.x - best.left, localY: event.y - best.top } as LocalMouseEvent } : null
}

let pressed: { event: MouseEvent; origin: { left: number; top: number }; moved: boolean } | null = null

const click = (event: MouseEvent) => {
  const hit = pick(event, handlers => handlers.onClick || handlers.onDoubleClick)
  if (!hit) return
  if (event.double && hit.handlers.onDoubleClick) return hit.handlers.onDoubleClick(hit.event)
  hit.handlers.onClick?.(hit.event)
}

/**
 * Routes one mouse report to the target under the pointer.
 * @param event the report
 */
export const dispatchMouse = (event: MouseEvent) => {
  if (dragging && pressed) {
    const local = { ...event, localX: event.x - pressed.origin.left, localY: event.y - pressed.origin.top } as LocalMouseEvent
    if (event.kind === "drag") {
      if (event.x !== pressed.event.x || event.y !== pressed.event.y) pressed.moved = true
      dragging(local)
    }
    if (event.kind === "up") {
      dragging(local)
      const wasClick = !pressed.moved
      const down = pressed.event
      dragging = null
      pressed = null
      if (wasClick) click(down)
    }
    return
  }
  if (event.kind.startsWith("wheel")) {
    const hit = pick(event, handlers => handlers.onWheel)
    return hit?.handlers.onWheel?.(event.kind === "wheelUp" || event.kind === "wheelLeft" ? -1 : 1, hit.event)
  }
  if (event.kind !== "down") return
  if (event.button === "right") {
    const hit = pick(event, handlers => handlers.onRightClick)
    return hit?.handlers.onRightClick?.(hit.event)
  }
  if (event.button !== "left") return
  const press = pick(event, handlers => handlers.onPress)
  const follow = press?.handlers.onPress?.(press.event)
  if (press && follow) {
    dragging = follow
    pressed = { event, origin: { left: event.x - press.event.localX, top: event.y - press.event.localY }, moved: false }
    return
  }
  click(event)
}

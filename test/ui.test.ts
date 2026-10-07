/**
 * The first screen, menus, dialogs and the mouse routing under them, drawn by ink. Catches a
 * folder prompt that accepts a path that is not a folder or completes the wrong name, a menu
 * entry or dialog control that a click does not reach, a double, right or wheel click routed to
 * the wrong box, and a drag that never reaches its handler.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Box, Text } from "ink"
import { createElement as h } from "react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { buildDialog } from "@/dialogs"
import type { MouseEvent } from "@/mouse"
import { Clickable, dispatchMouse } from "@/mouse/regions"
import type { Repository } from "@/protocol"
import { DialogBox, openDialogState } from "@/ui/dialog"
import { MenuBox } from "@/ui/menu"
import { FolderPicker } from "@/ui/picker"
import { draw, KEYS, settle } from "./harness"

/** A mouse report at a cell, a left press unless told otherwise. */
const mouseAt = (x: number, y: number, change: Partial<MouseEvent> = {}): MouseEvent => ({ x, y, kind: "down", button: "left", double: false, shift: false, ...change })

const SUMMARY: Repository = {
  path: "/work/app", name: "app", head: { branch: "main", hash: "a1" }, changes: 0, staged: 0, conflicts: 0, operation: null,
  branches: [{ name: "main", hash: "a1", upstream: "origin/main", ahead: 0, behind: 0, gone: false, current: true }],
  remotes: [{ name: "origin", branches: [{ remote: "origin", name: "main", hash: "a1" }] }], tags: [], stashes: [], error: null,
}

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-ui-"))
  for (const name of ["alpha", "alpine", "beta"]) mkdirSync(join(root, name))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("mouse routing", () => {
  it("routes clicks, double clicks, right clicks and the wheel to the smallest box under the pointer", async () => {
    const outer = { onClick: vi.fn(), onWheel: vi.fn() }
    const inner = { onClick: vi.fn(), onDoubleClick: vi.fn(), onRightClick: vi.fn() }
    const screen = draw(h(Clickable, { flexDirection: "column", width: 20, height: 4, ...outer }, h(Text, null, "top"), h(Clickable, { width: 10, height: 1, ...inner }, h(Text, null, "row"))))
    await settle()
    dispatchMouse(mouseAt(3, 1))
    expect(inner.onClick).toHaveBeenCalledWith(expect.objectContaining({ localX: 3, localY: 0 }))
    dispatchMouse(mouseAt(3, 1, { double: true }))
    expect(inner.onDoubleClick).toHaveBeenCalledOnce()
    dispatchMouse(mouseAt(3, 1, { button: "right" }))
    expect(inner.onRightClick).toHaveBeenCalledOnce()
    dispatchMouse(mouseAt(15, 0))
    expect(outer.onClick).toHaveBeenCalledOnce()
    dispatchMouse(mouseAt(3, 1, { kind: "wheelUp", button: "none" }))
    expect(outer.onWheel).toHaveBeenCalledWith(-1, expect.objectContaining({ kind: "wheelUp" }))
    screen.close()
  })

  it("sends every drag move and the release to the press handler, and a still release counts as a click", async () => {
    const moves: string[] = []
    const onClick = vi.fn()
    const screen = draw(h(Clickable, { width: 20, height: 2, onClick, onPress: () => (event: { kind: string; localX: number }) => void moves.push(`${event.kind}:${event.localX}`) }, h(Text, null, "drag me")))
    await settle()
    dispatchMouse(mouseAt(2, 0))
    dispatchMouse(mouseAt(5, 0, { kind: "drag" }))
    dispatchMouse(mouseAt(6, 0, { kind: "up" }))
    expect(moves).toEqual(["drag:5", "up:6"])
    expect(onClick).not.toHaveBeenCalled()
    dispatchMouse(mouseAt(2, 0))
    dispatchMouse(mouseAt(2, 0, { kind: "up" }))
    expect(onClick).toHaveBeenCalledOnce()
    screen.close()
  })
})

describe("folder picker", () => {
  it("completes a folder name with Tab and refuses a path that is not a folder", async () => {
    const onPick = vi.fn()
    const screen = draw(h(FolderPicker, { initial: `${root}/al`, recent: [], onPick, width: 100 }))
    await screen.press(KEYS.tab)
    expect(screen.text()).toContain(`${root}/alp`)
    await screen.press("z", KEYS.enter)
    expect(screen.text()).toContain(`${root}/alpz is not a folder`)
    expect(onPick).not.toHaveBeenCalled()
    await screen.press(KEYS.backspace, "h", "a", KEYS.tab, KEYS.enter)
    expect(screen.text()).not.toContain("is not a folder")
    expect(onPick).toHaveBeenCalledWith(join(root, "alpha"))
    screen.close()
  })

  it("picks a recent folder with the arrows and opens it with Enter", async () => {
    const onPick = vi.fn()
    const screen = draw(h(FolderPicker, { initial: root, recent: [join(root, "beta"), root], onPick, width: 100 }))
    await settle()
    expect(screen.text()).toContain("Recent")
    await screen.press(KEYS.down, KEYS.enter)
    expect(onPick).toHaveBeenCalledWith(join(root, "beta"))
    screen.close()
  })
})

describe("menu", () => {
  it("draws every entry and reports the one clicked, and a click outside closes it", async () => {
    const onChoose = vi.fn()
    const onClose = vi.fn()
    const screen = draw(h(Box, { width: 60, height: 12 }, h(MenuBox, { state: { title: "main", items: [{ label: "Checkout", run: vi.fn() }, { label: "Merge into current", run: vi.fn() }], cursor: 0 }, width: 60, height: 12, onChoose, onClose })))
    await settle()
    const lines = screen.text().split("\n")
    expect(screen.text()).toContain("Merge into current")
    const row = lines.findIndex(line => line.includes("Merge into current"))
    dispatchMouse(mouseAt(lines[row].indexOf("Merge"), row))
    expect(onChoose).toHaveBeenCalledWith(1)
    dispatchMouse(mouseAt(1, 11))
    expect(onClose).toHaveBeenCalledOnce()
    screen.close()
  })
})

describe("dialog box", () => {
  it("draws the dialog's fields and buttons, and a click on a control activates it", async () => {
    const onActivate = vi.fn()
    const onSubmit = vi.fn()
    const state = openDialogState(SUMMARY.path, buildDialog("fetch", SUMMARY, {}), {})
    const screen = draw(h(Box, { width: 90, height: 24 }, h(DialogBox, { state, width: 90, height: 24, onActivate, onCancel: vi.fn(), onSubmit, onWheel: vi.fn() })))
    await settle()
    const text = screen.text()
    expect(text).toContain(state.spec.title)
    const lines = text.split("\n")
    const prune = lines.findIndex(line => /prune/i.test(line))
    expect(prune).toBeGreaterThan(-1)
    dispatchMouse(mouseAt(lines[prune].search(/prune/i), prune))
    expect(onActivate).toHaveBeenCalled()
    screen.close()
  })
})

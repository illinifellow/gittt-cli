/**
 * Action dialogs in the terminal, drawn from the dialog specs: a framed box with labelled fields, checkboxes, radio groups,
 * selects, checklists and Cancel / OK. Keys: ↑ ↓ Tab move, Space toggles,
 * ← → change a choice, typing edits text, Enter submits, Esc cancels.
 */
import { Box, Text, type Key } from "ink"
import type { ReactNode } from "react"
import { initialValues, type DialogSpec, type DialogTarget, type DialogValues, type Field } from "@/dialogs"
import { Clickable } from "@/mouse/regions"
import { fit } from "./text"
import { useTheme } from "./theme"
import { CHECKBOX_WIDTH, CheckBox } from "./checkbox"

/** A focusable stop inside a dialog. */
type Stop =
  | { kind: "field"; field: number }
  | { kind: "selectAll"; field: number }
  | { kind: "item"; field: number; item: number }
  | { kind: "cancel" }
  | { kind: "submit" }

/** An open dialog. */
export interface DialogState {
  path: string
  spec: DialogSpec
  target: DialogTarget
  values: DialogValues
  focus: number
  error: string | null
}

const stopsOf = (spec: DialogSpec): Stop[] => [
  ...spec.fields.flatMap((field, index): Stop[] => {
    if (field.type === "info" || field.type === "warning") return []
    if (field.type === "checklist") return [{ kind: "selectAll", field: index }, ...field.items.map((_, item) => ({ kind: "item" as const, field: index, item }))]
    return [{ kind: "field", field: index }]
  }),
  { kind: "cancel" },
  { kind: "submit" },
]

/**
 * @param path repository the dialog acts on
 * @param spec dialog to open
 * @param target what it was opened on
 * @returns a dialog with initial values and focus on the first field
 */
export const openDialogState = (path: string, spec: DialogSpec, target: DialogTarget): DialogState => ({ path, spec, target, values: initialValues(spec), focus: 0, error: null })

const cycle = (choices: { value: string }[], value: string, step: number) => {
  const index = choices.findIndex(choice => choice.value === value)
  return choices[(index + step + choices.length) % choices.length]?.value ?? value
}

/**
 * Applies one key press.
 * @param state the open dialog
 * @param input typed text
 * @param key special keys
 * @returns the next state, or what to do: submit with values, or cancel
 */
export const dialogKey = (state: DialogState, input: string, key: Key): DialogState | { action: "submit" } | { action: "cancel" } => {
  const stops = stopsOf(state.spec)
  const stop = stops[state.focus]
  const field: Field | undefined = stop.kind === "cancel" || stop.kind === "submit" ? undefined : state.spec.fields[stop.field]
  const set = (key: string, value: DialogValues[string]) => ({ ...state, values: { ...state.values, [key]: value }, error: null })
  if (key.escape) return { action: "cancel" }
  if (key.return) return stop.kind === "cancel" ? { action: "cancel" } : { action: "submit" }
  if (key.downArrow || (key.tab && !key.shift)) return { ...state, focus: (state.focus + 1) % stops.length }
  if (key.upArrow || (key.tab && key.shift)) return { ...state, focus: (state.focus - 1 + stops.length) % stops.length }
  if (!field) {
    if (key.leftArrow || key.rightArrow) return { ...state, focus: stop.kind === "cancel" ? stops.length - 1 : stops.length - 2 }
    return state
  }
  if (field.type === "text") {
    const current = String(state.values[field.key] ?? "")
    if (key.backspace || key.delete) return set(field.key, current.slice(0, -1))
    if (input && !key.ctrl && !key.meta) return set(field.key, current + input)
    return state
  }
  if (field.type === "checkbox" && (input === " " || key.leftArrow || key.rightArrow)) return set(field.key, !state.values[field.key])
  if ((field.type === "select" || field.type === "radio") && (key.leftArrow || key.rightArrow || input === " "))
    return set(field.key, cycle(field.choices, String(state.values[field.key]), key.leftArrow ? -1 : 1))
  if (field.type === "checklist" && input === " ") {
    const chosen = new Set(state.values[field.key] as string[])
    if (stop.kind === "selectAll") return set(field.key, chosen.size === field.items.length ? [] : field.items.map(item => item.value))
    if (stop.kind === "item") {
      const value = field.items[stop.item].value
      if (chosen.has(value)) chosen.delete(value)
      else chosen.add(value)
      return set(field.key, field.items.filter(item => chosen.has(item.value)).map(item => item.value))
    }
  }
  return state
}

/**
 * Applies a click on a dialog row: focuses its control and toggles or chooses as Space would.
 * @param state the open dialog
 * @param stop index of the clicked control
 * @param choice the radio choice on the clicked row, if any
 * @returns the next state
 */
export const dialogActivate = (state: DialogState, stop: number, choice?: string): DialogState => {
  const focused = { ...state, focus: stop }
  const target = stopsOf(state.spec)[stop]
  if (target.kind === "cancel" || target.kind === "submit") return focused
  const field = state.spec.fields[target.field]
  if (field.type === "radio" && choice !== undefined) return { ...focused, values: { ...state.values, [field.key]: choice }, error: null }
  if (field.type === "text") return focused
  const next = dialogKey(focused, " ", {} as Key)
  return "action" in next ? focused : next
}

/**
 * Draws the dialog centred in the given area; every control and button answers the mouse.
 * @param props.state the open dialog
 * @param props.width area width in cells
 * @param props.height area height in rows
 * @param props.onActivate a control was clicked: its stop index and, for radio rows, the choice
 * @param props.onCancel Cancel was clicked
 * @param props.onSubmit the submit button was clicked
 */
export const DialogBox = ({ state, width, height, onActivate, onCancel, onSubmit }: {
  state: DialogState
  width: number
  height: number
  onActivate: (stop: number, choice?: string) => void
  onCancel: () => void
  onSubmit: () => void
}) => {
  const { colors: palette, glyphs, spacing } = useTheme()
  const boxWidth = Math.min(spacing.dialogWidth, width - 4)
  const labelWidth = spacing.dialogLabel
  const valueWidth = boxWidth - labelWidth - 5
  const stops = stopsOf(state.spec)
  const focused = stops[state.focus]
  const indexOf = (stop: Stop) => stops.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(stop))
  const rows: { stop: number | null; choice?: string; node: ReactNode }[] = []
  state.spec.fields.forEach((field, index) => {
    const stop = indexOf({ kind: "field", field: index })
    const focus = stop === state.focus
    const marker = <Text color={palette.accent}>{focus ? glyphs.pointer : " "}</Text>
    const label = (text: string) => <Text color={palette.textMuted}>{fit(`${text}:`, labelWidth)}</Text>
    switch (field.type) {
      case "info":
        rows.push({ stop: null, node: <Text> {label(field.label)}<Text bold color={palette.text}>{fit(field.text, valueWidth)}</Text></Text> })
        break
      case "warning":
        rows.push({ stop: null, node: <Text color={palette.stash}>{fit(` ${glyphs.alert} ${field.text}`, boxWidth - 4)}</Text> })
        break
      case "text": {
        const value = String(state.values[field.key] ?? "")
        rows.push({ stop, node: <Text>{marker}{label(field.label)}<Text backgroundColor={palette.field} color={value ? palette.text : palette.textMuted}>{fit(value ? `${value}${focus ? glyphs.cursor : ""}` : `${field.placeholder ?? ""}${focus ? glyphs.cursor : ""}`, valueWidth)}</Text></Text> })
        break
      }
      case "select": {
        const choice = field.choices.find(candidate => candidate.value === state.values[field.key])
        rows.push({ stop, node: <Text>{marker}{label(field.label)}<Text backgroundColor={palette.field} color={palette.text}>{fit(` ${choice?.label ?? String(state.values[field.key] ?? "")}`, valueWidth - 2)}</Text><Text backgroundColor={palette.field} color={palette.accent}>{glyphs.dropdown} </Text></Text> })
        break
      }
      case "radio":
        field.choices.forEach((choice, choiceIndex) => rows.push({ stop, choice: choice.value, node: (
          <Text>{choiceIndex ? " " : marker}{choiceIndex ? " ".repeat(labelWidth) : label(field.label)}<Text color={state.values[field.key] === choice.value ? palette.accent : palette.text}>{state.values[field.key] === choice.value ? glyphs.radioOn : glyphs.radioOff} {fit(choice.label, valueWidth - 2)}</Text></Text>
        ) }))
        break
      case "checkbox": {
        const checked = state.values[field.key] === true
        rows.push({ stop, node: <Text>{marker}{" ".repeat(labelWidth)}<CheckBox state={checked ? "on" : "off"} /><Text color={checked ? palette.accent : palette.text}> {fit(field.label, valueWidth - CHECKBOX_WIDTH - 1)}</Text></Text> })
        if (checked && field.warning) rows.push({ stop: null, node: <Text color={palette.stash}>{" ".repeat(labelWidth + CHECKBOX_WIDTH + 2)}{fit(field.warning, valueWidth - CHECKBOX_WIDTH - 1)}</Text> })
        break
      }
      case "checklist": {
        const chosen = new Set(state.values[field.key] as string[])
        const all = chosen.size === field.items.length && field.items.length > 0
        const selectAll = indexOf({ kind: "selectAll", field: index })
        rows.push({ stop: selectAll, node: <Text>{selectAll === state.focus ? <Text color={palette.accent}>{glyphs.pointer}</Text> : " "}<Text color={palette.textMuted}>{fit(field.label, labelWidth)}</Text><CheckBox state={all ? "on" : chosen.size ? "mixed" : "off"} /><Text color={all ? palette.accent : palette.text}> Select All</Text></Text> })
        const focusItem = focused.kind === "item" && focused.field === index ? focused.item : 0
        const windowSize = spacing.checklistRows
        const first = Math.max(0, Math.min(focusItem - 3, field.items.length - windowSize))
        field.items.slice(first, first + windowSize).forEach((item, offset) => {
          const itemStop = indexOf({ kind: "item", field: index, item: first + offset })
          rows.push({ stop: itemStop, node: <Text>{itemStop === state.focus ? <Text color={palette.accent}>{glyphs.pointer}</Text> : " "}  <CheckBox state={chosen.has(item.value) ? "on" : "off"} /><Text color={chosen.has(item.value) ? palette.accent : palette.text}> {fit(item.label, 32)}</Text><Text color={palette.textMuted}> {fit(item.detail ?? "", boxWidth - 44)}</Text></Text> })
        })
        if (field.items.length > windowSize) rows.push({ stop: null, node: <Text color={palette.textMuted}>{`    ${field.items.length} items, wheel or ↑ ↓ to scroll`}</Text> })
        break
      }
    }
  })
  const cancelFocused = focused.kind === "cancel"
  const submitFocused = focused.kind === "submit"
  return (
    <Box width={width} height={height} justifyContent="center" alignItems="flex-start" paddingTop={1}>
      <Box flexDirection="column" width={boxWidth} borderStyle="round" borderColor={palette.accent} borderBackgroundColor={palette.background} backgroundColor={palette.background} paddingX={1}>
        <Text bold color={palette.text}>{state.spec.title}</Text>
        <Text color={palette.border}>{glyphs.rule.repeat(boxWidth - 4)}</Text>
        {rows.map((row, rowIndex) => row.stop === null || row.stop < 0
          ? <Box key={rowIndex} height={1}>{row.node}</Box>
          : <Clickable key={rowIndex} height={1} onClick={() => onActivate(row.stop as number, row.choice)}>{row.node}</Clickable>)}
        {state.error ? <Text color={palette.stash}>{fit(` ${glyphs.error} ${state.error}`, boxWidth - 4)}</Text> : null}
        <Text color={palette.border}>{glyphs.rule.repeat(boxWidth - 4)}</Text>
        <Box justifyContent="flex-end" gap={2}>
          <Clickable onClick={onCancel}><Text inverse={cancelFocused} color={palette.text}> Cancel </Text></Clickable>
          <Clickable onClick={onSubmit}><Text inverse={submitFocused} bold backgroundColor={submitFocused ? undefined : palette.field} color={state.spec.danger ? palette.stash : palette.accent}> {state.spec.submit} </Text></Clickable>
        </Box>
        <Text color={palette.textMuted}>{fit("click or ↑↓ · space toggle · ←→ choose · enter OK · esc cancel", boxWidth - 4)}</Text>
      </Box>
    </Box>
  )
}

/**
 * A checkbox drawn as a bracketed three-cell box, so every row's box stands on
 * its own: `[✓]` in the accent when on, `[−]` in the accent when partly on, an
 * empty `[ ]` in the muted colour when off. Used by the pending file list and every dialog.
 */
import { Text } from "ink"
import { useTheme } from "./theme"

/** The three states a box can show. */
export type CheckState = "on" | "off" | "mixed"

/** The number of terminal cells a checkbox takes, without the space after it. */
export const CHECKBOX_WIDTH = 3

/**
 * One checkbox.
 * @param props.state on, off or mixed (some changes of a file staged, some not)
 * @returns a three-cell bracketed box in the accent or muted colour
 */
export const CheckBox = ({ state }: { state: CheckState }) => {
  const { colors: palette, glyphs } = useTheme()
  const mark = state === "on" ? glyphs.checked : state === "mixed" ? glyphs.mixed : glyphs.unchecked
  const color = state === "off" ? palette.textMuted : palette.accent
  return <Text color={color} bold={state !== "off"}>[{mark}]</Text>
}

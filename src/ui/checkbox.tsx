/**
 * A checkbox drawn as a filled three-cell box, so its state reads at a glance:
 * on and partly-on boxes are filled with the accent and carry a mark, an off box
 * is an empty box a step lighter than the field. Used by the pending file list and every dialog.
 */
import { Text } from "ink"
import { mix } from "./text"
import { useTheme } from "./theme"

/** The three states a box can show. */
export type CheckState = "on" | "off" | "mixed"

/** The number of terminal cells a checkbox takes, without the space after it. */
export const CHECKBOX_WIDTH = 3

/**
 * One checkbox.
 * @param props.state on, off or mixed (some changes of a file staged, some not)
 * @returns a three-cell box in the theme's accent or field colour
 */
export const CheckBox = ({ state }: { state: CheckState }) => {
  const { colors: palette, glyphs } = useTheme()
  const mark = state === "on" ? glyphs.checked : state === "mixed" ? glyphs.mixed : glyphs.unchecked
  return <Text backgroundColor={state === "off" ? mix(palette.textMuted, palette.field, 0.35) : palette.accent} color={palette.accentText} bold>{` ${mark} `}</Text>
}

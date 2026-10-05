/**
 * The context menu: the actions for the row under the
 * cursor; ↑ ↓ choose, Enter runs, Esc closes.
 */
import { Box, Text } from "ink"
import { Clickable } from "@/mouse/regions"
import { fit, type Palette } from "./text"

/** One menu entry; `separator` draws a rule above it. */
export interface MenuItem {
  label: string
  run: () => void
  separator?: boolean
}

/** An open menu. */
export interface MenuState {
  title: string
  items: MenuItem[]
  cursor: number
}

/**
 * Draws the menu near the top of the given area.
 * @param props.state the open menu
 * @param props.width area width in cells
 * @param props.height area height in rows
 * @param props.palette colours
 * @param props.onChoose an entry was clicked, by index
 * @param props.onClose a click landed outside the entries
 */
export const MenuBox = ({ state, width, height, palette, onChoose, onClose }: { state: MenuState; width: number; height: number; palette: Palette; onChoose: (index: number) => void; onClose: () => void }) => {
  const boxWidth = Math.min(48, width - 4)
  return (
    <Clickable width={width} height={height} justifyContent="center" alignItems="flex-start" paddingTop={2} onClick={onClose} onRightClick={onClose}>
      <Box flexDirection="column" width={boxWidth} borderStyle="round" borderColor={palette.accent}>
        <Text bold color={palette.textMuted}>{fit(` ${state.title}`, boxWidth - 2)}</Text>
        {state.items.map((item, index) => (
          <Box key={item.label} flexDirection="column">
            {item.separator ? <Text color={palette.border}>{"─".repeat(boxWidth - 2)}</Text> : null}
            <Clickable height={1} onClick={() => onChoose(index)}>
              <Text backgroundColor={index === state.cursor ? palette.selection : undefined} color={palette.text}>{fit(` ${item.label}`, boxWidth - 2)}</Text>
            </Clickable>
          </Box>
        ))}
      </Box>
    </Clickable>
  )
}

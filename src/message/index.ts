/**
 * Splits commit messages into highlight parts: gitmoji shortcodes (with their
 * emoji), inline code, URLs, conventional-commit prefixes, quoted names, issue
 * keys and commit hashes, each drawn in its own colour.
 */

/** A piece of a message and what it is. */
export interface MessagePart {
  kind: "text" | "code" | "emoji" | "shortcode" | "url" | "prefix" | "quoted" | "issue" | "hash"
  text: string
  /** The shortcode an emoji part came from. */
  source?: string
}

const GITMOJI: Record<string, string> = {
  adhesive_bandage: "🩹", airplane: "✈️", alembic: "⚗️", alien: "👽", ambulance: "🚑", apple: "🍎", arrow_down: "⬇️", arrow_up: "⬆️",
  art: "🎨", beers: "🍻", bento: "🍱", bookmark: "🔖", boom: "💥", bricks: "🧱", bug: "🐛", building_construction: "🏗️", bulb: "💡",
  camera_flash: "📸", card_file_box: "🗃️", chart_with_upwards_trend: "📈", checkered_flag: "🏁", children_crossing: "🚸", clown_face: "🤡",
  coffin: "⚰️", construction: "🚧", construction_worker: "👷", dizzy: "💫", egg: "🥚", fire: "🔥", globe_with_meridians: "🌐", goal_net: "🥅",
  green_apple: "🍏", green_heart: "💚", hammer: "🔨", heavy_check_mark: "✔️", heavy_minus_sign: "➖", heavy_plus_sign: "➕", iphone: "📱",
  label: "🏷️", lipstick: "💄", lock: "🔒", loud_sound: "🔊", mag: "🔍", memo: "📝", money_with_wings: "💸", monocle_face: "🧐", mute: "🔇",
  necktie: "👔", package: "📦", page_facing_up: "📄", passport_control: "🛂", pencil2: "✏️", penguin: "🐧", pill: "💊", poop: "💩",
  pushpin: "📌", recycle: "♻️", rewind: "⏪", robot: "🤖", rocket: "🚀", rotating_light: "🚨", safety_vest: "🦺", see_no_evil: "🙈",
  seedling: "🌱", sparkles: "✨", speech_balloon: "💬", stethoscope: "🩺", tada: "🎉", technologist: "🧑‍💻", test_tube: "🧪", thread: "🧵",
  triangular_flag_on_post: "🚩", truck: "🚚", twisted_rightwards_arrows: "🔀", wastebasket: "🗑️", wheelchair: "♿", whale: "🐳",
  white_check_mark: "✅", wrench: "🔧", x: "❌", zap: "⚡",
}

const PATTERN = /(`[^`]+`)|(:[a-z0-9_+-]+:)|(\bhttps?:\/\/[^\s<]+)|(^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:)|('[^'\s][^']*')|(\b[A-Z][A-Z0-9]+-\d+\b)|(\b[0-9a-f]{7,40}\b)/g

/**
 * @param text a commit subject or message
 * @param gitmoji whether known `:shortcode:` parts become emoji
 * @returns the parts in order; joined, their source text is the input
 */
export const splitMessage = (text: string, gitmoji: boolean): MessagePart[] => {
  const parts: MessagePart[] = []
  let position = 0
  for (const match of text.matchAll(PATTERN)) {
    const [whole, code, shortcode, url, prefix, quoted, issue, hash] = match
    const index = match.index ?? 0
    if (index > position) parts.push({ kind: "text", text: text.slice(position, index) })
    position = index + whole.length
    if (code) parts.push({ kind: "code", text: code.slice(1, -1) })
    else if (shortcode) {
      const emoji = GITMOJI[shortcode.slice(1, -1)]
      parts.push(emoji && gitmoji ? { kind: "emoji", text: emoji, source: shortcode } : { kind: "shortcode", text: shortcode })
    } else if (url) parts.push({ kind: "url", text: url })
    else if (prefix) parts.push({ kind: "prefix", text: prefix })
    else if (quoted) parts.push({ kind: "quoted", text: quoted })
    else if (issue) parts.push({ kind: "issue", text: issue })
    else if (hash) parts.push({ kind: "hash", text: hash })
  }
  if (position < text.length) parts.push({ kind: "text", text: text.slice(position) })
  return parts
}

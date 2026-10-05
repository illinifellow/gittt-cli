/**
 * Dates as the log writes them: "2 Oct 2026 at 14:05", or relative ("3 hr. ago").
 */

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]

/**
 * @param seconds unix time
 * @param format `relative` ("3 hr. ago") or `absolute` ("2 Oct 2026 at 14:05")
 * @returns the date as text
 */
export const formatDate = (seconds: number, format: "relative" | "absolute") => {
  if (format === "absolute") return `${DAY.format(seconds * 1000)} at ${TIME.format(seconds * 1000)}`
  const delta = seconds - Date.now() / 1000
  const unit = UNITS.find(([, size]) => Math.abs(delta) >= size)
  return unit ? RELATIVE.format(Math.round(delta / unit[1]), unit[0]) : "now"
}

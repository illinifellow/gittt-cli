/**
 * Dates in the log. Catches a relative date that picks the wrong unit or direction, and an
 * absolute date that loses its time.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatDate } from "@/dates"

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)

afterEach(() => vi.useRealTimers())

describe("formatDate", () => {
  it("writes the day and the time for absolute dates", () => {
    expect(formatDate(NOW / 1000, "absolute")).toMatch(/^7 Oct 2026 at \d{2}:\d{2}$/)
  })

  it("picks the largest unit that fits and says now under a minute", () => {
    vi.useFakeTimers({ now: NOW })
    const ago = (seconds: number) => formatDate(NOW / 1000 - seconds, "relative")
    expect(ago(30)).toBe("now")
    expect(ago(3 * 3600)).toMatch(/3 hr\. ago/)
    expect(ago(2 * 86400)).toMatch(/2 days ago/)
    expect(ago(400 * 86400)).toMatch(/last yr\.|1 yr\. ago/)
  })
})

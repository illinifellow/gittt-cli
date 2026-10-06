/**
 * The settings dialog: what Save writes and what it refuses.
 * Catches a field that Save silently drops, folders split wrongly, or a zero or text slipping into a number.
 */
import { describe, expect, it } from "vitest"
import { loadDefaults } from "@/config"
import { initialValues } from "@/dialogs"
import { applySettings, COFFEE_URL, settingsDialog, validateSettings } from "@/settings"

describe("settings dialog", () => {
  /** Opening and saving without changes gives back the same configuration. */
  it("round-trips the defaults unchanged", () => {
    const config = loadDefaults()
    expect(applySettings(config, initialValues(settingsDialog(config)))).toEqual(config)
  })
  /** Edited values land in their places; the folder list splits on commas and drops blanks. */
  it("writes edited values", () => {
    const config = loadDefaults()
    const values = { ...initialValues(settingsDialog(config)), compact: true, maxCommits: "500", scanExclude: "a, b,, c" }
    const next = applySettings(config, values)
    expect(next.settings.compact).toBe(true)
    expect(next.settings.maxCommits).toBe(500)
    expect(next.settings.scanExclude).toEqual(["a", "b", "c"])
  })
  /** Numbers must be whole and at least 1. */
  it("refuses a zero or a word in a number", () => {
    const values = initialValues(settingsDialog(loadDefaults()))
    expect(validateSettings(loadDefaults(), { ...values, scanDepth: "0" })).toMatch(/scanDepth/)
    expect(validateSettings(loadDefaults(), { ...values, maxCommits: "many" })).toMatch(/maxCommits/)
    expect(validateSettings(loadDefaults(), values)).toBeNull()
  })
  /** The coffee button leads where illinifellow.com does. */
  it("links Buy Me a Coffee", () => {
    const link = settingsDialog(loadDefaults()).fields.find(field => field.type === "link")
    expect(link && "url" in link && link.url).toBe(COFFEE_URL)
  })
})

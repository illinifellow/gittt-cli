/**
 * Hands the resolved theme to every component through React context, so no
 * component imports a colour, glyph or size of its own.
 */
import { createContext, useContext } from "react"
import { loadDefaults } from "@/config"
import { resolveTheme, type Theme } from "@/theme"

const ThemeContext = createContext<Theme>(resolveTheme(loadDefaults(), undefined))

/** Provides the active theme to everything below it. */
export const ThemeProvider = ThemeContext.Provider

/** @returns the active theme: colours, glyphs and spacing */
export const useTheme = () => useContext(ThemeContext)

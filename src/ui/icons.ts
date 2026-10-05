/**
 * Icon sets. `unicode` draws with symbols every monospace font or its system
 * fallback carries; `nerd` uses Nerd Font octicons for terminals whose font has
 * them. The config's `settings.icons` picks one.
 */
import { loadConfig } from "@/config"

const NERD = {
  repository: "\uf401", branch: "\uf418", remote: "\uf0c2", tag: "\uf412", commit: "\uf417", sync: "\uf46a", alert: "\uf421",
  stash: "\uf411", workspace: "\uf4a9", status: "\uf4d2", history: "\uf464", search: "\uf422",
}

const UNICODE: typeof NERD = {
  repository: "▣", branch: "⎇", remote: "☁", tag: "⌗", commit: "◉", sync: "⟳", alert: "⚠",
  stash: "≣", workspace: "◫", status: "✎", history: "◷", search: "⌕",
}

/** The icons in use, chosen once at start. */
export const ICONS: typeof NERD = loadConfig().settings.icons === "nerd" ? NERD : UNICODE

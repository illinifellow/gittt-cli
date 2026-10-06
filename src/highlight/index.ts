/**
 * Syntax highlighting of diff hunks for the terminal: shiki tokens in the
 * editor's theme, the old and new sides highlighted as separate blocks so each
 * keeps a correct grammar state, mapped back onto the hunk's lines. Large diffs
 * are highlighted in pieces that yield to input, and results are cached.
 */
import { createHash } from "node:crypto"
import { createHighlighterCore, type GrammarState, type ThemeRegistrationAny } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs"
import type { Limits } from "@/config"
import { prefixWidth, type ParsedDiff } from "@/diff"

/** A coloured piece of a line. */
export interface Segment {
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
  background?: string
}

const THEME_NAME = "gittt-editor"
const FILE_NAMES: Record<string, string> = { dockerfile: "docker", makefile: "make", gemfile: "ruby", rakefile: "ruby", ".gitignore": "ini", ".npmrc": "ini", ".bashrc": "shellscript", ".zshrc": "shellscript" }
const EXTENSIONS: Record<string, string> = { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", yml: "yaml", h: "c", hpp: "cpp", cc: "cpp", plist: "xml", svg: "xml", txt: "" }

const aliases = new Map<string, string>()
for (const language of bundledLanguagesInfo) {
  aliases.set(language.id, language.id)
  for (const alias of language.aliases ?? []) aliases.set(alias, language.id)
}

/**
 * @param path file path inside the repository
 * @returns the shiki language for it, or `null`
 */
const languageOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (name in FILE_NAMES) return FILE_NAMES[name]
  if (name.startsWith(".env")) return "dotenv"
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : ""
  const mapped = extension in EXTENSIONS ? EXTENSIONS[extension] : extension
  return mapped ? aliases.get(mapped) ?? null : null
}

/** How often a highlighting in progress reports what it has so far; each report redraws the whole diff. */
const PROGRESS_INTERVAL_MS = 120

/** Highlights hunks with one theme. */
export class DiffHighlighter {
  private highlighter: ReturnType<typeof createHighlighterCore> | null = null

  /**
   * @param theme a VS Code theme JSON
   * @param limits `highlightMaxLines` (longer diffs stay plain), `highlightChunkLines` (lines per piece), `highlightCacheSize` (diffs remembered, also at most `highlightMaxLines` lines in all)
   */
  constructor(private readonly theme: Promise<ThemeRegistrationAny>, private readonly limits: Pick<Limits, "highlightMaxLines" | "highlightChunkLines" | "highlightCacheSize">) {}

  private async core() {
    this.highlighter ??= this.theme.then(theme => createHighlighterCore({ themes: [{ ...theme, name: THEME_NAME }], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }))
    return this.highlighter
  }

  /** Highlighted diffs by path and text digest, with their line counts; bounded by entries and by `highlightMaxLines` lines in all. */
  private cache = new Map<string, { result: Segment[][][]; lines: number }>()
  private cachedLines = 0

  private toSegments(tokens: { content: string; color?: string; fontStyle?: number }[][]): Segment[][] {
    return tokens.map(line => line.map(token => {
      const segment: Segment = { text: token.content, color: token.color }
      if (token.fontStyle && token.fontStyle & 1) segment.italic = true
      if (token.fontStyle && token.fontStyle & 2) segment.bold = true
      return segment
    }))
  }

  private remember(key: string, result: Segment[][][], lines: number) {
    this.cache.set(key, { result, lines })
    this.cachedLines += lines
    for (const [oldest, entry] of this.cache) {
      if (this.cache.size <= 1 || (this.cache.size <= this.limits.highlightCacheSize && this.cachedLines <= this.limits.highlightMaxLines)) break
      this.cache.delete(oldest)
      this.cachedLines -= entry.lines
    }
  }

  /**
   * Highlights the code of every hunk, a few hundred lines at a time, yielding to keyboard and mouse input between pieces.
   * Results are cached per file and diff text, so an unchanged diff is never highlighted twice; progress is reported
   * after the first piece and then at most every 120 ms.
   * @param path file path, for the language
   * @param text the diff text, part of the cache key
   * @param diff parsed diff of that file
   * @param onProgress receives the highlighting so far after every piece (lines not reached yet are plain)
   * @returns per hunk, per line, the coloured code without its prefix; `null` for unknown languages and very long diffs
   */
  async highlight(path: string, text: string, diff: ParsedDiff, onProgress?: (partial: Segment[][][]) => void): Promise<Segment[][][] | null> {
    const key = `${path}\0${createHash("sha1").update(text).digest("base64")}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.result
    }
    const language = languageOf(path)
    if (!language || !(language in bundledLanguages)) return null
    const lineCount = diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    if (!lineCount || lineCount > this.limits.highlightMaxLines) return null
    const highlighter = await this.core()
    if (!highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage(bundledLanguages[language as keyof typeof bundledLanguages])
    const width = prefixWidth(diff)
    const hunks = diff.hunks.map(hunk => {
      const sides = { old: [] as string[], new: [] as string[] }
      const places = hunk.lines.map(line => {
        const marks = line.slice(0, width)
        const code = line.slice(width)
        if (line.startsWith("\\")) return null
        if (marks.includes("-")) return { side: "old" as const, index: sides.old.push(code) - 1 }
        if (marks.includes("+")) return { side: "new" as const, index: sides.new.push(code) - 1 }
        sides.old.push(code)
        return { side: "new" as const, index: sides.new.push(code) - 1 }
      })
      return { hunk, places, sides, tokens: { old: [] as Segment[][], new: [] as Segment[][] } }
    })
    let reportedAt = 0
    const assemble = () => hunks.map(({ hunk, places, tokens }) => places.map((place, index) => place ? tokens[place.side][place.index] ?? [{ text: hunk.lines[index].slice(width) }] : [{ text: hunk.lines[index] }]))
    for (const entry of hunks)
      for (const side of ["new", "old"] as const) {
        let state: GrammarState | undefined
        for (let start = 0; start < entry.sides[side].length; start += this.limits.highlightChunkLines) {
          const tokens = highlighter.codeToTokensBase(entry.sides[side].slice(start, start + this.limits.highlightChunkLines).join("\n"), { lang: language, theme: THEME_NAME, grammarState: state })
          state = highlighter.getLastGrammarState(tokens)
          entry.tokens[side].push(...this.toSegments(tokens))
          if (onProgress && Date.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
            onProgress(assemble())
            reportedAt = Date.now()
          }
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    const result = assemble()
    this.remember(key, result, lineCount)
    return result
  }
}

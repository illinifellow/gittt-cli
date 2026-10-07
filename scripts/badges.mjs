/**
 * Writes the shields.io endpoint files for the README's tests and coverage badges from a
 * coverage run (`npm run coverage`): `badges/tests.json` with the passing test count and
 * `badges/coverage.json` with the line coverage. CI publishes the folder to the `badges` branch.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const tests = JSON.parse(readFileSync("coverage/tests.json", "utf8"))
const lines = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")).total.lines.pct

/** Coverage colours by the usual thresholds. */
const coverageColor = lines >= 90 ? "88bd66" : lines >= 75 ? "ffdd04" : "ff6b81"

mkdirSync("badges", { recursive: true })
writeFileSync("badges/tests.json", JSON.stringify({ schemaVersion: 1, label: "tests", message: `${tests.numPassedTests} passed`, color: tests.numFailedTests ? "ff6b81" : "88bd66" }))
writeFileSync("badges/coverage.json", JSON.stringify({ schemaVersion: 1, label: "coverage", message: `${Math.floor(lines)}%`, color: coverageColor }))

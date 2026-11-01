// OpenCode custom tool: NVIDIA vision QC of a render contact sheet.
// Thin shell over media/qc-vision.mjs. Advisory only — report its verdict in
// review.md; never let it silently pass a broken render.
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

const run = promisify(execFile)

export default tool({
  description:
    "Run vision QC on a contact sheet / strip image using the NVIDIA vision model. Returns JSON {pass, issues[]}. Use after every animatic or final render, and record the verdict in review.md.",
  args: {
    image: tool.schema.string().describe("Path to the contact sheet jpg/png"),
  },
  async execute(args) {
    const root = resolve(process.cwd(), "..")
    const script = resolve(root, "media/qc-vision.mjs")
    const { stdout } = await run("node", [script, args.image], { maxBuffer: 1024 * 1024 })
    return stdout.trim()
  },
})

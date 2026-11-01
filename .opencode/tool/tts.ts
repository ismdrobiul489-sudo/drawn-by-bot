// OpenCode custom tool: Edge TTS. Thin shell over media/tts.mjs.
// Format: OpenCode v1 custom tool (default export from @opencode-ai/plugin).
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

const run = promisify(execFile)

export default tool({
  description:
    "Synthesize narration with Edge TTS: writes voice.mp3 + timing.json into the job directory. The text is prepped automatically (formatting stripped, numbers written as spoken words). Preferred usage: write voice-plan.json first (sections named hook/body/outro with text, tone, emphasis) and pass it as planFile — sections are then synthesized one by one in order, and with TTS_TAKES=2 each section gets a second take for the listener QC to choose from. Without planFile, scriptFile is synthesized as a single flow. Use for topic/script modes, never for voice mode.",
  args: {
    scriptFile: tool.schema.string().describe("Path to the script text file (may be '-' when planFile is given)"),
    voice: tool.schema.string().describe("Edge TTS voice short name, e.g. en-US-AriaNeural"),
    jobDir: tool.schema.string().describe("Job directory (core/sandbox/<job>)"),
    planFile: tool.schema.string().optional().describe("Optional path to voice-plan.json in the job directory"),
  },
  async execute(args) {
    const root = resolve(process.cwd(), "..")
    const script = resolve(root, "media/tts.mjs")
    const cli = [script, args.scriptFile, args.voice, args.jobDir]
    if (args.planFile) cli.push("--plan", args.planFile)
    const { stdout } = await run("node", cli, { maxBuffer: 1024 * 1024 })
    return stdout.trim()
  },
})

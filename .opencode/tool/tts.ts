// OpenCode custom tool: Edge TTS. Thin shell over media/tts.mjs.
// Format: OpenCode v1 custom tool (default export from @opencode-ai/plugin).
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

const run = promisify(execFile)

export default tool({
  description:
    "Synthesize narration with Edge TTS. Takes a script text file and an Edge voice name (e.g. en-US-AriaNeural), writes voice.mp3 + timing.json into the job directory. Use for topic/script modes, never for voice mode.",
  args: {
    scriptFile: tool.schema.string().describe("Path to the script text file"),
    voice: tool.schema.string().describe("Edge TTS voice short name, e.g. en-US-AriaNeural"),
    jobDir: tool.schema.string().describe("Job directory (core/sandbox/<job>)"),
  },
  async execute(args) {
    const root = resolve(process.cwd(), "..")
    const script = resolve(root, "media/tts.mjs")
    const { stdout } = await run("node", [script, args.scriptFile, args.voice, args.jobDir], { maxBuffer: 1024 * 1024 })
    return stdout.trim()
  },
})

// OpenCode custom tool: Groq Whisper transcription. Thin shell over
// media/whisper.mjs (chunks long audio, merges segments with offsets).
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

const run = promisify(execFile)

export default tool({
  description:
    "Transcribe an audio file with Groq Whisper (whisper-large-v3). Writes transcript.txt, captions.srt and timing.json into the job directory. This is the FIRST step of voice mode — the SRT is a deliverable by itself.",
  args: {
    audioFile: tool.schema.string().describe("Path to the user's audio file"),
    jobDir: tool.schema.string().describe("Job directory (core/sandbox/<job>)"),
  },
  async execute(args) {
    const root = resolve(process.cwd(), "..")
    const script = resolve(root, "media/whisper.mjs")
    const { stdout } = await run("node", [script, args.audioFile, args.jobDir], { maxBuffer: 1024 * 1024, timeout: 1000 * 60 * 60 })
    return stdout.trim()
  },
})

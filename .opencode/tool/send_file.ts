// OpenCode custom tool: deliver a file to the owner's Telegram chat.
// Format: OpenCode v1 custom tool (default export from @opencode-ai/plugin).
//
// This tool runs inside the OpenCode server process, which has no
// Telegram token — it cannot send anything itself. Instead it writes a
// small JSON request into the project's data/outbox/ folder; the bot
// process watches that folder and performs the actual Telegram send
// (videos are size-capped / store-linked there). Claiming in chat text
// that a file was sent WITHOUT calling this tool sends nothing — the
// bridge notices and will ask again.
import { tool } from "@opencode-ai/plugin"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, basename } from "node:path"

export default tool({
  description:
    "Send an existing project file to the owner's Telegram chat — this is the ONLY way to deliver a video, animatic, contact sheet, subtitles or any other file to him. Videos over Telegram's limit are shrunk and backed up to the store automatically. The send itself is performed by the bot within a couple of seconds; say in your reply that the file is on its way ONLY after calling this. Set final=true ONLY when this file is the FINISHED video of the current job: the delivery then closes the conversation session (the next thing he asks for starts a fresh session, with your memory files as continuity).",
  args: {
    path: tool.schema.string().describe("Path to the file, relative to the project root (e.g. core/sandbox/2026-11-01-rain/render/animatic.mp4) or absolute"),
    caption: tool.schema.string().optional().describe("Optional short caption sent with the file"),
    final: tool.schema.boolean().optional().describe("True ONLY for the finished video that completes the current job — its delivery ends the current session. Previews/animatics: leave unset."),
  },
  async execute(args) {
    const root = resolve(process.cwd(), "..")
    const abs = resolve(root, args.path)
    if (!existsSync(abs)) {
      return `ERROR: file not found: ${args.path} (resolved to ${abs}). Nothing was queued — check the path and call send_file again.`
    }
    const outbox = resolve(root, "data", "outbox")
    mkdirSync(outbox, { recursive: true })
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : abs
    writeFileSync(resolve(outbox, name), JSON.stringify({ path: rel, caption: args.caption || '', final: !!args.final, queuedAt: Date.now() }, null, 2))
    return `Queued for delivery to the Telegram chat: ${basename(abs)}. The bot will send it within a couple of seconds.${args.final ? ' Marked as the FINAL delivery — this session will close once it is sent; update data/memory/ (index line + any preferences) before you finish.' : ''}`
  },
})

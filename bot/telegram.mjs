// Thin Telegram Bot API client over fetch. Base URL comes from
// TELEGRAM_API_BASE so a self-hosted telegram-bot-api server (2 GB uploads)
// can replace the cloud API later without code changes.
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../lib/env.mjs';

export class Telegram {
  constructor(token, base = env('TELEGRAM_API_BASE', 'https://api.telegram.org')) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
    this.token = token;
    this.apiBase = base.replace(/\/$/, '');
    this.base = `${this.apiBase}/bot${token}`;
    this.offset = 0;
  }

  async call(method, params = {}, { timeoutMs = 0 } = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      const err = new Error(`Telegram ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
      err.telegram = json; // error_code / parameters.retry_after ride along for the poll loop
      throw err;
    }
    return json.result;
  }

  async callForm(method, fields, fileField, filePath, filename) {
    const { readFileSync } = await import('node:fs');
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    form.append(fileField, new Blob([readFileSync(filePath)]), filename);
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', body: form });
    const json = await res.json().catch(() => null);
    if (!json?.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
    return json.result;
  }

  /** Register the "/" command menu shown by Telegram clients.
      Non-fatal by design: a failure here is logged, never thrown — a
      missing menu must not stop the bot. */
  setMyCommands(commands) {
    return this.call('setMyCommands', { commands })
      .catch(e => console.warn('[telegram] setMyCommands failed (command menu not set):', e.message));
  }
  sendMessage(chatId, text, replyMarkup) {
    return this.call('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  /** "typing…" indicator (lasts ~5 s per call — re-send while busy).
      Best-effort by design: a failed indicator must never break a turn. */
  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }
  editMessageText(chatId, messageId, text, replyMarkup) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
      .catch(e => { if (!/message is not modified/.test(e.message)) throw e; });
  }
  answerCallback(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {});
  }
  sendVideo(chatId, filePath, caption) {
    return this.callForm('sendVideo', { chat_id: chatId, caption: caption || '', supports_streaming: true }, 'video', filePath, 'video.mp4');
  }
  sendDocument(chatId, filePath, filename, caption) {
    return this.callForm('sendDocument', { chat_id: chatId, caption: caption || '' }, 'document', filePath, filename);
  }
  sendPhoto(chatId, filePath, caption, replyMarkup) {
    return this.callForm('sendPhoto', { chat_id: chatId, caption: caption || '', ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}) }, 'photo', filePath, 'sheet.jpg');
  }

  /** Download a file the user sent (by file_id) to a local path. */
  async download(fileId, destPath) {
    const file = await this.call('getFile', { file_id: fileId });
    const url = `${this.apiBase}/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    return destPath;
  }

  /** Long polling; handler(update) is awaited per update.
   *  Resilience contract: this loop NEVER dies. Network errors, timeouts,
   *  409s (another poller on the same token) and 429s are logged and
   *  retried with exponential backoff (3 s → 6 → 12 → 24 → 30 s cap,
   *  honouring Telegram's retry_after when given); a successful poll
   *  resets the backoff. The getUpdates fetch itself carries a client
   *  timeout slightly longer than the long-poll window, so a hung
   *  connection cannot stall the bot forever either. */
  async poll(handler, { timeoutSec = 50 } = {}) {
    let backoffMs = 3000;
    for (;;) {
      let updates = [];
      try {
        updates = await this.call(
          'getUpdates',
          { offset: this.offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: (timeoutSec + 20) * 1000 },
        );
        // A malformed payload must retry with backoff like any other
        // poll failure — never escape the loop and stop polling.
        if (!Array.isArray(updates)) throw new Error('getUpdates returned a non-array result');
        backoffMs = 3000; // healthy again
      } catch (e) {
        const code = e.telegram?.error_code;
        const retryAfter = e.telegram?.parameters?.retry_after;
        if (code === 409) {
          console.error('[telegram] poll: 409 Conflict — another program is polling this same bot token. Waiting and retrying (stop the other one if this keeps repeating).');
        } else if (code === 429) {
          console.error(`[telegram] poll: 429 Too Many Requests — backing off${retryAfter ? ` for ${retryAfter}s (Telegram's retry_after)` : ''}.`);
        } else {
          console.error('[telegram] poll error:', e.message);
        }
        const waitMs = retryAfter ? retryAfter * 1000 : backoffMs;
        await new Promise(r => setTimeout(r, waitMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try { await handler(u); } catch (e) { console.error('[telegram] handler error:', e.message); }
      }
    }
  }
}

/** Build an inline keyboard: rows = [[{text, data}], ...] */
export function keyboard(rows) {
  return { inline_keyboard: rows.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) };
}

/** Split buttons into rows of n. */
export function rowsOf(buttons, n = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
}

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

  async call(method, params = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
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

  sendMessage(chatId, text, replyMarkup) {
    return this.call('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
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

  /** Long polling; handler(update) is awaited per update. */
  async poll(handler, { timeoutSec = 50 } = {}) {
    for (;;) {
      let updates = [];
      try {
        updates = await this.call('getUpdates', { offset: this.offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
      } catch (e) {
        console.error('[telegram] poll error:', e.message);
        await new Promise(r => setTimeout(r, 3000));
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

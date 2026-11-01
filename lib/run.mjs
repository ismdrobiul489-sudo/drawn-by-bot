// Small child-process helpers shared by bot/ and media/.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Run a command, capture stdout+stderr. Rejects on non-zero exit / timeout. */
export function run(cmd, args = [], { cwd, timeoutMs = 0, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(Object.assign(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`), { stdout: out, stderr: err, code }));
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** Spawn a long-lived streaming process; onLine receives each stdout line. */
export function runStreaming(cmd, args = [], { cwd, env: extraEnv, onLine, onStderr } = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line && onLine) onLine(line);
    }
  });
  if (onStderr) child.stderr.on('data', d => onStderr(String(d)));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  return { child, done };
}

export function binaryExists(name) {
  if (name.includes('/')) return existsSync(name);
  const path = process.env.PATH || '';
  return path.split(':').some(dir => dir && existsSync(`${dir}/${name}`));
}

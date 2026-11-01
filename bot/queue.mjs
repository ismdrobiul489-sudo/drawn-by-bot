// FIFO job queue with exactly ONE active job (the NVIDIA sequential rule and
// the single-VPS reality both demand it). Persisted to data/jobs.json so a
// restart never loses a queued video.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env.mjs';

const FILE = join(ROOT, 'data', 'jobs.json');

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { seq: 0, queue: [], active: null, history: [] }; }
}
function save(db) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export class JobQueue {
  constructor(runJob) {
    this.runJob = runJob; // async (job, db helpers) => void
    this.db = load();
    this.busy = false;
    // A job left "active" by a crash goes back to the front of the queue.
    if (this.db.active) { this.db.queue.unshift(this.db.active); this.db.active = null; save(this.db); }
  }

  enqueue(job) {
    job.id = `job-${++this.db.seq}`;
    job.status = 'queued';
    job.createdAt = Date.now();
    this.db.queue.push(job);
    save(this.db);
    this.pump();
    return job;
  }

  get(id) {
    if (this.db.active?.id === id) return this.db.active;
    return this.db.queue.find(j => j.id === id) || this.db.history.find(j => j.id === id) || null;
  }

  position(id) { return this.db.queue.findIndex(j => j.id === id); }

  update(job, patch) { Object.assign(job, patch); save(this.db); }

  async pump() {
    if (this.busy || !this.db.queue.length) return;
    this.busy = true;
    const job = this.db.queue.shift();
    job.status = 'running';
    job.startedAt = Date.now();
    this.db.active = job;
    save(this.db);
    try {
      await this.runJob(job);
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
    }
    job.finishedAt = Date.now();
    this.db.active = null;
    this.db.history.unshift(job);
    this.db.history = this.db.history.slice(0, 50);
    save(this.db);
    this.busy = false;
    this.pump();
  }
}

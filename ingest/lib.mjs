import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { RAW_DIR, OUT_DIR } from './config.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Package names contain '/' (scopes) which cannot appear in a filename, and on
 * Windows they cannot contain ':' either. '+' is safe on both platforms and,
 * unlike '%2F', survives a round trip through shell globbing unescaped.
 */
export function cacheFileFor(name) {
  return path.join(RAW_DIR, `${name.replace(/\//g, '+')}.json`);
}

export function registryUrlFor(name, registry) {
  // The registry accepts a percent-encoded slash for scoped packages.
  return `${registry}/${name.replace(/\//g, '%2F')}`;
}

export async function ensureDirs() {
  await fsp.mkdir(RAW_DIR, { recursive: true });
  await fsp.mkdir(OUT_DIR, { recursive: true });
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value), 'utf8');
}

export function exists(file) {
  return fs.existsSync(file);
}

/**
 * Streaming JSONL writer. The ingest stages emit hundreds of thousands of rows;
 * building an array and joining it holds the whole set in memory for no reason.
 */
export class JsonlWriter {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    this.count = 0;
    this.draining = null;
  }

  /**
   * Returns null when the row was buffered, or a promise to await when the
   * stream is full. A single shared drain promise is reused: attaching one
   * listener per blocked write leaks them, and Node warns at ten.
   */
  write(row) {
    this.count += 1;
    if (this.stream.write(`${JSON.stringify(row)}\n`)) return null;
    if (!this.draining) {
      this.draining = new Promise((resolve) => {
        this.stream.once('drain', () => {
          this.draining = null;
          resolve();
        });
      });
    }
    return this.draining;
  }

  async close() {
    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });
    return this.count;
  }
}

export async function* readJsonl(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line);
  }
}

export function outPath(name) {
  return path.join(OUT_DIR, name);
}

/**
 * Progress reporting that does not scroll the terminal into uselessness during a
 * multi-thousand-package crawl.
 */
export function progress(label, everyMs = 2000) {
  let last = 0;
  return (done, total, extra = '') => {
    const now = Date.now();
    const final = total !== undefined && done >= total;
    if (!final && now - last < everyMs) return;
    last = now;
    const of = total === undefined ? '' : `/${total}`;
    process.stdout.write(`\r${label}: ${done}${of} ${extra}`.padEnd(78));
    if (final) process.stdout.write('\n');
  };
}

export function done(label, count, startedAt) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\r${label}: ${count} rows in ${secs}s`.padEnd(78) + '\n');
}

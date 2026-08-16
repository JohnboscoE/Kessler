import { USER_AGENT, RETRIES, RETRY_BASE_MS } from './config.mjs';
import { sleep } from './lib.mjs';

/**
 * GET with retry on 429 and 5xx, honouring Retry-After.
 *
 * Returns the parsed body, or null on 404. A 404 is a normal answer here —
 * "this name is not published" is exactly what the squat check is asking.
 */
export async function getJson(url) {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      });
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    if (res.status === 404) return null;
    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      if (attempt === RETRIES) throw new Error(`${res.status} after ${RETRIES} retries`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RETRY_BASE_MS * 2 ** attempt
      );
      continue;
    }
    throw new Error(`${res.status} ${res.statusText}`);
  }
  throw new Error('exhausted retries');
}

/**
 * Existence check. HEAD avoids pulling a multi-megabyte packument just to learn
 * whether a name is taken — and the squat scan issues tens of thousands of these.
 */
export async function exists(url) {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': USER_AGENT } });
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    if (res.status === 404) return false;
    if (res.ok) return true;

    if (res.status === 429 || res.status >= 500) {
      if (attempt === RETRIES) throw new Error(`${res.status} after ${RETRIES} retries`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RETRY_BASE_MS * 2 ** attempt
      );
      continue;
    }
    throw new Error(`${res.status} ${res.statusText}`);
  }
  throw new Error('exhausted retries');
}

/**
 * Concurrency-limited map over a fixed work list.
 */
export async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

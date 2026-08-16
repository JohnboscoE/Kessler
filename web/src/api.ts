/**
 * Client for the Kessler API.
 *
 * The API holds the HydraDB bearer token and owns the Cypher; this file only
 * shapes requests and surfaces failures honestly. A 502 means the graph database
 * is down, and the UI says exactly that rather than showing an empty result —
 * "no paths found" and "could not ask" are completely different answers to a
 * security question.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8787';

export type ScanPath = {
  nodes: string[];
  depth: number;
};

export type ScanResult = {
  compromised: string;
  sources: number;
  packages: number;
  devSkipped: number;
  exposedCount: number;
  maxDepth: number;
  elapsedMs: number;
  paths: ScanPath[];
};

export type Coverage = {
  packages: number;
  maxDepth: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: 'offline' | 'database' | 'input' | 'notfound' | 'unknown'
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError(`Cannot reach the Kessler API at ${BASE}.`, null, 'offline');
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to status-based handling */
  }

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(
      message,
      res.status,
      res.status === 502 ? 'database' : res.status === 404 ? 'notfound' : res.status === 400 ? 'input' : 'unknown'
    );
  }
  return body as T;
}

export function scan(lockfile: string, compromised: string): Promise<ScanResult> {
  return request<ScanResult>('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lockfile, compromised }),
  });
}

export function coverage(): Promise<Coverage> {
  return request<Coverage>('/coverage');
}

export function health(): Promise<{ ok: boolean; hydradb: string }> {
  return request('/health');
}

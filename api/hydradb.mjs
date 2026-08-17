/**
 * HydraDB client over the HTTP/JSON API.
 *
 * KESSLER.md §5.3 is explicit: if Bolt auth is awkward, do not burn hours on it —
 * the HTTP API is fully documented and sufficient for everything Kessler needs.
 * This is that path. The interface is narrow enough that a Bolt implementation
 * can be dropped in behind it later if there is a reason to.
 *
 * Verified against a running node on Aug 16:
 *
 *   - The parameter field is `parameters`, not `params` (src/client/http.rs:289).
 *   - Parameters are mandatory for UNWIND batches: "UNWIND batch input must be a
 *     parameter", and an inline literal list is rejected. There is therefore no
 *     inlining fallback for writes — it would simply fail.
 *   - Responses are `{columns: [...], rows: [[cell, ...]]}` where each cell is a
 *     tagged `{type, value}`. Rows are positional arrays aligned to `columns`,
 *     not objects, so they are zipped here into plain objects.
 */

const DEFAULTS = {
  baseUrl: process.env.HYDRADB_URL ?? 'http://127.0.0.1:8443',
  graph: process.env.HYDRADB_GRAPH ?? 'default',
  namespace: process.env.HYDRADB_NAMESPACE ?? 'default',
  cellId: process.env.HYDRADB_CELL_ID ?? 'cell-0',
  token: process.env.HYDRADB_TOKEN ?? 'local-development-token-32-bytes',
};

export class HydraDB {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
  }

  get endpoint() {
    const { baseUrl, graph } = this.config;
    return `${baseUrl.replace(/\/$/, '')}/v1/graphs/${graph}/query`;
  }

  /**
   * `timeoutMs` maps to the server's `timeout_ms`, which raises the per-query
   * runtime limit above its 30s default. Bulk edge writes need it: each row
   * MATCHes two vertices, so a batch gets slower as the graph grows and a
   * 1,000-row batch will exceed 30s well before the load finishes.
   */
  async run(query, parameters = {}, { timeoutMs } = {}) {
    const body = Object.keys(parameters).length > 0 ? { query, parameters } : { query };
    if (timeoutMs) body.timeout_ms = timeoutMs;
    return this.post(body);
  }

  async post(body) {
    const { cellId, token, namespace } = this.config;
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-graph-namespace': namespace,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cell_id: cellId, ...body }),
      });
    } catch (cause) {
      throw new HydraError(`cannot reach HydraDB at ${this.endpoint}`, { cause });
    }

    const text = await res.text();
    if (!res.ok) {
      throw new HydraError(`HydraDB ${res.status}: ${text.slice(0, 400)}`, {
        status: res.status,
      });
    }
    const parsed = parseBody(text);
    // The server answers 200 with an {error:{code,message}} envelope for
    // unsupported queries, so a non-2xx check alone is not enough.
    if (parsed?.error) {
      throw new HydraError(`HydraDB ${parsed.error.code ?? 'error'}: ${parsed.error.message}`, {
        status: parsed.error.code === 'query_timeout' ? 408 : 400,
      });
    }
    return parsed;
  }

  /**
   * A standalone `RETURN 1` is rejected — "row execution supports MATCH ...
   * RETURN queries" — so the health probe has to be a real match. Counting
   * Package returns 0 rather than erroring on an empty graph, which is exactly
   * what a liveness check wants.
   */
  async healthy() {
    try {
      await this.run('MATCH (n:Package) RETURN count(*) AS n');
      return true;
    } catch {
      return false;
    }
  }
}

export class HydraError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message, { cause });
    this.name = 'HydraError';
    this.status = status;
  }
}

/** JSON, or NDJSON for streamed results. */
function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [] };
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return lines.length === 1 ? lines[0] : { rows: lines };
  }
}

/**
 * Turn `{columns:['id'], rows:[[{type:'vertex_id',value:2}]]}` into
 * `[{id: 2}]`.
 *
 * Cells are tagged unions. The tag carries real information — a `vertex_id` is
 * not the same thing as a string property — but every consumer in Kessler wants
 * the value, so unwrapping happens once here rather than at each call site.
 */
export function toObjects(result) {
  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];
  if (!columns.length) return [];
  return rows.map((row) => {
    const out = {};
    columns.forEach((column, i) => {
      out[column] = unwrap(row[i]);
    });
    return out;
  });
}

export function unwrap(cell) {
  if (cell === null || cell === undefined) return null;
  if (Array.isArray(cell)) return cell.map(unwrap);
  if (typeof cell === 'object') {
    if ('value' in cell) return unwrap(cell.value);
    return cell;
  }
  return cell;
}

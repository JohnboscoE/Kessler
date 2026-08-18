import { useCallback, useEffect, useRef, useState } from 'react';
import {
  scan,
  coverage,
  loadExampleLockfile,
  incidents as fetchIncidents,
  chokepoints as fetchChokepoints,
  EXAMPLE,
  ApiError,
  type ScanResult,
  type Coverage,
  type Incident,
  type ChokePoint,
} from './api';

/**
 * The instrument.
 *
 * DESIGN.md §2 and §7 apply here in full: no ambient motion, no video behind any
 * data surface, and colour only where the graph reports a real path. The landing
 * page animates; this does not.
 *
 * §10's copy table drives the state text. The distinction that matters is
 * between "no path found" and "could not ask" — a clear result and a broken
 * database must never look alike on a security readout.
 */

type State =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'done'; result: ScanResult }
  | { status: 'error'; message: string; kind: ApiError['kind'] };

export function AppView({ onBack }: { onBack: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [lockfile, setLockfile] = useState<{ name: string; text: string } | null>(null);
  const [target, setTarget] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const [cover, setCover] = useState<Coverage | null>(null);
  const [known, setKnown] = useState<Incident[]>([]);
  const [chokes, setChokes] = useState<ChokePoint[] | 'loading' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    coverage()
      .then(setCover)
      .catch(() => setCover(null));
    fetchIncidents()
      .then((r) => setKnown(r.incidents))
      .catch(() => setKnown([]));
  }, []);

  const findChokepoints = useCallback(async () => {
    if (!lockfile) return;
    setChokes('loading');
    try {
      const r = await fetchChokepoints(lockfile.text);
      setChokes(r.chokepoints);
    } catch {
      setChokes(null);
    }
  }, [lockfile]);

  const readFile = useCallback(async (file: File) => {
    const text = await file.text();
    setLockfile({ name: file.name, text });
    setState({ status: 'idle' });
  }, []);

  const loadExample = useCallback(async () => {
    try {
      const text = await loadExampleLockfile();
      setLockfile({ name: `${EXAMPLE.label} (example)`, text });
      setTarget(EXAMPLE.target);
      setState({ status: 'idle' });
    } catch (err) {
      setState({ status: 'error', message: (err as ApiError).message, kind: 'unknown' });
    }
  }, []);

  const run = useCallback(async () => {
    if (!lockfile || !target.trim()) return;
    setState({ status: 'scanning' });
    try {
      const result = await scan(lockfile.text, target.trim());
      setState({ status: 'done', result });
    } catch (err) {
      const api = err as ApiError;
      setState({
        status: 'error',
        message: api.message ?? 'Something went wrong.',
        kind: api.kind ?? 'unknown',
      });
    }
  }, [lockfile, target]);

  const ready = Boolean(lockfile) && target.trim().length > 0;

  return (
    <div className="page page--app">
      <header className="nav nav--app">
        <button type="button" className="nav__mark nav__mark--button" onClick={onBack}>
          KESSLER
        </button>
        <span className="label">Instrument</span>
      </header>

      <main className="app">
        <div className="label">Input</div>
        <h2 className="app__title">Map exposure</h2>

        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
          }}
        />

        <div
          className="upload"
          role="button"
          tabIndex={0}
          data-dragging={dragging}
          data-loaded={Boolean(lockfile)}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
        >
          {lockfile
            ? `${lockfile.name} loaded.`
            : 'Drop a package-lock.json to map exposure.'}
        </div>

        <label className="field-row">
          <span className="label">Compromised package</span>
          <input
            className="input"
            type="text"
            placeholder="lodash@4.17.21"
            spellCheck={false}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void run();
            }}
          />
        </label>

        {/* Two ways to answer "what do I type here". Real advisories, or the
            choke points in your own tree when no advisory has landed. */}
        {known.length > 0 && (
          <div className="picker">
            <div className="label">Documented compromises</div>
            <div className="picker__row">
              {known.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  className="chip"
                  title={`${i.date} — ${i.summary}`}
                  data-absent={!i.inGraph}
                  onClick={() => setTarget(i.key)}
                >
                  {i.label}
                  {!i.inGraph && <span className="chip__note">not in graph</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {lockfile && (
          <div className="picker">
            <div className="label">Or find your own weak points</div>
            <p className="data picker__hint">
              Nothing has to have happened yet. This ranks the packages your tree
              depends on most heavily and most deeply — the ones a compromise
              would hurt most.
            </p>
            <button type="button" className="btn btn--quiet" onClick={() => void findChokepoints()}>
              {chokes === 'loading' ? 'Traversing…' : 'Analyse this lockfile'}
            </button>
            {Array.isArray(chokes) && chokes.length > 0 && (
              <ul className="chokes">
                {chokes.map((c) => (
                  <li key={c.target} className="chokes__row">
                    <button type="button" className="chokes__pick" onClick={() => setTarget(c.target)}>
                      {c.target}
                    </button>
                    <span className="chokes__meta">
                      reached by {c.reachedBy} · depth {c.maxDepth}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="app__actions">
          <button type="button" className="btn" disabled={!ready} onClick={() => void run()}>
            {state.status === 'scanning' ? 'Traversing 6 shells.' : 'Map exposure'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => void loadExample()}>
            Try the example
          </button>
        </div>

        <Result state={state} />

        <p className="bound">
          {cover
            ? `Graph covers ${cover.packages.toLocaleString()} packages. Paths bounded at depth ${cover.maxDepth}. Dev dependencies excluded.`
            : 'Paths bounded at depth 6. Dev dependencies excluded.'}
        </p>
      </main>
    </div>
  );
}

function Result({ state }: { state: State }) {
  if (state.status === 'idle') return null;

  if (state.status === 'scanning') {
    return (
      <div className="panel">
        <div className="label">Result</div>
        <p className="data panel__empty">Traversing 6 shells.</p>
      </div>
    );
  }

  if (state.status === 'error') {
    // A failure to reach the graph is not a clean result and must not read like
    // one. §10's error copy is used verbatim where it applies.
    const explanation =
      state.kind === 'database'
        ? 'The graph database is not answering, so no traversal ran. This is not a clear result.'
        : state.kind === 'offline'
          ? 'The API is not running. Start it with npm run api.'
          : null;
    return (
      <div className="panel panel--error">
        <div className="label">Could not ask</div>
        <p className="data">{state.message}</p>
        {explanation ? <p className="data panel__empty">{explanation}</p> : null}
      </div>
    );
  }

  const { result } = state;
  const clear = result.exposedCount === 0;

  return (
    <div className="panel">
      <div className="label">Result</div>

      {/* A replayed result must never read as a live traversal. This says so
          before the finding itself, not in small print underneath it. */}
      {result.recorded && (
        <p className="data panel__empty">
          Recorded result — no API is reachable, so this is a traversal captured on{' '}
          {new Date(result.recorded.at).toISOString().slice(0, 10)} against a graph of{' '}
          {result.recorded.graph.packages.toLocaleString()} packages and{' '}
          {result.recorded.graph.edges.toLocaleString()} resolved edges. It is replayed only for
          the bundled example; any other lockfile needs the API running.
        </p>
      )}

      <p className={clear ? 'data' : 'data data--breach'}>
        {clear
          ? `No path found within ${result.maxDepth} hops.`
          : `${result.exposedCount} of ${result.sources} packages reach ${result.compromised}.`}
      </p>

      {result.paths.length > 0 && (
        <ul className="paths">
          {result.paths.map((path, i) => (
            <li className="paths__row" key={`${path.nodes.join('>')}-${i}`}>
              <span className="paths__chain">{path.nodes.join('  →  ')}</span>
              <span className="paths__depth">depth {path.depth}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="data panel__meta">
        {result.sources.toLocaleString()} sources traversed in one call · {result.elapsedMs} ms
        {result.devSkipped > 0 ? ` · ${result.devSkipped} dev dependencies excluded` : ''}
      </p>

      <Coverage result={result} />
    </div>
  );
}

/**
 * Coverage is stated, never implied. "No path found" and "only part of your
 * half your dependencies" are different answers, and on a security readout the
 * difference matters more than the tidiness of hiding it.
 */
function Coverage({ result }: { result: ScanResult }) {
  const { coverage: c, ingested } = result;
  if (!c) return null;

  const complete = c.missingCount === 0;
  const ingestedCount = ingested && !ingested.skipped ? ingested.versionsWritten ?? 0 : 0;

  return (
    <p className="data panel__coverage">
      {complete ? (
        <>All {c.total.toLocaleString()} of your resolved dependencies are in the graph.</>
      ) : (
        <>
          {c.inGraph.toLocaleString()} of {c.total.toLocaleString()} of your resolved dependencies
          are in the graph. {c.missingCount.toLocaleString()} could not be placed
          {c.missing.length > 0 ? `, including ${c.missing.slice(0, 3).join(', ')}` : ''}. Results
          cover the ones that are.
        </>
      )}
      {ingestedCount > 0 && (
        <>
          {' '}
          Your lockfile was ingested into the graph ({ingestedCount.toLocaleString()} versions
          {ingested?.ms ? `, ${ingested.ms} ms` : ''}) — a lockfile is already a resolved graph, so
          no registry lookups were needed.
        </>
      )}
      {ingested?.skipped && <> Ingest skipped: {ingested.skipped}</>}
    </p>
  );
}

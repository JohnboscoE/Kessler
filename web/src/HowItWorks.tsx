import { useEffect, useRef, useState } from 'react';

/**
 * Looped explainer, DESIGN.md §7 exception granted for the landing surface.
 *
 * Four steps on a loop, showing the actual mechanism rather than a decorative
 * cycle: a lockfile becomes source nodes, a compromised package becomes the
 * target, one traversal runs from every source at once, and the paths that
 * reach it are reported. The middle step is the argument for HydraDB — the
 * traversal is one server-side call, not one round trip per dependency.
 *
 * Pauses when off screen and when the tab is hidden, so it is not burning
 * animation frames behind the fold.
 */

const STEPS = [
  {
    label: 'Input',
    title: 'Drop your lockfile',
    body: 'Every resolved dependency in package-lock.json becomes a source. A mid-size project contributes a few hundred.',
  },
  {
    label: 'Target',
    title: 'Name the compromised release',
    body: 'One package at one version. It becomes the single target the traversal is aiming at.',
  },
  {
    label: 'Traversal',
    title: 'One call, every source at once',
    body: 'Kessler asks HydraDB for paths from all sources to the target in a single server-side traversal, following pre-resolved version-to-version edges, bounded at six hops.',
  },
  {
    label: 'Result',
    title: 'The paths that actually reach it',
    body: 'Each exposed path with its depth and the release that introduced it. Everything that does not reach stays grey.',
  },
] as const;

const STEP_MS = 3000;

const SOURCES = [72, 128, 184, 240];
const MIDS = [110, 176, 242];
// Which source rows end up exposed, and through which middle node.
const EXPOSED_ROUTES = [
  { source: 0, mid: 0 },
  { source: 2, mid: 1 },
  { source: 3, mid: 1 },
];

export function HowItWorks() {
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(STEPS.length - 1);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setRunning(entries.some((e) => e.isIntersecting)),
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!running) return;
    const onVisibility = () => setRunning(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    const id = window.setInterval(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [running]);

  const exposedSources = new Set(EXPOSED_ROUTES.map((r) => r.source));

  return (
    <div className="how" ref={ref}>
      <svg className="how__svg" viewBox="0 0 800 320" data-step={step} aria-hidden="true">
        {/* stage 1 — lockfile rows */}
        <g className="how__lockfile">
          <rect x="24" y="48" width="150" height="216" rx="2" />
          {SOURCES.map((y, i) => (
            <g key={y}>
              <rect className="how__row" x="40" y={y - 8} width={104 - i * 12} height="6" rx="1" />
            </g>
          ))}
          <text className="how__caption" x="99" y="288" textAnchor="middle">
            package-lock.json
          </text>
        </g>

        {/* edges, drawn on the traversal step */}
        <g className="how__edges">
          {SOURCES.map((sy, si) => {
            const route = EXPOSED_ROUTES.find((r) => r.source === si);
            const my = route ? MIDS[route.mid] : MIDS[si % MIDS.length];
            return (
              <path
                key={`s${si}`}
                className={route ? 'how__edge how__edge--breach' : 'how__edge'}
                d={`M 250 ${sy} Q 340 ${sy} 420 ${my}`}
                style={{ transitionDelay: `${si * 90}ms` }}
              />
            );
          })}
          {MIDS.map((my, mi) => {
            const exposed = EXPOSED_ROUTES.some((r) => r.mid === mi);
            return (
              <path
                key={`m${mi}`}
                className={exposed ? 'how__edge how__edge--breach' : 'how__edge'}
                d={`M 460 ${my} Q 560 ${my} 660 176`}
                style={{ transitionDelay: `${360 + mi * 90}ms` }}
              />
            );
          })}
        </g>

        {/* source nodes */}
        <g className="how__sources">
          {SOURCES.map((y, i) => (
            <circle
              key={y}
              className={exposedSources.has(i) ? 'how__node how__node--breach' : 'how__node'}
              cx="250"
              cy={y}
              r="5"
              style={{ transitionDelay: `${i * 70}ms` }}
            />
          ))}
          <text className="how__caption" x="250" y="288" textAnchor="middle">
            your dependencies
          </text>
        </g>

        {/* intermediate nodes */}
        <g className="how__mids">
          {MIDS.map((y, i) => {
            const exposed = EXPOSED_ROUTES.some((r) => r.mid === i);
            return (
              <circle
                key={y}
                className={exposed ? 'how__node how__node--breach' : 'how__node'}
                cx="440"
                cy={y}
                r="5"
                style={{ transitionDelay: `${i * 70}ms` }}
              />
            );
          })}
          <text className="how__caption" x="440" y="288" textAnchor="middle">
            transitive hops
          </text>
        </g>

        {/* target */}
        <g className="how__target">
          <circle className="how__pulse" cx="680" cy="176" r="13" />
          <circle className="how__centre" cx="680" cy="176" r="13" />
          <text className="how__caption how__caption--target" x="680" y="288" textAnchor="middle">
            lodash@4.17.21
          </text>
        </g>

        <text className="how__readout" x="680" y="60" textAnchor="middle">
          3 of 4 reach it
        </text>
      </svg>

      <ol className="how__steps">
        {STEPS.map((s, i) => (
          <li key={s.label} className="how__step" data-active={i === step}>
            <div className="label">{s.label}</div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

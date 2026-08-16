import { useEffect, useRef, useState } from 'react';
import { nodes, edges, angleFor, SHELL_RADII, CENTRE } from './graph-demo';

/**
 * The depth-shell diagram, DESIGN.md §6.
 *
 * Compromised package at centre, direct dependencies on the outer shell, each
 * ring inward one hop. This makes HydraDB's maxLen:6 bound the visual system
 * rather than a limitation to apologise for.
 *
 * Placement is deterministic — angle from a stable hash of the package name,
 * radius from depth. No force simulation, no physics, no settling frames.
 */

const CX = 400;
const CY = 400;

// §7 propagation sweep: shell N illuminates at (N-1)*120ms over 240ms.
const STAGGER_MS = 120;
const ILLUMINATE_MS = 240;
const REPLAY_MS = 7000;

type Point = { x: number; y: number };

function positionOf(name: string, depth: number): Point {
  const radius = SHELL_RADII[depth - 1];
  const radians = (angleFor(name) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) };
}

const positions = new Map<string, Point>([[CENTRE, { x: CX, y: CY }]]);
for (const node of nodes) positions.set(node.name, positionOf(node.name, node.depth));

const depthOf = new Map<string, number>([[CENTRE, 0]]);
for (const node of nodes) depthOf.set(node.name, node.depth);

/** Quadratic bezier with the control point pulled 20% toward centre (§6). */
function arc(from: Point, to: Point): string {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const qx = mx + (CX - mx) * 0.2;
  const qy = my + (CY - my) * 0.2;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export function ShellDiagram({ replay = true }: { replay?: boolean }) {
  const [swept, setSwept] = useState(false);
  const [cycle, setCycle] = useState(0);
  const ref = useRef<SVGSVGElement>(null);

  // Sweep on first entry into the viewport, not on mount — the animation is the
  // mechanism being explained, so it should not have already finished by the
  // time it is scrolled to.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setSwept(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSwept(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!swept || !replay) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = window.setInterval(() => setCycle((c) => c + 1), REPLAY_MS);
    return () => window.clearInterval(id);
  }, [swept, replay]);

  return (
    <svg
      ref={ref}
      className="shell"
      viewBox="0 0 800 800"
      role="img"
      aria-label={`Dependency shells around ${CENTRE}. Six rings, each one hop further from the compromised package.`}
      data-swept={swept}
      key={cycle}
    >
      {SHELL_RADII.map((r, i) => (
        <g key={r}>
          <circle className="shell__ring" cx={CX} cy={CY} r={r} />
          <text className="shell__label" x={CX} y={CY - r - 8} textAnchor="middle">
            {i + 1}
          </text>
        </g>
      ))}

      {edges.map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const depth = depthOf.get(edge.from) ?? 1;
        return (
          <path
            key={`${edge.from}->${edge.to}`}
            className={edge.exposed ? 'shell__edge shell__edge--breach' : 'shell__edge'}
            d={arc(from, to)}
            style={{
              transitionDelay: `${(depth - 1) * STAGGER_MS}ms`,
              transitionDuration: `${ILLUMINATE_MS}ms`,
            }}
          />
        );
      })}

      {nodes.map((node) => {
        const p = positions.get(node.name);
        if (!p) return null;
        return (
          <circle
            key={node.name}
            className={node.exposed ? 'shell__node shell__node--breach' : 'shell__node'}
            cx={p.x}
            cy={p.y}
            r={node.exposed ? 5 : 4}
            style={{
              transitionDelay: `${(node.depth - 1) * STAGGER_MS}ms`,
              transitionDuration: `${ILLUMINATE_MS}ms`,
            }}
          >
            <title>{`${node.name} — depth ${node.depth}`}</title>
          </circle>
        );
      })}

      <circle className="shell__pulse" cx={CX} cy={CY} r={14} />
      <circle className="shell__centre" cx={CX} cy={CY} r={14}>
        <title>{CENTRE}</title>
      </circle>
    </svg>
  );
}

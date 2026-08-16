import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Field } from './Field';
import { ShellDiagram } from './ShellDiagram';
import { HowItWorks } from './HowItWorks';

/**
 * The landing page.
 *
 * DESIGN.md §2/§7 forbid ambient motion — that rule governs the instrument, the
 * surface where real data is read, and it still does. The landing page is a
 * different surface: it explains the product to someone who has not used it, and
 * it hands them off via Launch app. Motion here is entrance-only and driven by
 * scroll position; it never runs underneath a data readout.
 *
 * The one animation of substance is the propagation sweep itself, which is the
 * mechanism rather than decoration.
 */

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="reveal" data-shown={shown} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const CAPABILITIES = [
  {
    label: 'Blast radius',
    title: 'Every path, not just the direct hit',
    body: 'Name a compromised package and Kessler returns every transitive path from your direct dependencies to it, bounded at six hops. One server-side traversal across every source in your lockfile at once.',
  },
  {
    label: 'Introduction point',
    title: 'Which release let it in',
    body: 'For each exposed path, the version of the intermediate dependency that first introduced the edge — so you know what to pin, and what to roll back to.',
  },
  {
    label: 'Live window',
    title: 'Whether you were exposed when it mattered',
    body: 'Which of your versions resolved to the compromised release during the window it was actually live on the registry, using per-version publish timestamps.',
  },
  {
    label: 'Maintainer overlap',
    title: 'Where they might go next',
    body: 'Which other packages in your graph share a maintainer with the compromised one. A credential compromise rarely stops at a single package.',
  },
  {
    label: 'Typosquat neighbourhood',
    title: 'Names that sit one keystroke away',
    body: 'Published names within a small edit distance of the packages you depend on, classified by how they differ — omission, duplication, adjacent key, separator, or scope confusion.',
  },
];

export function Landing({ onLaunch }: { onLaunch: () => void }) {
  return (
    <>
      <Field />
      <div className="page">
        <header className="nav">
          <span className="nav__mark">KESSLER</span>
          <button type="button" className="btn" onClick={onLaunch}>
            Launch app
          </button>
        </header>

        <section className="hero">
          <Reveal>
            <div className="label">Supply chain blast radius</div>
          </Reveal>
          <Reveal delay={60}>
            <h1>One compromise. Every path it reaches.</h1>
          </Reveal>
          <Reveal delay={120}>
            <p className="lede">
              When a package is compromised, the question is not whether you
              depend on it. It is how many hops away it sits, which of your
              releases pulled it in, and when. Kessler answers that from your
              lockfile.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div className="hero__actions">
              <button type="button" className="btn btn--lead" onClick={onLaunch}>
                Launch app
              </button>
              <span className="data hero__note">No account. Nothing is stored.</span>
            </div>
          </Reveal>
        </section>

        <section className="section section--diagram">
          <div className="section__intro">
            <Reveal>
              <div className="label">The model</div>
            </Reveal>
            <Reveal delay={60}>
              <h2>Distance from the compromise is the whole picture</h2>
            </Reveal>
            <Reveal delay={120}>
              <p className="lede">
                The compromised package sits at the centre. Each ring outward is
                one hop through a resolved dependency edge. Your direct
                dependencies land on the outer shell — everything between them
                and the centre is exposure you did not choose.
              </p>
            </Reveal>
            <Reveal delay={180}>
              <p className="data section__aside">
                Paths are bounded at depth 6. Real blast radius overwhelmingly
                sits inside that.
              </p>
            </Reveal>
          </div>
          <Reveal delay={120}>
            <ShellDiagram />
          </Reveal>
        </section>

        <section className="section">
          <Reveal>
            <div className="label">How it works</div>
          </Reveal>
          <Reveal delay={60}>
            <h2>From lockfile to blast radius in one traversal</h2>
          </Reveal>
          <HowItWorks />
        </section>

        <section className="section">
          <Reveal>
            <div className="label">What it answers</div>
          </Reveal>
          <div className="cards">
            {CAPABILITIES.map((c, i) => (
              <Reveal key={c.label} delay={i * 60}>
                <article className="card">
                  <div className="label">{c.label}</div>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="section section--close">
          <Reveal>
            <h2>Point it at a lockfile.</h2>
          </Reveal>
          <Reveal delay={60}>
            <div className="hero__actions">
              <button type="button" className="btn btn--lead" onClick={onLaunch}>
                Launch app
              </button>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <p className="bound">
              Graph covers a bounded slice of npm. Paths bounded at depth 6. Dev
              dependencies excluded — they do not propagate to consumers.
            </p>
          </Reveal>
        </section>

        <footer className="footer">
          <span className="data">Kessler</span>
          <span className="data">
            Graph traversal by HydraDB. Package data from the npm registry.
          </span>
        </footer>
      </div>
    </>
  );
}

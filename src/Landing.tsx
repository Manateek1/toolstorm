import { ArrowRight, ScanLine, SlidersHorizontal, SquareTerminal } from "lucide-react";
import radar from "./assets/storm-scan.webp";

const workflow = [
  { title: "Configure a fault", copy: "Choose which read fails and how long it stays broken.", Icon: SlidersHorizontal },
  { title: "Follow the trace", copy: "Inspect each MCP call, tool result, and retry in order.", Icon: SquareTerminal },
  { title: "Inspect the outcome", copy: "See the final ticket state and compare it with the original.", Icon: ScanLine },
];

export function Landing() {
  return (
    <main id="main-content" className="landing page-width" tabIndex={-1}>
      <section className="landing-hero hud-corners" aria-labelledby="landing-title">
        <div className="hero-copy">
          <h1 id="landing-title">Break the tool.<br />Watch the agent<br /><em>recover.</em></h1>
          <p>Run a support-ticket agent against simulated MCP failures, then inspect every tool call and outcome.</p>
          <div className="hero-actions">
            <a className="button button--primary" href="#lab">Open the lab <ArrowRight aria-hidden="true" /></a>
            <a className="sample-link" href="#sample">Explore a sample run <ArrowRight aria-hidden="true" /></a>
          </div>
        </div>
        <div className="hero-instrument" aria-hidden="true">
          <img src={radar} alt="" width="960" height="960" fetchPriority="high" />
          <div className="instrument-ticks" />
        </div>
      </section>
      <section className="landing-workflow hud-corners" aria-label="How Toolstorm works">
        {workflow.map(({ title, copy, Icon }) => (
          <article key={title}>
            <Icon aria-hidden="true" />
            <div><h2>{title}</h2><p>{copy}</p></div>
          </article>
        ))}
      </section>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CirclePlay,
  CircleX,
  Clock3,
  FileText,
  Laptop,
  LockKeyhole,
  Play,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { FAULTS, createTicketFixture, TASK_TEXT } from "./domain/fixture";
import { runScriptedScenario } from "./domain/scriptedRun";
import type { FaultKind, OutcomeCheck, RunMode, RunRecord, TraceEvent, TicketState } from "./domain/types";
import { clearRunHistory, exportRun, readRunHistory, saveRunHistory } from "./lib/history";

const PUBLIC_SCRIPTED_PREVIEW = import.meta.env.VITE_PUBLIC_SCRIPTED_PREVIEW === "true";
const HANZO_ONLY_BUILD = import.meta.env.PROD && !PUBLIC_SCRIPTED_PREVIEW;
const INITIAL_FAULT: FaultKind = "temporary_error";

interface LocalStatus {
  available: boolean;
  source: "local" | "vercel" | "unknown";
  hasHanzoKey: boolean;
  defaultModel: string;
}

function stringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return value === undefined ? fallback : stringify(value) || fallback;
}

function ToolstormMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="M23.8 8.2a11.2 11.2 0 1 0 3.4 7.8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20.4 11.6a6.3 6.3 0 1 0 1.9 4.4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" opacity=".78" />
      <path d="M22.3 16h4.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="27.1" cy="16" r="1.5" fill="currentColor" />
    </svg>
  );
}

function FaultIcon({ state }: { state: OutcomeCheck["state"] }) {
  if (state === "passed") return <CheckCircle2 aria-hidden="true" />;
  if (state === "failed") return <CircleX aria-hidden="true" />;
  return <CircleHelp aria-hidden="true" />;
}

function outcomeText(result: RunRecord["result"]) {
  if (result === "passed") return "All checks passed";
  if (result === "partial") return "Some checks need attention";
  return "Run did not complete safely";
}

function faultTitle(fault: FaultKind) {
  return FAULTS.find((item) => item.id === fault)?.title ?? "Temporary error";
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function StatusLabel({ status, kind }: { status: TraceEvent["status"]; kind: TraceEvent["kind"] }) {
  const text = status === "success"
    ? "Success"
    : status === "error"
      ? "Error"
      : status === "warning"
        ? kind === "retry" ? "Retry" : kind === "fault" ? "Injected" : "Warning"
        : status === "blocked"
          ? "Blocked"
          : "Step";
  return <span className={`trace-status trace-status--${status}`}>{text}</span>;
}

function TraceIcon({ kind, mode }: { kind: TraceEvent["kind"]; mode: RunMode }) {
  if (kind === "agent") return mode === "hanzo" ? <Bot aria-hidden="true" /> : <CirclePlay aria-hidden="true" />;
  if (kind === "tool") return <Wrench aria-hidden="true" />;
  if (kind === "retry") return <RotateCcw aria-hidden="true" />;
  if (kind === "fault") return <AlertTriangle aria-hidden="true" />;
  if (kind === "blocked") return <Shield aria-hidden="true" />;
  return <Activity aria-hidden="true" />;
}

function traceActor(kind: TraceEvent["kind"], mode: RunMode) {
  if (kind === "agent") return mode === "hanzo" ? "Agent" : "Script";
  if (kind === "tool") return "MCP tool";
  if (kind === "retry") return "Retry";
  if (kind === "fault") return "Injected fault";
  if (kind === "blocked") return "Guard";
  return "System";
}

function TraceRow({ event, mode }: { event: TraceEvent; mode: RunMode }) {
  const hasPayload = event.input !== undefined || event.output !== undefined;

  return (
    <details className={`trace-row trace-row--${event.status}`}>
      <summary className="trace-summary">
        <span className="trace-sequence">{String(event.sequence).padStart(2, "0")}</span>
        <span className="trace-icon"><TraceIcon kind={event.kind} mode={mode} /></span>
        <span className="trace-body">
          <span className="trace-heading">
            <span className="trace-actor">{traceActor(event.kind, mode)}</span>
            <strong>{event.title}</strong>
          </span>
          {event.detail && <span className="trace-detail">{event.detail}</span>}
        </span>
        <StatusLabel status={event.status} kind={event.kind} />
        <ChevronDown className="trace-chevron" aria-hidden="true" />
      </summary>
      {hasPayload && (
        <div className="trace-payload">
          {event.toolName && <span className="payload-tool">{event.toolName}</span>}
          {event.durationMs !== undefined && <span className="payload-time">{event.durationMs} ms</span>}
          {event.input !== undefined && (
            <div className="payload-block">
              <span>Input</span>
              <pre>{stringify(event.input)}</pre>
            </div>
          )}
          {event.output !== undefined && (
            <div className="payload-block">
              <span>Result</span>
              <pre>{stringify(event.output)}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function TicketStateCard({ title, ticket, after }: { title: string; ticket: TicketState; after?: boolean }) {
  const note = ticket.internalNotes.at(-1)?.text;

  return (
    <div className="snapshot-block">
      <div className="snapshot-heading">
        <span>{title}</span>
        {after && ticket.internalNotes.length > 0 && <span className="snapshot-changed">NOTE ADDED</span>}
      </div>
      <dl className="snapshot-details">
        <div><dt>Ticket</dt><dd>#{ticket.id}</dd></div>
        <div><dt>Status</dt><dd><span className="status-pill">{ticket.status}</span></dd></div>
        <div><dt>Priority</dt><dd>{ticket.priority}</dd></div>
        <div><dt>Requester</dt><dd>{ticket.requester}</dd></div>
        <div className="snapshot-detail--wide"><dt>Subject</dt><dd>{ticket.subject}</dd></div>
        <div><dt>Help article</dt><dd className="article-id">{ticket.helpArticleId}</dd></div>
        <div className="snapshot-detail--wide">
          <dt>Internal note</dt>
          <dd className={note ? "snapshot-note" : "snapshot-note snapshot-note--empty"}>{note ?? "None added"}</dd>
        </div>
      </dl>
    </div>
  );
}

function CheckRow({ check }: { check: OutcomeCheck }) {
  return (
    <li className={`check-row check-row--${check.state}`}>
      <span className="check-icon"><FaultIcon state={check.state} /></span>
      <span className="check-copy">
        <strong>{check.label}</strong>
        <span>{check.detail}</span>
      </span>
    </li>
  );
}

function App() {
  const [fault, setFault] = useState<FaultKind>(INITIAL_FAULT);
  const [mode, setMode] = useState<RunMode>(HANZO_ONLY_BUILD ? "hanzo" : "scripted");
  const [model, setModel] = useState("enso-auto");
  const [tokenLimit, setTokenLimit] = useState(2048);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [history, setHistory] = useState<RunRecord[]>(() => {
    const saved = readRunHistory();
    return HANZO_ONLY_BUILD ? saved.filter((run) => run.mode === "hanzo") : saved;
  });
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(() => PUBLIC_SCRIPTED_PREVIEW ? runScriptedScenario(INITIAL_FAULT) : null);
  const [liveTrace, setLiveTrace] = useState<TraceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleHistory = useMemo(() => history.slice(0, 8), [history]);
  const shownBefore = currentRun?.before ?? createTicketFixture();
  const shownAfter = currentRun?.after ?? shownBefore;

  useEffect(() => {
    saveRunHistory(history);
  }, [history]);

  useEffect(() => {
    if (!confirmOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.querySelector<HTMLButtonElement>(".confirm-modal .modal-close")?.focus();
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [confirmOpen]);

  useEffect(() => {
    if (PUBLIC_SCRIPTED_PREVIEW) return;
    let cancelled = false;
    fetch("/api/status", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Toolstorm runner is not available.");
        return (await response.json()) as LocalStatus;
      })
      .then((value) => {
        if (cancelled) return;
        setStatus(value);
        setModel(value.defaultModel || "enso-auto");
        if (value.hasHanzoKey || HANZO_ONLY_BUILD) setMode("hanzo");
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false, source: "unknown", hasHanzoKey: false, defaultModel: "enso-auto" });
      });
    return () => { cancelled = true; };
  }, []);

  async function startRun(nextFault = fault, nextMode = mode, confirmed = false) {
    if (busy) return;
    if (HANZO_ONLY_BUILD && (!status?.hasHanzoKey || nextMode !== "hanzo")) {
      setError("This hosted app requires Hanzo. Add HANZO_API_KEY to the Vercel project environment before running it.");
      return;
    }
    setFault(nextFault);
    setError("");
    setNotice("");
    setBusy(true);
    setConfirmOpen(false);
    setCurrentRun(null);
    setLiveTrace([]);

    try {
      let run: RunRecord;
      if (PUBLIC_SCRIPTED_PREVIEW) {
        run = runScriptedScenario(nextFault);
        for (const event of run.trace) {
          await new Promise((resolve) => window.setTimeout(resolve, 110));
          setLiveTrace((previous) => [...previous, event]);
        }
      } else {
        const runMode = HANZO_ONLY_BUILD ? "hanzo" : nextMode;
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            mode: runMode,
            fault: nextFault,
            model,
            maxOutputTokens: tokenLimit,
            confirmed,
          }),
        });
        if (!response.ok) {
          const data = await response.json() as { error?: unknown };
          throw new Error(errorMessage(data.error, "The run could not be started."));
        }
        if (!response.body) throw new Error("The run returned no trace stream.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let completed: RunRecord | null = null;
        let streamError = "";
        const consumeLine = (line: string) => {
          if (!line.trim()) return;
          const message = JSON.parse(line) as { type: string; event?: TraceEvent; run?: RunRecord; error?: unknown };
          if (message.type === "event" && message.event) setLiveTrace((previous) => [...previous, message.event!]);
          if (message.type === "complete" && message.run) completed = message.run;
          if (message.type === "error") streamError = errorMessage(message.error, "The run failed.");
        };

        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) consumeLine(line);
          if (done) break;
        }
        if (pending.trim()) consumeLine(pending);
        if (streamError) throw new Error(streamError);
        if (!completed) throw new Error("The run ended before its result was saved.");
        run = completed;
      }

      setCurrentRun(run);
      setLiveTrace([]);
      setHistory((previous) => [run, ...previous.filter((entry) => entry.id !== run.id)].slice(0, 16));
      setNotice(run.mode === "hanzo" && !PUBLIC_SCRIPTED_PREVIEW
        ? `${run.model} finished. ${run.trace.filter((event) => event.kind === "agent" && event.title.startsWith("Model turn")).length} model turns used.`
        : PUBLIC_SCRIPTED_PREVIEW
          ? "Scripted walkthrough complete. No server or LLM was used by this page."
          : status?.source === "vercel"
            ? "Vercel MCP simulation complete. No LLM was used."
            : "Scripted run complete. The local MCP server handled every tool call; no LLM was used.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function requestRun() {
    if (PUBLIC_SCRIPTED_PREVIEW || (!HANZO_ONLY_BUILD && mode === "scripted")) {
      void startRun(fault, mode, false);
      return;
    }
    setConfirmOpen(true);
  }

  function replayCurrent() {
    if (!currentRun) return;
    setFault(currentRun.fault);
    if ((HANZO_ONLY_BUILD || (mode === "hanzo" && !PUBLIC_SCRIPTED_PREVIEW))) {
      setMode("hanzo");
      setConfirmOpen(true);
    } else {
      void startRun(currentRun.fault, mode, false);
    }
  }

  function handleModeChange(next: string) {
    if (next !== "scripted" && next !== "hanzo") return;
    if (next === "hanzo" && !status?.hasHanzoKey) return;
    setMode(next);
    setError("");
    setNotice("");
  }

  function handleClearHistory() {
    clearRunHistory();
    setHistory([]);
    setNotice("Saved runs cleared from this browser.");
  }

  function handleReset() {
    setCurrentRun(null);
    setLiveTrace([]);
    setError("");
    setNotice("Scenario display reset. The next run starts from the original fixture.");
  }

  function selectHistory(run: RunRecord) {
    setCurrentRun(run);
    setFault(run.fault);
    setNotice(`${run.mode === "hanzo" ? run.model : "Scripted simulation"} · ${timeLabel(run.createdAt)}`);
  }

  const demoCaption = PUBLIC_SCRIPTED_PREVIEW
    ? "GitHub Pages scripted walkthrough · no MCP server or LLM calls"
    : HANZO_ONLY_BUILD
      ? status?.hasHanzoKey
      ? "Hanzo model · confirmation required before every run"
      : "Hanzo key required · no scripted fallback"
    : mode === "hanzo"
      ? "Hanzo calls require confirmation · key stays server-side"
      : "Local scripted MCP run · no LLM call";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">Skip to scenario controls</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Toolstorm home">
          <span className="brand-mark"><ToolstormMark /></span>
          <span>Toolstorm</span>
        </a>
        <div className="privacy-indicator" aria-live="polite">
          {!PUBLIC_SCRIPTED_PREVIEW && (HANZO_ONLY_BUILD || mode === "hanzo") ? <LockKeyhole aria-hidden="true" /> : <Laptop aria-hidden="true" />}
          <span>{demoCaption}</span>
          <span className={`privacy-dot ${!PUBLIC_SCRIPTED_PREVIEW && (HANZO_ONLY_BUILD || mode === "hanzo") ? "privacy-dot--amber" : ""}`} />
        </div>
      </header>

      <main id="top">
        <section className="page-intro" aria-labelledby="page-title">
          <div className="page-intro-copy">
            <h1 id="page-title">Test an agent under pressure</h1>
            <p>{TASK_TEXT}</p>
          </div>
          <div className="hero-actions">
            {currentRun ? (
              <span className={`result-chip result-chip--${currentRun.result}`}>
                {currentRun.result === "passed" ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                {currentRun.result === "passed" ? "Run passed" : outcomeText(currentRun.result)}
              </span>
            ) : <span className="quiet-label">Ready to run</span>}
            <button className="button button--primary" onClick={requestRun} type="button" disabled={busy || (!PUBLIC_SCRIPTED_PREVIEW && ((HANZO_ONLY_BUILD && !status?.hasHanzoKey) || (mode === "hanzo" && !status?.hasHanzoKey)))}>
              {busy ? <span className="button-spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}
              <span>{busy ? "Running…" : "Run scenario"}</span>
            </button>
          </div>
        </section>

        <section className="toolbar" aria-label="Run actions">
          <div className="toolbar-actions">
            <button className="button button--quiet" onClick={handleReset} type="button" title="Restore the ticket display to the original fixture" disabled={busy}>
              <RotateCcw aria-hidden="true" /><span>Reset</span>
            </button>
            <button className="button button--quiet" onClick={handleClearHistory} type="button" disabled={busy || history.length === 0}>
              <Trash2 aria-hidden="true" /><span>Clear history</span>
            </button>
            <button className="button button--quiet" onClick={() => currentRun && exportRun(currentRun)} type="button" disabled={!currentRun}>
              <ArrowDownToLine aria-hidden="true" /><span>Export JSON</span>
            </button>
            {currentRun && (
              <button className="button button--quiet replay-button" onClick={replayCurrent} type="button" disabled={busy}>
                <RotateCcw aria-hidden="true" /><span>Replay</span>
              </button>
            )}
          </div>
        </section>

        <div className="announcements" aria-live="polite">
          {error && <div className="banner banner--error"><CircleX aria-hidden="true" /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X aria-hidden="true" /></button></div>}
          {!error && notice && <div className="banner banner--notice"><CheckCircle2 aria-hidden="true" /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>}
          {HANZO_ONLY_BUILD && status?.source === "vercel" && !status.hasHanzoKey && (
            <div className="banner banner--error"><CircleX aria-hidden="true" /><span>Real Hanzo runs are paused because this Vercel deployment has no HANZO_API_KEY. No scripted trace will be played.</span></div>
          )}
          {status && !status.available && (
            <div className="banner banner--error"><CircleX aria-hidden="true" /><span>{status.source === "vercel" ? "The hosted runner is unavailable. Please retry shortly." : status.source === "local" ? <>Local API is unavailable. Start both services with <code>npm run dev</code>.</> : "Toolstorm runner did not respond. Refresh the page or start the local app with npm run dev."}</span></div>
          )}
        </div>

        <section id="workspace" className="workspace" aria-label="Toolstorm scenario workspace">
          <aside className="panel scenario-panel" aria-labelledby="scenario-heading">
            <div className="panel-title">
              <span className="panel-title-icon"><Braces aria-hidden="true" /></span>
              <h2 id="scenario-heading">Scenario</h2>
            </div>
            <div className="scenario-choice" aria-current="step">
              <FileText aria-hidden="true" />
              <span><strong>Ticket 104 triage</strong><small>Can't export reports · {shownBefore.requester}</small></span>
              <Check aria-hidden="true" className="scenario-check" />
            </div>

            <fieldset className="control-section fault-section">
              <legend><Sparkles aria-hidden="true" /> Inject a fault</legend>
              <p className="section-help">Choose the MCP behavior the agent must recover from.</p>
              <div className="fault-options">
                {FAULTS.map((item) => (
                  <label className={`fault-option ${fault === item.id ? "fault-option--selected" : ""}`} key={item.id}>
                    <input type="radio" name="fault" value={item.id} checked={fault === item.id} onChange={() => setFault(item.id)} disabled={busy} />
                    <span className="radio-indicator" aria-hidden="true"><span /></span>
                    <span className="fault-copy"><strong>{item.title}</strong><small>{item.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <section className="control-section model-section" aria-labelledby="model-heading">
              <h3 id="model-heading"><Bot aria-hidden="true" /> Model mode</h3>
              {PUBLIC_SCRIPTED_PREVIEW ? (
                <div className="mode-static"><CirclePlay aria-hidden="true" /> Hosted scripted walkthrough</div>
              ) : !HANZO_ONLY_BUILD ? (
                <label className="field field--mode">
                  <span className="sr-only">Model mode</span>
                  <span className="select-wrap">
                    <select value={mode} onChange={(event) => handleModeChange(event.target.value)} aria-label="Model mode" disabled={busy}>
                      <option value="scripted">Scripted MCP demo</option>
                      {status?.hasHanzoKey && <option value="hanzo">Hanzo model</option>}
                      {!status?.hasHanzoKey && <option value="hanzo" disabled>Hanzo model · key required</option>}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </label>
              ) : (
                <div className="mode-static"><LockKeyhole aria-hidden="true" /> Hanzo model · {status?.hasHanzoKey ? "server key ready" : "server key required"}</div>
              )}
              {mode === "hanzo" && !PUBLIC_SCRIPTED_PREVIEW ? (
                <div className="model-options">
                  <label className="field field--model">
                    <span className="field-label">Hanzo model ID</span>
                    <input value={model} onChange={(event) => setModel(event.target.value)} maxLength={120} placeholder="enso-auto" disabled={busy} />
                  </label>
                  <label className="field field--tokens">
                    <span className="field-label">Output cap</span>
                    <select value={tokenLimit} onChange={(event) => setTokenLimit(Number(event.target.value))} aria-label="Maximum output tokens per run" disabled={busy}>
                      {[512, 1024, 2048, 4096, 8192].map((value) => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}
                    </select>
                  </label>
                </div>
              ) : (
                <p className="mode-description">
                  {PUBLIC_SCRIPTED_PREVIEW
                    ? "This GitHub Pages page replays a scripted trace. No server or LLM is used."
                    : HANZO_ONLY_BUILD
                    ? status?.hasHanzoKey
                      ? "The Hanzo model calls the configured API from this server and uses the same local MCP tools. No request is sent until you confirm."
                      : "Real Hanzo runs are required in the hosted app. Add HANZO_API_KEY in Vercel to enable them."
                    : "Calls the local MCP tools without using model credits."}
                </p>
              )}
              {!PUBLIC_SCRIPTED_PREVIEW && status && !status.hasHanzoKey && <p className="key-hint">{status.source === "vercel" ? "Set HANZO_API_KEY in Vercel Project Settings → Environment Variables, then redeploy." : status.source === "local" ? "Set HANZO_API_KEY locally to enable confirmed Hanzo runs." : "Hanzo key status is unavailable because the server did not respond."}</p>}
            </section>

            <section className="control-section saved-section" aria-labelledby="saved-heading">
              <div className="saved-heading-row">
                <h3 id="saved-heading"><Clock3 aria-hidden="true" /> Saved runs</h3>
                <span className="saved-count">{history.length}</span>
              </div>
              {visibleHistory.length > 0 ? (
                <ul className="saved-list">
                  {visibleHistory.map((run) => (
                    <li key={run.id}>
                      <button type="button" className={`saved-run ${currentRun?.id === run.id ? "saved-run--selected" : ""}`} onClick={() => selectHistory(run)} disabled={busy}>
                        <span className={`saved-state saved-state--${run.result}`} aria-hidden="true" />
                        <span className="saved-run-copy">
                          <strong>{faultTitle(run.fault)}</strong>
                          <small>{timeLabel(run.createdAt)} · {run.mode === "hanzo" ? run.model : "Scripted"}</small>
                        </span>
                        <ChevronDown aria-hidden="true" className="saved-chevron" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="saved-empty">Completed runs stay in this browser only.</p>
              )}
            </section>
          </aside>

          <section className="panel trace-panel" aria-labelledby="trace-heading">
          <div className="trace-panel-heading">
              <div className="panel-title">
                <span className="panel-title-icon panel-title-icon--terminal">&gt;_</span>
                <div>
                  <h2 id="trace-heading">Agent trace</h2>
                <p>{busy ? `${liveTrace.length} live chronological events` : currentRun ? `${currentRun.trace.length} chronological events` : "Run the scenario to see each step."}</p>
                </div>
              </div>
            {(currentRun || busy) && <span className={`trace-mode ${(busy ? mode : currentRun?.mode) === "hanzo" ? "trace-mode--live" : ""}`}>{(busy ? mode : currentRun?.mode) === "hanzo" ? "HANZO RUN" : PUBLIC_SCRIPTED_PREVIEW ? "SCRIPTED WALKTHROUGH" : "SCRIPTED MCP"}</span>}
            </div>
            {status && !status.available && (
              <div className="trace-empty"><Activity aria-hidden="true" /><strong>{status.source === "vercel" ? "Hosted runner unavailable" : status.source === "local" ? "Local runner not connected" : "Runner did not respond"}</strong><span>{status.source === "vercel" ? "The serverless MCP simulation could not be reached." : status.source === "local" ? "Start the local app to connect to its MCP server." : "Refresh the page or start the local app with npm run dev."}</span></div>
            )}
            {busy ? (
              liveTrace.length ? (
                <div className="trace-list" role="list" aria-label="Live chronological run trace" aria-live="polite">
                  {liveTrace.map((event) => <TraceRow key={event.id} event={event} mode={mode} />)}
                </div>
              ) : (
                <div className="trace-empty"><Activity aria-hidden="true" /><strong>Starting the scenario…</strong><span>Trace events will appear here as tools respond.</span></div>
              )
            ) : currentRun ? (
              <div className="trace-list" role="list" aria-label="Chronological run trace">
                {currentRun.trace.map((event) => <TraceRow key={event.id} event={event} mode={currentRun.mode} />)}
              </div>
            ) : (
              <div className="trace-empty"><CirclePlay aria-hidden="true" /><strong>Ready when you are</strong><span>Select a fault and run the task to create a fresh local trace.</span></div>
            )}
          </section>

          <aside className="panel inspector-panel" aria-label="Ticket state and deterministic outcome">
            <section aria-labelledby="ticket-state-heading">
              <div className="panel-title inspector-title">
                <span className="panel-title-icon"><FileText aria-hidden="true" /></span>
                <h2 id="ticket-state-heading">Ticket state</h2>
                {currentRun && <span className={`result-mini result-mini--${currentRun.result}`}>{currentRun.result}</span>}
              </div>
              <TicketStateCard title="Before · original fixture" ticket={shownBefore} />
              <TicketStateCard title="After · run state" ticket={shownAfter} after />
              {currentRun && <div className="run-metadata"><span>Fault</span><strong>{faultTitle(currentRun.fault)}</strong></div>}
            </section>

            <section className="outcome-section" aria-labelledby="outcome-heading">
              <div className="panel-title outcome-title">
                <span className="panel-title-icon"><Shield aria-hidden="true" /></span>
                <h2 id="outcome-heading">Outcome</h2>
                <span className="deterministic-label">DETERMINISTIC</span>
              </div>
              {currentRun ? (
                <>
                  <ul className="checks-list">
                    {currentRun.checks.map((check) => <CheckRow key={check.id} check={check} />)}
                  </ul>
                  <div className={`outcome-summary outcome-summary--${currentRun.result}`}>
                    <Shield aria-hidden="true" />
                    <span>{outcomeText(currentRun.result)} · {faultTitle(currentRun.fault).toLowerCase()}</span>
                  </div>
                </>
              ) : (
                <div className="checks-empty">
                  <span>Checks appear after a run.</span>
                </div>
              )}
            </section>
          </aside>
        </section>
      </main>

      <footer className="app-footer">
        <span><LockKeyhole aria-hidden="true" /> {PUBLIC_SCRIPTED_PREVIEW ? "Scripted demo data and saved run history stay in this browser." : status?.source === "vercel" ? "Synthetic data stays in the Vercel simulation; run history stays in this browser." : "Demo data stays on this machine; saved run history stays in this browser."}</span>
        {!PUBLIC_SCRIPTED_PREVIEW && mode === "hanzo" && <span>Confirmed Hanzo runs send the task prompt and simulated tool results to Hanzo.</span>}
        <span>Experimental demo · not a security certification</span>
      </footer>

      {confirmOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOpen(false); }}>
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
            <button className="modal-close" type="button" aria-label="Close confirmation" onClick={() => setConfirmOpen(false)}><X aria-hidden="true" /></button>
            <span className="modal-icon"><LockKeyhole aria-hidden="true" /></span>
            <h2 id="confirm-title">Confirm a Hanzo model run</h2>
            <p id="confirm-description">Toolstorm will send the task prompt and simulated ticket/help-article tool results to Hanzo. This may use credits on your Hanzo account.</p>
            <div className="confirmation-facts">
              <span><CheckCircle2 aria-hidden="true" /> Only the fixed fictional ticket scenario is sent</span>
              <span><CheckCircle2 aria-hidden="true" /> Model: {model} · up to {tokenLimit.toLocaleString()} output tokens, 5 model turns, and 8 tool calls</span>
              <span><CheckCircle2 aria-hidden="true" /> Your API key stays in the server environment</span>
              <span><CheckCircle2 aria-hidden="true" /> No request is made until you confirm below</span>
            </div>
            <div className="modal-actions">
              <button className="button button--quiet" type="button" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="button button--primary" type="button" onClick={() => void startRun(fault, "hanzo", true)}>
                <LockKeyhole aria-hidden="true" /><span>Confirm &amp; run</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;

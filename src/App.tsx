import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpRight, Bot,
  CheckCircle2, ChevronDown, CircleHelp, CirclePlay, CircleX, Clock3,
  Database, Layers, Play, RotateCcw, Search, Shield, ShieldCheck, Terminal,
  Trash2, Wrench, X, Zap,
} from "lucide-react";
import { Landing } from "./Landing";
import { createTicketFixture, FAULTS, hasConfigurableDuration, parseFaultDuration, parseFaultTarget, TASK_TEXT } from "./domain/fixture";
import { DEFAULT_HANZO_MODEL, MAX_MODEL_TURNS, MAX_TOOL_CALLS, PUBLIC_MAX_OUTPUT_TOKENS } from "./domain/runLimits";
import { runScriptedScenario } from "./domain/scriptedRun";
import type { FaultDuration, FaultKind, FaultTarget, OutcomeCheck, RunMode, RunRecord, TraceEvent, TicketState } from "./domain/types";
import { clearRunHistory, exportRun, readRunHistory, saveRunHistory } from "./lib/history";

const PUBLIC_SCRIPTED_PREVIEW = import.meta.env.VITE_PUBLIC_SCRIPTED_PREVIEW === "true";
const HANZO_ONLY_BUILD = import.meta.env.PROD && !PUBLIC_SCRIPTED_PREVIEW;
const INITIAL_FAULT: FaultKind = "temporary_error";
const DURATIONS: Record<FaultDuration, string> = {
  once: "First attempt",
  twice: "First two attempts",
  persistent: "Every attempt",
};
const TICKET = createTicketFixture();
const SOURCE_URL = "https://github.com/Manateek1/toolstorm";

type AppView = "home" | "lab" | "history" | "tools" | "safety";
type ResultFilter = "all" | RunRecord["result"];
type TraceFilter = "all" | "tools" | "faults";

function currentView(): AppView {
  switch (window.location.hash) {
    case "#lab":
    case "#sample": return "lab";
    case "#history": return "history";
    case "#tools": return "tools";
    case "#safety": return "safety";
    default: return "home";
  }
}

interface LocalStatus {
  available: boolean;
  source: "local" | "vercel" | "unknown";
  hasHanzoKey: boolean;
  defaultModel: string;
  maxOutputTokens?: number;
}

const TOOL_CATALOG = [
  {
    name: "get_ticket",
    access: "Read",
    summary: "Fetch a synthetic ticket by its numeric ID.",
    input: '{ "ticket_id": 104 }',
    output: '{ "id": 104, "status": "open", "helpArticleId": "ha-4821" }',
    effect: "Read-only. Does not change the fixture.",
  },
  {
    name: "search_help_articles",
    access: "Read",
    summary: "Look up the one help article linked to ticket 104.",
    input: '{ "query": "ha-4821" }',
    output: '{ "articles": [{ "id": "ha-4821", "title": "Exporting large reports" }] }',
    effect: "Read-only. Faults are injected into this local result.",
  },
  {
    name: "add_internal_note",
    access: "Write",
    summary: "Add an internal-only note to the synthetic ticket.",
    input: '{ "ticket_id": 104, "note": "..." }',
    output: '{ "ticket_id": 104, "note_id": "note-1" }',
    effect: "Writes only to the fresh in-memory ticket fixture.",
  },
  {
    name: "change_ticket_status",
    access: "Write",
    summary: "Change the status on the synthetic ticket.",
    input: '{ "ticket_id": 104, "status": "pending" }',
    output: '{ "ticket_id": 104, "status": "pending" }',
    effect: "Available to expose unsafe actions. The task does not justify a status change.",
  },
] as const;

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

function dateTimeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function faultTitle(fault: FaultKind) {
  return FAULTS.find((item) => item.id === fault)?.title ?? "Connection error";
}

function scenarioTitle(run: RunRecord) {
  if (!hasConfigurableDuration(run.fault)) return faultTitle(run.fault);
  const target = run.faultTarget === "get_ticket" ? "Ticket" : "Article";
  return `${faultTitle(run.fault)} · ${target.toLowerCase()} · ${DURATIONS[parseFaultDuration(run.fault, run.faultDuration)].toLowerCase()}`;
}

function FaultIcon({ state }: { state: OutcomeCheck["state"] }) {
  if (state === "passed") return <CheckCircle2 aria-hidden="true" />;
  if (state === "failed") return <CircleX aria-hidden="true" />;
  return <CircleHelp aria-hidden="true" />;
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

function TraceRow({ event, mode }: { event: TraceEvent; mode: RunMode }) {
  const hasPayload = event.input !== undefined || event.output !== undefined;
  const row = (
    <>
      <span className="trace-sequence">{String(event.sequence).padStart(2, "0")}</span>
      <span className="trace-icon"><TraceIcon kind={event.kind} mode={mode} /></span>
      <span className="trace-body">
        <strong>{event.title}</strong>
        {event.detail && <span className="trace-detail">{event.detail}</span>}
      </span>
      <StatusLabel status={event.status} kind={event.kind} />
      {hasPayload && <ChevronDown className="trace-chevron" aria-hidden="true" />}
    </>
  );

  if (!hasPayload) return <div className="trace-row"><div className="trace-summary">{row}</div></div>;
  return (
    <details className="trace-row">
      <summary className="trace-summary">{row}</summary>
      <div className="trace-payload">
        {event.durationMs !== undefined && <span className="payload-time">{event.durationMs} ms</span>}
        {event.input !== undefined && <div className="payload-block"><span>Input</span><pre>{stringify(event.input)}</pre></div>}
        {event.output !== undefined && <div className="payload-block"><span>Result</span><pre>{stringify(event.output)}</pre></div>}
      </div>
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
      <span className="check-copy"><strong>{check.label}</strong><span>{check.detail}</span></span>
    </li>
  );
}

function ToolCatalogTable() {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th scope="col">Tool</th><th scope="col">Access</th><th scope="col">Purpose</th><th scope="col">Inspect</th></tr></thead>
        <tbody>
          {TOOL_CATALOG.map((tool) => (
            <tr key={tool.name}>
              <th scope="row"><code className="tool-name">{tool.name}</code></th>
              <td><span className={`access-pill access-pill--${tool.access.toLowerCase()}`}>{tool.access}</span></td>
              <td><span className="tool-summary">{tool.summary}</span></td>
              <td>
                  <details className="schema-disclosure">
                    <summary>Schema &amp; example</summary>
                    <div className="schema-details">
                      <p>{tool.effect}</p>
                      <span>Example input</span><pre>{tool.input}</pre>
                      <span>Example result</span><pre>{tool.output}</pre>
                    </div>
                  </details>
                </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultTag({ result }: { result: RunRecord["result"] }) {
  return <span className={`result-tag result-tag--${result}`}>{result}</span>;
}

function App() {
  const [activeView, setActiveView] = useState(currentView);
  const [fault, setFault] = useState<FaultKind>(INITIAL_FAULT);
  const [duration, setDuration] = useState<FaultDuration>("once");
  const [target, setTarget] = useState<FaultTarget>("search_help_articles");
  const [mode, setMode] = useState<RunMode>(HANZO_ONLY_BUILD ? "hanzo" : "scripted");
  const [model, setModel] = useState(DEFAULT_HANZO_MODEL);
  const [tokenLimit, setTokenLimit] = useState(HANZO_ONLY_BUILD ? PUBLIC_MAX_OUTPUT_TOKENS : 2048);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [history, setHistory] = useState<RunRecord[]>(readRunHistory);
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null);
  const [liveTrace, setLiveTrace] = useState<TraceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [inspectView, setInspectView] = useState<"trace" | "ticket">("trace");
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [error, setError] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyFilter, setHistoryFilter] = useState<ResultFilter>("all");
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const previewRun = useMemo(() => runScriptedScenario(fault, duration, target), [fault, duration, target]);
  const showingPreview = !busy && !currentRun && previewVisible;
  const displayedRun = currentRun ?? (showingPreview ? previewRun : null);
  const trace = busy ? liveTrace : displayedRun?.trace ?? [];
  const traceMode = busy ? mode : displayedRun?.mode;
  const filteredTrace = trace.filter((event) => {
    if (traceFilter === "tools") return event.kind === "tool";
    if (traceFilter === "faults") return event.kind === "fault" || event.kind === "retry" || event.status === "blocked" || event.status === "error" || event.status === "warning";
    return true;
  });

  const filteredHistory = useMemo(() => history.filter((run) => {
    const query = historySearch.trim().toLowerCase();
    const matchesQuery = !query || [scenarioTitle(run), run.model, run.result, dateTimeLabel(run.createdAt)].some((value) => value.toLowerCase().includes(query));
    return matchesQuery && (historyFilter === "all" || run.result === historyFilter);
  }), [history, historySearch, historyFilter]);
  const compareRuns = useMemo(() => compareIds.map((id) => history.find((run) => run.id === id)).filter((run): run is RunRecord => Boolean(run)), [compareIds, history]);
  useEffect(() => { saveRunHistory(history); }, [history]);

  useEffect(() => {
    function navigate() {
      setActiveView(currentView());
      if (window.location.hash === "#sample") {
        setCurrentRun(null);
        setInspectView("trace");
        setTraceFilter("all");
        setPreviewVisible(true);
      }
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);

  useEffect(() => {
    if (activeView === "lab" && window.location.hash === "#sample") {
      document.getElementById("trace-heading")?.focus();
    }
  }, [activeView]);

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
        setModel(value.defaultModel || DEFAULT_HANZO_MODEL);
        if (HANZO_ONLY_BUILD && value.maxOutputTokens) setTokenLimit(value.maxOutputTokens);
        if (value.hasHanzoKey || HANZO_ONLY_BUILD) setMode("hanzo");
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false, source: "unknown", hasHanzoKey: false, defaultModel: DEFAULT_HANZO_MODEL });
      });
    return () => { cancelled = true; };
  }, []);

  async function startRun() {
    if (busy || (!PUBLIC_SCRIPTED_PREVIEW && (!status?.available || (mode === "hanzo" && !status.hasHanzoKey)))) return;
    setError("");
    setBusy(true);
    setCurrentRun(null);
    setPreviewVisible(false);
    setInspectView("trace");
    setTraceFilter("all");
    setLiveTrace([]);

    try {
      let run: RunRecord;
      if (PUBLIC_SCRIPTED_PREVIEW) {
        run = runScriptedScenario(fault, duration, target);
        for (const event of run.trace) {
          await new Promise((resolve) => window.setTimeout(resolve, 110));
          setLiveTrace((previous) => [...previous, event]);
        }
      } else {
        const runMode = HANZO_ONLY_BUILD ? "hanzo" : mode;
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            mode: runMode,
            fault,
            faultDuration: duration,
            faultTarget: target,
            confirmed: runMode === "hanzo",
            ...(!HANZO_ONLY_BUILD && runMode === "hanzo" ? { model, maxOutputTokens: tokenLimit } : {}),
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function configurationChanged() {
    setCurrentRun(null);
    setPreviewVisible(true);
    setError("");
  }

  function showPreview() {
    configurationChanged();
    setInspectView("trace");
    setTraceFilter("all");
    document.getElementById("trace-heading")?.focus();
  }

  function handleClearHistory() {
    clearRunHistory();
    setHistory([]);
    setCompareIds([]);
    setCurrentRun(null);
  }

  function selectHistory(run: RunRecord) {
    if (busy) return;
    setCurrentRun(run);
    setFault(run.fault);
    setDuration(parseFaultDuration(run.fault, run.faultDuration));
    setTarget(parseFaultTarget(run.fault, run.faultTarget));
    setInspectView("trace");
    setTraceFilter("all");
    setError("");
    window.location.hash = "#lab";
  }

  function toggleCompare(id: string) {
    setCompareIds((previous) => previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous.slice(-1), id]);
  }

  const navigation = [
    { id: "lab", label: "Lab" },
    { id: "history", label: "Run history" },
    { id: "tools", label: "MCP tools" },
  ] as const;
  const liveUnavailable = !PUBLIC_SCRIPTED_PREVIEW && (!status?.available || (mode === "hanzo" && !status.hasHanzoKey));
  const runLabel = PUBLIC_SCRIPTED_PREVIEW ? "Play scripted run" : mode === "hanzo" ? "Run live" : "Run scripted MCP";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("main-content")?.focus();
      }}>Skip to main content</a>
      <header className="site-header">
        <div className="header-inner page-width">
          <a className="brand" href="#" aria-label="Toolstorm home"><Zap fill="currentColor" aria-hidden="true" />Toolstorm</a>
          {activeView !== "home" && (
            <nav className="site-nav" aria-label="Main navigation">
              {navigation.map(({ id, label }) => <a key={id} href={`#${id}`} aria-current={activeView === id ? "page" : undefined}>{label}</a>)}
            </nav>
          )}
          <div className="header-actions">
            <a className="source-link" href={SOURCE_URL} target="_blank" rel="noreferrer">View source <ArrowUpRight aria-hidden="true" /></a>
            {activeView === "home" && <a className="button button--primary header-cta" href="#lab">Open lab <ArrowRight aria-hidden="true" /></a>}
          </div>
        </div>
      </header>

      {activeView === "home" ? <Landing /> : (
        <main id="main-content" className="page-width page-content" tabIndex={-1}>
          {activeView === "lab" && (
            <section className="view-stack" aria-labelledby="page-title">
              <header className="page-heading"><div><h1 id="page-title">Scenario lab</h1><p>Test a support-ticket agent against simulated MCP failures and inspect how it responds.</p></div></header>

              <div className="workspace-grid">
                <aside className="panel scenario-panel" aria-labelledby="scenario-heading">
                  <div className="panel-heading"><h2 id="scenario-heading">Scenario</h2><span className="mono-label">Ticket #104</span></div>
                  <p className="task-summary">{TASK_TEXT}</p>

                  <fieldset className="scenario-controls" disabled={busy}>
                    <legend className="sr-only">Fault settings</legend>
                    <label className="field"><span>Fault preset</span><select value={fault} onChange={(event) => {
                      const next = event.target.value as FaultKind;
                      setFault(next);
                      setDuration(parseFaultDuration(next, duration));
                      setTarget(parseFaultTarget(next, target));
                      configurationChanged();
                    }}>{FAULTS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                    <p className="field-help">{FAULTS.find((item) => item.id === fault)?.description}</p>
                    {hasConfigurableDuration(fault) && (
                      <>
                        {fault === "temporary_error" && <label className="field"><span>Fault target</span><select value={target} onChange={(event) => { setTarget(event.target.value as FaultTarget); configurationChanged(); }}><option value="search_help_articles">Article lookup</option><option value="get_ticket">Ticket read</option></select></label>}
                        <label className="field"><span>Fault duration</span><select value={duration} onChange={(event) => { setDuration(event.target.value as FaultDuration); configurationChanged(); }}>{Object.entries(DURATIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                      </>
                    )}
                    {!HANZO_ONLY_BUILD && !PUBLIC_SCRIPTED_PREVIEW && (
                      <label className="field"><span>Execution engine</span><select value={mode} onChange={(event) => setMode(event.target.value as RunMode)}><option value="scripted">Scripted MCP</option><option value="hanzo" disabled={!status?.hasHanzoKey}>Hanzo {status?.hasHanzoKey ? "(live)" : "(key required)"}</option></select></label>
                    )}
                    {!HANZO_ONLY_BUILD && !PUBLIC_SCRIPTED_PREVIEW && mode === "hanzo" && (
                      <>
                        <label className="field"><span>Hanzo model ID</span><input value={model} onChange={(event) => setModel(event.target.value)} maxLength={120} placeholder={DEFAULT_HANZO_MODEL} /></label>
                        <label className="field"><span>Output cap</span><select value={tokenLimit} onChange={(event) => setTokenLimit(Number(event.target.value))}>{[512, 1024, 2048, 4096, 8192].map((value) => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}</select></label>
                      </>
                    )}
                  </fieldset>
                  <div className="scenario-actions">
                    {HANZO_ONLY_BUILD && <div className="engine-status"><span className={status?.hasHanzoKey ? "engine-dot engine-dot--online" : "engine-dot"} /><strong>{status?.hasHanzoKey ? model : status ? "Live runner unavailable" : "Checking live runner"}</strong><span>Hanzo</span></div>}
                    <button className="button button--primary" type="button" onClick={() => void startRun()} disabled={busy || liveUnavailable} aria-describedby={mode === "hanzo" ? "run-disclosure" : undefined}>
                      {busy ? <span className="button-spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}{busy ? "Running…" : runLabel}
                    </button>
                    <button className="button button--quiet" type="button" onClick={showPreview} disabled={busy}><Terminal aria-hidden="true" />Preview result</button>
                    {mode === "hanzo" && <p id="run-disclosure" className="field-help">Live runs send fictional data to Hanzo using Toolstorm’s credits.</p>}
                  </div>
                </aside>

                <section className="panel trace-panel" aria-labelledby="trace-heading">
                  <div className="panel-heading trace-panel-heading">
                    <h2 id="trace-heading" tabIndex={-1}><Terminal aria-hidden="true" />Execution trace</h2>
                    <span className={traceMode === "hanzo" ? "trace-mode trace-mode--live" : "trace-mode"} role="status">
                      {showingPreview ? "Scripted preview" : !traceMode ? "Ready" : traceMode === "hanzo" ? busy ? "Hanzo running" : "Hanzo result" : busy ? "Script running" : PUBLIC_SCRIPTED_PREVIEW ? "Scripted playback" : "Scripted MCP"}
                    </span>
                  </div>
                  <div className="trace-toolbar">
                    <div className="segmented" aria-label="Run inspection">
                      <button type="button" aria-pressed={inspectView === "trace"} onClick={() => setInspectView("trace")}>Events <span>{trace.length}</span></button>
                      <button type="button" aria-pressed={inspectView === "ticket"} onClick={() => setInspectView("ticket")}>Ticket state</button>
                    </div>
                    {inspectView === "trace" && <label className="trace-filter"><span className="sr-only">Show events</span><select value={traceFilter} onChange={(event) => setTraceFilter(event.target.value as TraceFilter)}><option value="all">All events</option><option value="tools">Tool calls</option><option value="faults">Faults &amp; retries</option></select></label>}
                  </div>
                  {error && <div className="banner banner--error" role="alert"><CircleX aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X aria-hidden="true" /></button></div>}
                  {inspectView === "ticket" ? (
                    <div className="snapshot-grid">
                      <TicketStateCard title="Before" ticket={displayedRun?.before ?? TICKET} />
                      {displayedRun ? <TicketStateCard title="After" ticket={displayedRun.after} after /> : <p className="trace-empty">The final ticket state appears after the run.</p>}
                    </div>
                  ) : filteredTrace.length > 0 ? (
                    <div className="trace-list" aria-label="Chronological trace">{filteredTrace.map((event) => <TraceRow key={event.id} event={event} mode={traceMode ?? "scripted"} />)}</div>
                  ) : (
                    <p className="trace-empty">{busy && !trace.length ? "Waiting for trace events…" : trace.length ? "No events match this filter." : "Preview the configured scenario or start a new run."}</p>
                  )}
                  {showingPreview && <p className="trace-caption">Example of scripted behavior for these settings. Live results may differ.</p>}
                  {currentRun && <p className="trace-caption">{scenarioTitle(currentRun)}{currentRun.mode === "hanzo" ? ` · ${currentRun.model}` : ""}</p>}
                </section>
              </div>

              <section className="panel outcome-section" aria-labelledby="outcome-heading">
                <div className="panel-heading"><h2 id="outcome-heading"><ShieldCheck aria-hidden="true" />Outcome checks</h2>{displayedRun && <ResultTag result={displayedRun.result} />}</div>
                {displayedRun ? <ul className="checks-list">{displayedRun.checks.map((check) => <CheckRow key={check.id} check={check} />)}</ul> : <p className="checks-empty">Checks are evaluated when the run finishes.</p>}
              </section>
            </section>
          )}

          {activeView === "history" && (
            <section className="view-stack" aria-labelledby="page-title">
              <header className="page-heading"><div><h1 id="page-title">Run history</h1><p>Review and compare the recent runs saved in this browser. Nothing here is uploaded.</p></div><button className="button button--quiet" type="button" onClick={handleClearHistory} disabled={!history.length || busy}><Trash2 aria-hidden="true" /><span>Clear history</span></button></header>
              <div className="history-toolbar">
                <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Search saved runs</span><input type="search" placeholder="Search fault, model, or date" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} /></label>
                <label className="filter-field"><span>Result</span><select value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value as ResultFilter)}><option value="all">All results</option><option value="passed">Passed</option><option value="partial">Needs review</option><option value="failed">Failed</option></select></label>
                <span className="history-count">{filteredHistory.length} shown · {history.length} saved</span>
              </div>
              <section className="panel history-panel" aria-label="Saved run records">
                {filteredHistory.length ? <div className="table-scroll"><table className="data-table history-table"><thead><tr><th scope="col">Compare</th><th scope="col">Fault</th><th scope="col">Mode</th><th scope="col">Date</th><th scope="col">Trace events</th><th scope="col">Result</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{filteredHistory.map((run) => <tr key={run.id}><td><input type="checkbox" aria-label={`Compare ${scenarioTitle(run)} run from ${dateTimeLabel(run.createdAt)}`} checked={compareIds.includes(run.id)} onChange={() => toggleCompare(run.id)} disabled={!compareIds.includes(run.id) && compareIds.length >= 2} /></td><th scope="row"><button type="button" className="table-link" onClick={() => selectHistory(run)} disabled={busy}>{scenarioTitle(run)}</button><small className="table-subtext">{run.id.slice(0, 8)}</small></th><td>{run.mode === "hanzo" ? <span className="mode-tag"><Bot aria-hidden="true" />{run.model}</span> : <span className="mode-tag">{PUBLIC_SCRIPTED_PREVIEW ? "Scripted playback" : "Scripted MCP"}</span>}</td><td>{dateTimeLabel(run.createdAt)}</td><td>{run.trace.length}</td><td><ResultTag result={run.result} /></td><td className="table-actions"><button className="icon-button" type="button" onClick={() => exportRun(run)} aria-label={`Export ${scenarioTitle(run)} run JSON`} title="Export JSON"><ArrowDownToLine aria-hidden="true" /></button><button className="text-button text-button--accent" type="button" onClick={() => selectHistory(run)} disabled={busy}>Open</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Clock3 aria-hidden="true" /></span><h2>{history.length ? "No runs match those filters" : "No runs saved yet"}</h2><p>{history.length ? "Adjust your search or result filter." : "Complete a scenario to build a local, inspectable run history."}</p>{history.length > 0 && <button className="text-button text-button--accent" type="button" onClick={() => { setHistorySearch(""); setHistoryFilter("all"); }}>Clear filters</button>}</div>}
              </section>
              <section className="panel compare-panel" aria-labelledby="compare-heading">
                <div className="panel-heading panel-heading--compact"><span className="panel-icon"><Activity aria-hidden="true" /></span><div><h2 id="compare-heading">Compare runs</h2><p>Select up to two saved runs in the table to compare checks and tool activity.</p></div><span className="compare-count">{compareRuns.length}/2 selected</span></div>
                {compareRuns.length === 2 ? <div className="compare-grid">{compareRuns.map((run) => <article className="compare-card" key={run.id}><div className="compare-title"><div><strong>{scenarioTitle(run)}</strong><small>{dateTimeLabel(run.createdAt)} · {run.mode === "hanzo" ? run.model : PUBLIC_SCRIPTED_PREVIEW ? "Scripted playback" : "Scripted MCP"}</small></div><ResultTag result={run.result} /></div><div className="compare-stats"><span><strong>{run.trace.filter((event) => event.kind === "tool").length}</strong>MCP calls</span><span><strong>{run.trace.filter((event) => event.kind === "retry").length}</strong>Retries</span><span><strong>{run.trace.length}</strong>Events</span></div><ul className="compare-checks">{run.checks.map((check) => <li key={check.id}><span className={`check-dot check-dot--${check.state}`} />{check.label}</li>)}</ul><button className="text-button text-button--accent" type="button" onClick={() => selectHistory(run)} disabled={busy}>Open full trace <ArrowRight aria-hidden="true" /></button></article>)}</div> : <div className="compare-empty">Choose two saved runs above. Their deterministic checks, retries, and MCP call counts will appear here.</div>}
              </section>
            </section>
          )}

          {activeView === "tools" && (
            <section className="view-stack" aria-labelledby="page-title">
              <header className="page-heading"><div><h1 id="page-title">MCP tools</h1><p>Inspect the exact synthetic tools exposed to the agent in this scenario.</p></div><span className="plain-count">{TOOL_CATALOG.length} tools · local fixture only</span></header>
              <section className="panel tool-catalog-panel"><div className="panel-heading"><span className="panel-icon"><Layers aria-hidden="true" /></span><div><h2>Ticket system tool surface</h2><p>Each run starts a fresh fixture. No real ticket platform is connected.</p></div></div><ToolCatalogTable /></section>
              <section className="tool-boundary-grid"><article className="panel boundary-card"><span className="panel-icon"><Database aria-hidden="true" /></span><h2>Read tools</h2><p><code>get_ticket</code> and <code>search_help_articles</code> return only the source-controlled ticket and help article.</p></article><article className="panel boundary-card"><span className="panel-icon panel-icon--write"><Wrench aria-hidden="true" /></span><h2>Write tools</h2><p><code>add_internal_note</code> changes the local fixture. <code>change_ticket_status</code> exists to make an unjustified state change visible to the outcome checks.</p></article><article className="panel boundary-card"><span className="panel-icon"><Shield aria-hidden="true" /></span><h2>Trust boundary</h2><p>Ticket and article contents are data. The agent is told to ignore instructions found inside tool results.</p></article></section>
            </section>
          )}

          {activeView === "safety" && (
            <section className="view-stack" aria-labelledby="page-title">
              <header className="page-heading"><div><h1 id="page-title">Run details</h1><p>How Toolstorm handles data and evaluates each run.</p></div></header>
              <section className="panel details-panel" aria-label="Data and run boundaries">
                <dl>
                  <div><dt>Fictional data</dt><dd>Each run starts with a fresh synthetic support ticket and a linked help article. The four MCP tools only work with that fixture.</dd></div>
                  <div><dt>Hanzo requests</dt><dd>Live runs send the fixed task and simulated tool results to Hanzo. Toolstorm uses its server-side key. Scripted previews run in the browser.</dd></div>
                  <div><dt>Run budget</dt><dd>Hosted runs allow up to {MAX_MODEL_TURNS} model turns, {MAX_TOOL_CALLS} tool calls, {PUBLIC_MAX_OUTPUT_TOKENS.toLocaleString()} output tokens, and 45 seconds.</dd></div>
                  <div><dt>Run history</dt><dd>Completed runs are stored in this browser. You can compare runs, export their traces, or clear the saved history.</dd></div>
                  <div><dt>Outcome checks</dt><dd>The score reflects the simulated ticket, article, and trace. The checks cover this scenario’s note, status, and fault recovery.</dd></div>
                </dl>
              </section>
            </section>
          )}
        </main>
      )}

      <footer className="app-footer page-width">
        <span><Zap fill="currentColor" aria-hidden="true" />Toolstorm</span>
        <div><a href="#safety">Run details</a><a href={SOURCE_URL} target="_blank" rel="noreferrer">GitHub <ArrowUpRight aria-hidden="true" /></a></div>
      </footer>
    </div>
  );
}

export default App;

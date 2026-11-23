import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CirclePlay,
  CircleX,
  Clock3,
  Database,
  FileText,
  Layers,
  LockKeyhole,
  Play,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
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

type AppView = "lab" | "history" | "tools" | "safety";
type ResultFilter = "all" | RunRecord["result"];

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

function ToolstormMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="m16 3.5 11 6.3v12.4L16 28.5 5 22.2V9.8l11-6.3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m5.5 10.1 10.5 6.1 10.5-6.1M16 16.2v11.7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m10.5 7 10.8 6.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".72" />
    </svg>
  );
}

function dateTimeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function faultTitle(fault: FaultKind) {
  return FAULTS.find((item) => item.id === fault)?.title ?? "Temporary error";
}

function outcomeText(result: RunRecord["result"]) {
  if (result === "passed") return "All checks passed";
  if (result === "partial") return "Some checks need attention";
  return "Run did not complete safely";
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
          {event.input !== undefined && <div className="payload-block"><span>Input</span><pre>{stringify(event.input)}</pre></div>}
          {event.output !== undefined && <div className="payload-block"><span>Result</span><pre>{stringify(event.output)}</pre></div>}
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
      <span className="check-copy"><strong>{check.label}</strong><span>{check.detail}</span></span>
    </li>
  );
}

function ToolCatalogTable({ compact = false }: { compact?: boolean }) {
  return (
    <div className="table-scroll">
      <table className={`data-table ${compact ? "data-table--compact" : ""}`}>
        <thead><tr><th scope="col">Tool</th><th scope="col">Access</th><th scope="col">Purpose</th>{!compact && <th scope="col">Inspect</th>}</tr></thead>
        <tbody>
          {TOOL_CATALOG.map((tool) => (
            <tr key={tool.name}>
              <th scope="row"><code className="tool-name">{tool.name}</code></th>
              <td><span className={`access-pill access-pill--${tool.access.toLowerCase()}`}>{tool.access}</span></td>
              <td><span className="tool-summary">{tool.summary}</span></td>
              {!compact && (
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
              )}
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
  const [activeView, setActiveView] = useState<AppView>("lab");
  const [fault, setFault] = useState<FaultKind>(INITIAL_FAULT);
  const [mode, setMode] = useState<RunMode>(HANZO_ONLY_BUILD ? "hanzo" : "scripted");
  const [model, setModel] = useState("enso-auto");
  const [tokenLimit, setTokenLimit] = useState(HANZO_ONLY_BUILD ? 512 : 2048);
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
  const [historySearch, setHistorySearch] = useState("");
  const [historyFilter, setHistoryFilter] = useState<ResultFilter>("all");
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const filteredHistory = useMemo(() => history.filter((run) => {
    const query = historySearch.trim().toLowerCase();
    const matchesQuery = !query || [faultTitle(run.fault), run.model, run.result, dateTimeLabel(run.createdAt)].some((value) => value.toLowerCase().includes(query));
    return matchesQuery && (historyFilter === "all" || run.result === historyFilter);
  }), [history, historySearch, historyFilter]);
  const compareRuns = useMemo(() => compareIds.map((id) => history.find((run) => run.id === id)).filter((run): run is RunRecord => Boolean(run)), [compareIds, history]);
  const metrics = useMemo(() => ({
    runs: history.length,
    passed: history.filter((run) => run.result === "passed").length,
    toolCalls: history.reduce((total, run) => total + run.trace.filter((event) => event.kind === "tool").length, 0),
    retries: history.reduce((total, run) => total + run.trace.filter((event) => event.kind === "retry").length, 0),
  }), [history]);

  const shownBefore = currentRun?.before ?? createTicketFixture();
  const shownAfter = currentRun?.after ?? shownBefore;
  const pageName: Record<AppView, string> = { lab: "Lab", history: "Run history", tools: "MCP tools", safety: "Safety" };

  useEffect(() => { saveRunHistory(history); }, [history]);

  useEffect(() => {
    if (!confirmOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setConfirmOpen(false); };
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
        if (HANZO_ONLY_BUILD && value.maxOutputTokens) setTokenLimit(value.maxOutputTokens);
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
            confirmed,
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
    if (HANZO_ONLY_BUILD || (mode === "hanzo" && !PUBLIC_SCRIPTED_PREVIEW)) {
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
    setCompareIds([]);
    setCurrentRun(null);
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
    setActiveView("lab");
    setNotice(`${run.mode === "hanzo" ? run.model : "Scripted simulation"} · ${timeLabel(run.createdAt)}`);
  }

  function toggleCompare(id: string) {
    setCompareIds((previous) => previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous.slice(-1), id]);
  }

  const publicRunUnavailable = !PUBLIC_SCRIPTED_PREVIEW && HANZO_ONLY_BUILD && status?.available === true && !status.hasHanzoKey;
  const publicRunDisabled = !PUBLIC_SCRIPTED_PREVIEW && HANZO_ONLY_BUILD && !status?.hasHanzoKey;
  const navigation = [
    { id: "lab" as const, label: "Lab", icon: <Activity aria-hidden="true" /> },
    { id: "history" as const, label: "Run history", icon: <Clock3 aria-hidden="true" />, count: history.length },
    { id: "tools" as const, label: "MCP tools", icon: <Layers aria-hidden="true" /> },
    { id: "safety" as const, label: "Safety", icon: <ShieldCheck aria-hidden="true" /> },
  ];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar">
        <a className="brand" href="#main-content" aria-label="Toolstorm home" onClick={() => setActiveView("lab")}>
          <span className="brand-mark"><ToolstormMark /></span><span>Toolstorm</span>
        </a>
        <div className="sidebar-caption">AGENT RELIABILITY LAB</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button key={item.id} className={`side-nav-item ${activeView === item.id ? "side-nav-item--active" : ""}`} type="button" onClick={() => { setActiveView(item.id); setError(""); setNotice(""); }} aria-current={activeView === item.id ? "page" : undefined}>
              {item.icon}<span>{item.label}</span>{item.count !== undefined && <small>{item.count}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-data-note"><Database aria-hidden="true" /><span>Fictional ticket data<br />History stays in this browser</span></div>
          <a className="sidebar-source" href="https://github.com/Manateek1/toolstorm" target="_blank" rel="noreferrer">View source <ArrowUpRight aria-hidden="true" /></a>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb"><span>Toolstorm</span><ChevronRight aria-hidden="true" /><strong>{pageName[activeView]}</strong></div>
          <a className="source-link" href="https://github.com/Manateek1/toolstorm" target="_blank" rel="noreferrer"><span>Source</span><ArrowUpRight aria-hidden="true" /></a>
        </header>

        <main id="main-content" className="page-content">
          <div className="announcements" aria-live="polite">
            {error && <div className="banner banner--error"><CircleX aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X aria-hidden="true" /></button></div>}
            {!error && notice && <div className="banner banner--notice"><CheckCircle2 aria-hidden="true" /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>}
            {publicRunUnavailable && <div className="banner banner--error"><CircleX aria-hidden="true" /><span>Real Hanzo runs are paused because this deployment has no HANZO_API_KEY. No scripted trace will be substituted.</span></div>}
            {status && !status.available && <div className="banner banner--error"><Activity aria-hidden="true" /><span>{status.source === "local" ? <>Local API is unavailable. Start both services with <code>npm run dev</code>.</> : "The run service is unavailable. Refresh the page and try again."}</span></div>}
          </div>

          {activeView === "lab" && (
            <section className="view-stack" aria-labelledby="page-title">
              <header className="page-heading">
                <div><h1 id="page-title">Agent reliability lab</h1><p>Watch an agent use synthetic MCP tools, recover from a fault, and pass deterministic checks.</p></div>
                {currentRun && <ResultTag result={currentRun.result} />}
              </header>

              <section className="metric-strip" aria-label="Saved run metrics">
                <div className="metric"><span>Saved runs</span><strong>{metrics.runs}</strong><small>On this browser</small></div>
                <div className="metric"><span>Passed</span><strong className="metric-green">{metrics.passed}</strong><small>Of saved runs</small></div>
                <div className="metric"><span>MCP calls</span><strong>{metrics.toolCalls}</strong><small>Across saved traces</small></div>
                <div className="metric"><span>Retries</span><strong className="metric-amber">{metrics.retries}</strong><small>Across saved traces</small></div>
              </section>

              <section className="workflow-rail" aria-label="Task workflow">
                <div className="workflow-step"><span className="step-number">01</span><div><strong>Read ticket</strong><small>Fetch fixture 104</small></div></div>
                <ArrowRight className="workflow-arrow" aria-hidden="true" />
                <div className="workflow-step"><span className="step-number">02</span><div><strong>Inspect article</strong><small>Read ha-4821</small></div></div>
                <ArrowRight className="workflow-arrow" aria-hidden="true" />
                <div className="workflow-step"><span className="step-number">03</span><div><strong>Add triage note</strong><small>Internal only</small></div></div>
                <ArrowRight className="workflow-arrow" aria-hidden="true" />
                <div className="workflow-step"><span className="step-number">04</span><div><strong>Score run</strong><small>Check final state</small></div></div>
              </section>

              <section className="workspace-grid" aria-label="Scenario workspace">
                <aside className="panel scenario-panel" aria-labelledby="scenario-heading">
                  <div className="panel-heading"><span className="panel-icon"><Braces aria-hidden="true" /></span><div><h2 id="scenario-heading">Scenario configuration</h2><p>Ticket 104 triage · fictional support system</p></div></div>
                  <div className="task-summary"><span className="task-label">FIXED TASK</span><p>{TASK_TEXT}</p><div className="task-metadata"><span><FileText aria-hidden="true" /> Ticket #104</span><span><Database aria-hidden="true" /> Synthetic fixture</span></div></div>
                  {!PUBLIC_SCRIPTED_PREVIEW && (HANZO_ONLY_BUILD || mode === "hanzo") && <p className="section-help">A host safeguard blocks notes until the ticket and complete article are read, and blocks notes without a concrete troubleshooting action. Blocked attempts appear in the trace.</p>}

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

                  <section className="control-section model-section" aria-labelledby="execution-heading">
                    <h3 id="execution-heading"><Bot aria-hidden="true" /> Model &amp; run limits</h3>
                    {!HANZO_ONLY_BUILD && !PUBLIC_SCRIPTED_PREVIEW ? (
                      <label className="field field--mode"><span className="sr-only">Execution mode</span><span className="select-wrap"><select value={mode} onChange={(event) => handleModeChange(event.target.value)} aria-label="Execution mode" disabled={busy}><option value="scripted">Scripted MCP · no model call</option>{status?.hasHanzoKey ? <option value="hanzo">Hanzo model · uses credits</option> : <option value="hanzo" disabled>Hanzo model · key required</option>}</select><ChevronDown aria-hidden="true" /></span></label>
                    ) : (
                      <div className="mode-static"><LockKeyhole aria-hidden="true" /><span>{PUBLIC_SCRIPTED_PREVIEW ? "Scripted walkthrough" : "Hanzo model · server key"}</span></div>
                    )}
                    {HANZO_ONLY_BUILD ? (
                      <div className="public-run-config"><div><span>Server model</span><strong>{model}</strong></div><div><span>Output ceiling</span><strong>{tokenLimit} tokens</strong></div></div>
                    ) : mode === "hanzo" && !PUBLIC_SCRIPTED_PREVIEW ? (
                      <div className="model-options">
                        <label className="field field--model"><span className="field-label">Hanzo model ID</span><input value={model} onChange={(event) => setModel(event.target.value)} maxLength={120} placeholder="enso-auto" disabled={busy} /></label>
                        <label className="field field--tokens"><span className="field-label">Output cap</span><select value={tokenLimit} onChange={(event) => setTokenLimit(Number(event.target.value))} aria-label="Maximum output tokens per run" disabled={busy}>{[512, 1024, 2048, 4096, 8192].map((value) => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}</select></label>
                      </div>
                    ) : <p className="mode-description">{PUBLIC_SCRIPTED_PREVIEW ? "This static page plays a scripted trace. No MCP server or LLM is used." : "Runs the local MCP tools without using model credits."}</p>}
                    <div className="limit-chips"><span>5 model turns</span><span>8 tool calls</span><span>45 sec max</span></div>
                    <button className="button button--primary run-button" type="button" onClick={requestRun} disabled={busy || publicRunDisabled}>
                      {busy ? <span className="button-spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}
                      <span>{busy ? "Running scenario…" : "Run scenario"}</span>
                    </button>
                    <p className="credit-note"><LockKeyhole aria-hidden="true" />{PUBLIC_SCRIPTED_PREVIEW ? "Scripted walkthrough · no Hanzo credits used." : mode === "hanzo" || HANZO_ONLY_BUILD ? "Hanzo calls use demo credits only after you confirm." : "No model credits are used in scripted mode."}</p>
                  </section>

                  <div className="scenario-actions">
                    <button className="text-button" type="button" onClick={handleReset} disabled={busy}><RotateCcw aria-hidden="true" />Reset display</button>
                    {currentRun && <button className="text-button" type="button" onClick={replayCurrent} disabled={busy}><RotateCcw aria-hidden="true" />Replay run</button>}
                  </div>
                </aside>

                <section className="panel trace-panel" aria-labelledby="trace-heading">
                  <div className="panel-heading panel-heading--trace"><span className="panel-icon panel-icon--terminal">&gt;_</span><div><h2 id="trace-heading">Agent trace</h2><p>{busy ? `${liveTrace.length} live chronological events` : currentRun ? `${currentRun.trace.length} chronological events` : "The run unfolds here, one model turn and tool result at a time."}</p></div>{(currentRun || busy) && <span className={`trace-mode ${(busy ? mode : currentRun?.mode) === "hanzo" ? "trace-mode--live" : ""}`}>{(busy ? mode : currentRun?.mode) === "hanzo" ? "HANZO RUN" : PUBLIC_SCRIPTED_PREVIEW ? "SCRIPTED WALKTHROUGH" : "SCRIPTED MCP"}</span>}</div>
                  {busy ? liveTrace.length ? (
                    <div className="trace-list" role="list" aria-label="Live chronological run trace" aria-live="polite">{liveTrace.map((event) => <TraceRow key={event.id} event={event} mode={mode} />)}</div>
                  ) : <div className="trace-empty"><span className="trace-empty-icon"><Activity aria-hidden="true" /></span><strong>Connecting to the simulation</strong><span>Trace events will appear as the agent calls local MCP tools.</span></div> : currentRun ? (
                    <div className="trace-list" role="list" aria-label="Chronological run trace">{currentRun.trace.map((event) => <TraceRow key={event.id} event={event} mode={currentRun.mode} />)}</div>
                  ) : (
                    <div className="trace-empty trace-empty--workflow"><span className="trace-empty-icon"><CirclePlay aria-hidden="true" /></span><strong>Ready to run</strong><span>Start the scenario to see model turns, tool calls, injected faults, and retries.</span><div className="trace-checklist"><span><Check aria-hidden="true" /> Read ticket via MCP</span><span><Check aria-hidden="true" /> Inspect the linked article</span><span><Check aria-hidden="true" /> Add an internal triage note</span><span><Check aria-hidden="true" /> Score the final ticket state</span></div></div>
                  )}
                </section>

                <aside className="inspector-panel" aria-label="Ticket state and deterministic outcome">
                  <section className="panel inspector-section" aria-labelledby="ticket-state-heading">
                    <div className="panel-heading panel-heading--compact"><span className="panel-icon"><FileText aria-hidden="true" /></span><div><h2 id="ticket-state-heading">Ticket state</h2><p>Before and after the run</p></div>{currentRun && <ResultTag result={currentRun.result} />}</div>
                    <TicketStateCard title="Before · original fixture" ticket={shownBefore} />
                    <TicketStateCard title="After · run state" ticket={shownAfter} after />
                    {currentRun && <div className="run-metadata"><span>Injected fault</span><strong>{faultTitle(currentRun.fault)}</strong></div>}
                  </section>
                  <section className="panel outcome-section" aria-labelledby="outcome-heading">
                    <div className="panel-heading panel-heading--compact"><span className="panel-icon"><Shield aria-hidden="true" /></span><div><h2 id="outcome-heading">Outcome checks</h2><p>Checked against the fixture state</p></div><span className="deterministic-label">RULE-BASED</span></div>
                    {currentRun ? <><ul className="checks-list">{currentRun.checks.map((check) => <CheckRow key={check.id} check={check} />)}</ul><div className={`outcome-summary outcome-summary--${currentRun.result}`}><Shield aria-hidden="true" /><span>{outcomeText(currentRun.result)} · {faultTitle(currentRun.fault).toLowerCase()}</span></div></> : <div className="checks-empty"><span>Run the task to evaluate the note, status, untrusted input, and fault recovery.</span></div>}
                  </section>
                </aside>
              </section>

              <section className="bottom-grid">
                <section className="panel tool-preview" aria-labelledby="tool-preview-heading">
                  <div className="panel-heading panel-heading--compact"><span className="panel-icon"><Layers aria-hidden="true" /></span><div><h2 id="tool-preview-heading">MCP tool catalog <span className="heading-count">{TOOL_CATALOG.length}</span></h2><p>Only these synthetic ticket tools are available</p></div><button className="text-button text-button--accent" type="button" onClick={() => setActiveView("tools")}>Inspect tools <ChevronRight aria-hidden="true" /></button></div>
                  <ToolCatalogTable compact />
                </section>
                <section className="panel recent-preview" aria-labelledby="recent-heading">
                  <div className="panel-heading panel-heading--compact"><span className="panel-icon"><Clock3 aria-hidden="true" /></span><div><h2 id="recent-heading">Recent runs</h2><p>Saved only in this browser</p></div><button className="text-button text-button--accent" type="button" onClick={() => setActiveView("history")}>View all <ChevronRight aria-hidden="true" /></button></div>
                  {history.slice(0, 3).length ? <div className="recent-list">{history.slice(0, 3).map((run) => <button type="button" className="recent-run" key={run.id} onClick={() => selectHistory(run)}><span className={`saved-state saved-state--${run.result}`} aria-hidden="true" /><span className="recent-copy"><strong>{faultTitle(run.fault)}</strong><small>{timeLabel(run.createdAt)} · {run.trace.filter((event) => event.kind === "tool").length} MCP calls</small></span><ResultTag result={run.result} /><ChevronRight aria-hidden="true" className="recent-chevron" /></button>)}</div> : <div className="recent-empty"><Clock3 aria-hidden="true" /><strong>No runs saved yet</strong><span>Run a fault scenario to create the first local trace.</span></div>}
                </section>
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
                {filteredHistory.length ? <div className="table-scroll"><table className="data-table history-table"><thead><tr><th scope="col">Compare</th><th scope="col">Fault</th><th scope="col">Mode</th><th scope="col">Date</th><th scope="col">Trace events</th><th scope="col">Result</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{filteredHistory.map((run) => <tr key={run.id}><td><input type="checkbox" aria-label={`Compare ${faultTitle(run.fault)} run from ${dateTimeLabel(run.createdAt)}`} checked={compareIds.includes(run.id)} onChange={() => toggleCompare(run.id)} disabled={!compareIds.includes(run.id) && compareIds.length >= 2} /></td><th scope="row"><button type="button" className="table-link" onClick={() => selectHistory(run)}>{faultTitle(run.fault)}</button><small className="table-subtext">{run.id.slice(0, 8)}</small></th><td>{run.mode === "hanzo" ? <span className="mode-tag"><Bot aria-hidden="true" />{run.model}</span> : <span className="mode-tag">Scripted MCP</span>}</td><td>{dateTimeLabel(run.createdAt)}</td><td>{run.trace.length}</td><td><ResultTag result={run.result} /></td><td className="table-actions"><button className="icon-button" type="button" onClick={() => exportRun(run)} aria-label={`Export ${faultTitle(run.fault)} run JSON`} title="Export JSON"><ArrowDownToLine aria-hidden="true" /></button><button className="text-button text-button--accent" type="button" onClick={() => selectHistory(run)}>Open</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Clock3 aria-hidden="true" /></span><h2>{history.length ? "No runs match those filters" : "No runs saved yet"}</h2><p>{history.length ? "Adjust your search or result filter." : "Complete a scenario to build a local, inspectable run history."}</p>{history.length > 0 && <button className="text-button text-button--accent" type="button" onClick={() => { setHistorySearch(""); setHistoryFilter("all"); }}>Clear filters</button>}</div>}
              </section>
              <section className="panel compare-panel" aria-labelledby="compare-heading">
                <div className="panel-heading panel-heading--compact"><span className="panel-icon"><Activity aria-hidden="true" /></span><div><h2 id="compare-heading">Compare runs</h2><p>Select up to two saved runs in the table to compare checks and tool activity.</p></div><span className="compare-count">{compareRuns.length}/2 selected</span></div>
                {compareRuns.length === 2 ? <div className="compare-grid">{compareRuns.map((run) => <article className="compare-card" key={run.id}><div className="compare-title"><div><strong>{faultTitle(run.fault)}</strong><small>{dateTimeLabel(run.createdAt)} · {run.mode === "hanzo" ? run.model : "Scripted MCP"}</small></div><ResultTag result={run.result} /></div><div className="compare-stats"><span><strong>{run.trace.filter((event) => event.kind === "tool").length}</strong>MCP calls</span><span><strong>{run.trace.filter((event) => event.kind === "retry").length}</strong>Retries</span><span><strong>{run.trace.length}</strong>Events</span></div><ul className="compare-checks">{run.checks.map((check) => <li key={check.id}><span className={`check-dot check-dot--${check.state}`} />{check.label}</li>)}</ul><button className="text-button text-button--accent" type="button" onClick={() => selectHistory(run)}>Open full trace <ArrowRight aria-hidden="true" /></button></article>)}</div> : <div className="compare-empty">Choose two saved runs above. Their deterministic checks, retries, and MCP call counts will appear here.</div>}
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
              <header className="page-heading"><div><h1 id="page-title">Safety &amp; data</h1><p>See what the demo can change, what leaves this browser, and where the limits apply.</p></div><span className="plain-count">Experimental demo · not a security certification</span></header>
              <section className="data-flow" aria-label="Data flow for a confirmed run"><div className="flow-node"><span className="flow-node-icon"><Activity aria-hidden="true" /></span><strong>Your browser</strong><p>Scenario controls and saved run history</p><small>History remains in local storage</small></div><ArrowRight aria-hidden="true" className="flow-arrow" /><div className="flow-node"><span className="flow-node-icon"><Database aria-hidden="true" /></span><strong>Toolstorm server</strong><p>Fresh synthetic MCP ticket fixture</p><small>Four allowlisted ticket tools</small></div><ArrowRight aria-hidden="true" className="flow-arrow" /><div className="flow-node flow-node--hanzo"><span className="flow-node-icon"><Bot aria-hidden="true" /></span><strong>Hanzo</strong><p>Fixed task prompt and simulated tool results</p><small>Only after the visitor confirms</small></div></section>
              <section className="safety-grid">
                <article className="panel safety-card"><div className="panel-heading"><span className="panel-icon"><ShieldCheck aria-hidden="true" /></span><div><h2>Run boundaries</h2><p>Limits enforced by the hosted runner</p></div></div><ul className="boundary-list"><li><CheckCircle2 aria-hidden="true" /><span><strong>5 model turns</strong><small>Stops after five chat-completion requests.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>8 MCP calls</strong><small>Only the four synthetic ticket tools are available.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>512 output tokens</strong><small>Fixed server-side ceiling on the public Vercel app.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>45 second deadline</strong><small>Run requests are cancelled when the deadline or browser connection ends.</small></span></li></ul></article>
                <article className="panel safety-card"><div className="panel-heading"><span className="panel-icon"><LockKeyhole aria-hidden="true" /></span><div><h2>Privacy &amp; credit use</h2><p>Per-run disclosure and storage</p></div></div><ul className="boundary-list"><li><CheckCircle2 aria-hidden="true" /><span><strong>Key stays server-side</strong><small>The browser receives only whether a key is configured.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>Confirmation before Hanzo</strong><small>Each model run discloses that it may use the demo owner's credits.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>Local history</strong><small>Saved traces stay in this browser and can be cleared or exported.</small></span></li><li><CheckCircle2 aria-hidden="true" /><span><strong>No background inference</strong><small>Loading the page never calls a model.</small></span></li></ul></article>
              </section>
              <section className="panel abuse-note"><div className="panel-icon panel-icon--warning"><AlertTriangle aria-hidden="true" /></div><div><h2>Public-run rate limits have a scope</h2><p>Bot screening and short-term throttles reduce casual abuse. The counters are stored per warm Vercel function, so they are not a shared account-wide credit cap. For a hard ceiling, use a dedicated Hanzo key with a provider-side spend budget and request rate.</p><a href="https://docs.hanzo.ai/docs/api-keys/" target="_blank" rel="noreferrer">Hanzo key limits <ArrowUpRight aria-hidden="true" /></a></div></section>
              <section className="panel safety-status"><div className="panel-heading panel-heading--compact"><span className="panel-icon"><Activity aria-hidden="true" /></span><div><h2>Current execution mode</h2><p>Reported by the server, without exposing secrets</p></div></div><div className="status-grid"><div><span>Environment</span><strong>{PUBLIC_SCRIPTED_PREVIEW ? "Static scripted walkthrough" : status?.source === "vercel" ? "Vercel hosted" : status?.source === "local" ? "Local development" : "Checking runner"}</strong></div><div><span>Hanzo key</span><strong>{PUBLIC_SCRIPTED_PREVIEW ? "Not used by this page" : status?.hasHanzoKey ? "Configured on server" : status?.available ? "Not configured" : "Unavailable"}</strong></div><div><span>History</span><strong>Browser only · {history.length} saved</strong></div><div><span>Model cap</span><strong>{HANZO_ONLY_BUILD ? "512 output tokens" : `${tokenLimit.toLocaleString()} output tokens`}</strong></div></div></section>
            </section>
          )}
        </main>

        <footer className="app-footer"><span>Toolstorm · public technical demo</span><span>Synthetic ticket data · saved run history stays in this browser</span></footer>
      </div>

      {confirmOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOpen(false); }}>
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
            <button className="modal-close" type="button" aria-label="Close confirmation" onClick={() => setConfirmOpen(false)}><X aria-hidden="true" /></button>
            <span className="modal-icon"><LockKeyhole aria-hidden="true" /></span>
            <h2 id="confirm-title">Confirm a Hanzo model run</h2>
            <p id="confirm-description">Toolstorm will send the fixed task prompt and simulated ticket/help-article results to Hanzo using this demo's server key. This may use the demo owner's Hanzo credits.</p>
            <div className="confirmation-facts"><span><CheckCircle2 aria-hidden="true" />Only the fixed fictional ticket scenario is sent</span><span><CheckCircle2 aria-hidden="true" />Model: {model} · up to {tokenLimit.toLocaleString()} output tokens, 5 model turns, and 8 tool calls</span><span><CheckCircle2 aria-hidden="true" />Your API key stays in the server environment</span><span><CheckCircle2 aria-hidden="true" />No request is made until you confirm below</span></div>
            <div className="modal-actions"><button className="button button--quiet" type="button" onClick={() => setConfirmOpen(false)}>Cancel</button><button className="button button--primary" type="button" onClick={() => void startRun(fault, "hanzo", true)}><LockKeyhole aria-hidden="true" /><span>Confirm &amp; run</span></button></div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;

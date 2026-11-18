export type FaultKind = "temporary_error" | "malformed_data" | "untrusted_instruction";
export type RunMode = "scripted" | "hanzo";
export type CheckState = "passed" | "failed" | "not_applicable";

export interface TicketNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface TicketState {
  id: number;
  subject: string;
  status: string;
  priority: "low" | "normal" | "high";
  requester: string;
  message: string;
  helpArticleId: string;
  internalNotes: TicketNote[];
}

export interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  body: string;
  url: string;
}

export type TraceKind = "agent" | "tool" | "retry" | "fault" | "system" | "blocked";
export type TraceStatus = "info" | "success" | "error" | "warning" | "blocked";

export interface TraceEvent {
  id: string;
  sequence: number;
  at: string;
  kind: TraceKind;
  status: TraceStatus;
  title: string;
  detail?: string;
  toolName?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
}

export interface OutcomeCheck {
  id: "useful_note" | "status_unchanged" | "ignored_injection" | "completed_after_fault";
  label: string;
  state: CheckState;
  detail: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  mode: RunMode;
  model: string;
  fault: FaultKind;
  result: "passed" | "partial" | "failed";
  before: TicketState;
  after: TicketState;
  trace: TraceEvent[];
  checks: OutcomeCheck[];
}

export interface RunRequest {
  mode: RunMode;
  fault: FaultKind;
  model: string;
  maxOutputTokens: number;
  confirmed: boolean;
}

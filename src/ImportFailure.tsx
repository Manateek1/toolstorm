import { useEffect, useRef, useState } from "react";
import { ArrowRight, FileUp, X } from "lucide-react";
import { ERROR_PROFILES } from "./domain/errorProfiles";
import { MAX_FAILURE_IMPORT_BYTES, parseMcpFailureImport, type ImportedFailure } from "./lib/importMcpFailure";

const EXAMPLE = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  result: { isError: true, content: [{ type: "text", text: "429 Too many requests. Try again later." }] },
}, null, 2);

interface ImportFailureProps {
  onApply: (failure: ImportedFailure) => void;
  onClose: () => void;
}

export function ImportFailure({ onApply, onClose }: ImportFailureProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [failures, setFailures] = useState<ImportedFailure[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const failure = failures[selected];

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function inspect(input: string) {
    setSource(input);
    setSelected(0);
    setError("");
    try {
      setFailures(parseMcpFailureImport(input));
    } catch (cause) {
      setFailures([]);
      setError(cause instanceof Error ? cause.message : "The failure could not be imported.");
    }
  }

  async function readFile(file: File) {
    setFailures([]);
    setSelected(0);
    setSource("");
    if (file.size > MAX_FAILURE_IMPORT_BYTES) {
      setError("Choose a file under 128 KB.");
      return;
    }
    setReading(true);
    setError("");
    try {
      inspect(await file.text());
    } catch {
      setError("Toolstorm couldn't read this file. Try pasting the error text.");
    } finally {
      setReading(false);
    }
  }

  return (
    <dialog ref={dialog} className="failure-dialog" aria-labelledby="import-failure-heading" onClose={onClose}>
      <div className="panel-heading">
        <h2 id="import-failure-heading"><FileUp aria-hidden="true" />Import MCP failure</h2>
        <button className="icon-button" type="button" onClick={() => dialog.current?.close()} aria-label="Close import"><X aria-hidden="true" /></button>
      </div>
      <div className="failure-dialog-body">
        <p className="failure-intro">Paste a failed MCP response or load a JSON, JSONL, or text log. Toolstorm uses the detected error type to simulate a similar failure. Your original log stays in this browser.</p>
        <label className="field">
          <span>Log file</span>
          <input type="file" accept=".json,.jsonl,.ndjson,.log,.txt,application/json,text/plain" disabled={reading} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void readFile(file);
          }} />
        </label>
        <label className="field">
          <span>Failure payload or log excerpt</span>
          <textarea rows={6} value={source} maxLength={MAX_FAILURE_IMPORT_BYTES} disabled={reading} placeholder={'{"isError":true,"content":[…]}'} onChange={(event) => {
            setSource(event.target.value);
            setFailures([]);
            setError("");
          }} />
        </label>
        <div className="failure-inspect">
          <button className="button button--quiet" type="button" onClick={() => inspect(source)} disabled={reading || !source.trim()}>{reading ? "Reading file…" : "Detect failures"}</button>
          <button className="text-button" type="button" onClick={() => inspect(EXAMPLE)} disabled={reading}>Load example</button>
        </div>
        {error && <p className="failure-error" role="alert">{error}</p>}

        {failure && (
          <div className="failure-match" aria-label="Detected failure">
            {failures.length > 1 && (
              <label className="field"><span>Failure to replay</span>
                <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
                  {failures.map((entry, index) => (
                    <option key={index} value={index}>{index + 1}. {ERROR_PROFILES[entry.profile].label}{entry.tool ? ` · ${entry.tool}` : ""}</option>
                  ))}
                </select>
              </label>
            )}
            <strong role="status">{ERROR_PROFILES[failure.profile].label}</strong>
            <p className="failure-metadata">{[failure.source, failure.tool, failure.code].filter(Boolean).join(" · ")}</p>
            <pre>{failure.message}</pre>
            <button className="button button--primary" type="button" onClick={() => {
              onApply(failure);
              dialog.current?.close();
            }}>Use in lab <ArrowRight aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </dialog>
  );
}

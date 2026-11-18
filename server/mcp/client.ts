import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FaultKind } from "../../src/domain/types.ts";

export const ALLOWED_TOOLS = [
  "get_ticket",
  "search_help_articles",
  "add_internal_note",
  "change_ticket_status",
] as const;

export async function connectTicketMcp(fault: FaultKind) {
  const client = new Client({ name: "toolstorm-agent-host", version: "1.0.0" });
  const serverPath = fileURLToPath(new URL("./stdio.ts", import.meta.url));
  const tsxCliPath = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCliPath, serverPath, "--fault", fault],
    cwd: process.cwd(),
    env,
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  return { client, close: () => client.close() };
}

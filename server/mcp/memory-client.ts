import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { FaultDuration, FaultKind, FaultTarget } from "../../src/domain/types.ts";
import { createTicketServer } from "./ticket-server.ts";

export async function connectInMemoryTicketMcp(fault: FaultKind, duration: FaultDuration = "once", target: FaultTarget = "search_help_articles") {
  const client = new Client({ name: "toolstorm-agent-host", version: "1.0.0" });
  const server = createTicketServer(fault, duration, target);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

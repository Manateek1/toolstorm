import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { FaultKind } from "../../src/domain/types.ts";
import { createTicketServer } from "./ticket-server.ts";

export async function connectInMemoryTicketMcp(fault: FaultKind) {
  const client = new Client({ name: "toolstorm-agent-host", version: "1.0.0" });
  const server = createTicketServer(fault);
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

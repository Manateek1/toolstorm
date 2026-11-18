import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseFault } from "../../src/domain/fixture.ts";
import { createTicketServer } from "./ticket-server.ts";

const faultArg = process.argv.indexOf("--fault");
const fault = parseFault(faultArg >= 0 ? process.argv[faultArg + 1] : undefined);
const handle = serveStdio(() => createTicketServer(fault));

process.once("SIGINT", () => void handle.close());
process.once("SIGTERM", () => void handle.close());

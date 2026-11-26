import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseErrorProfile } from "../../src/domain/errorProfiles.ts";
import { parseFault, parseFaultDuration, parseFaultTarget } from "../../src/domain/fixture.ts";
import { createTicketServer } from "./ticket-server.ts";

const faultArg = process.argv.indexOf("--fault");
const fault = parseFault(faultArg >= 0 ? process.argv[faultArg + 1] : undefined);
const durationArg = process.argv.indexOf("--duration");
const duration = parseFaultDuration(fault, durationArg >= 0 ? process.argv[durationArg + 1] : undefined);
const targetArg = process.argv.indexOf("--target");
const target = parseFaultTarget(fault, targetArg >= 0 ? process.argv[targetArg + 1] : undefined);
const profileArg = process.argv.indexOf("--error-profile");
const errorProfile = parseErrorProfile(profileArg >= 0 ? process.argv[profileArg + 1] : undefined);
const handle = serveStdio(() => createTicketServer(fault, duration, target, errorProfile));

process.once("SIGINT", () => void handle.close());
process.once("SIGTERM", () => void handle.close());

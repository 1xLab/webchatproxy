import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayRuntime } from "./lib/gateway-runtime.mjs";
import { createGatewayHttpServer } from "./lib/http-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtime = await new GatewayRuntime({ baseDir: __dirname }).init();
const server = createGatewayHttpServer(runtime);
const { host, port } = runtime.config;

server.on("error", (error) => {
  runtime.journal.record("server_error", { error: error.message, code: error.code || null }, "error");
  console.error(`[gateway] ${error.code || "ERROR"}: ${error.message}`);
  if (error.code === "EADDRINUSE") {
    console.error(`[gateway] Port ${port} is already in use. Set WEBCHAT_PORT to another dedicated port.`);
  }
});

server.listen(port, host, () => {
  runtime.journal.record("gateway_listening", { host, port, pid: process.pid });
  console.log(`[gateway] listening on http://${host}:${port}`);
  runtime.startBrowser().catch((error) => {
    runtime.journal.record("browser_start_failed", { error: error.message }, "error");
    console.error(`[browser] startup failed: ${error.message}`);
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.journal.record("gateway_shutdown", { signal });
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  runtime.journal.record("unhandled_rejection", { error: reason?.message || String(reason) }, "error");
});
process.on("uncaughtException", (error) => {
  runtime.journal.record("uncaught_exception", { error: error.message, stack: error.stack || null }, "error");
  console.error(error);
});

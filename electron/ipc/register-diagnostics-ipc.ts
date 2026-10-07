import type { DiagnosticsService } from "../services/diagnostics-service";
import { validateLogId } from "../services/diagnostics-service";
import { validateLogFilter } from "../services/local-logger";
import type { RegisterHandler } from "./register-local-media-ipc";

export type DiagnosticsIPCServices = Pick<
  DiagnosticsService,
  "get" | "logs" | "copyLog" | "openLogs" | "clearLogs" | "exportDiagnostics"
>;

/** The common registrar validates the trusted sender before these argument boundaries run. */
export function registerDiagnosticsIPC(
  service: DiagnosticsIPCServices,
  handle: RegisterHandler,
): void {
  const noArguments =
    (operation: () => unknown) =>
    (...args: unknown[]) => {
      if (args.length !== 0) throw new Error("invalidInput");
      return operation();
    };
  handle(
    "diagnostics:get",
    noArguments(() => service.get()),
  );
  handle("diagnostics:logs", (...args) => {
    if (args.length > 1) throw new Error("invalidInput");
    return service.logs(validateLogFilter(args[0]));
  });
  handle("diagnostics:copyLog", (...args) => {
    if (args.length !== 1) throw new Error("invalidInput");
    return service.copyLog(validateLogId(args[0]));
  });
  handle(
    "diagnostics:openLogs",
    noArguments(() => service.openLogs()),
  );
  handle(
    "diagnostics:clearLogs",
    noArguments(() => service.clearLogs()),
  );
  handle(
    "diagnostics:export",
    noArguments(() => service.exportDiagnostics()),
  );
}

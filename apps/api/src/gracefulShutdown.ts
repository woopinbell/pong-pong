import type { EventEmitter } from "node:events";

type ShutdownSignal = "SIGTERM" | "SIGINT";
type SignalSource = Pick<EventEmitter, "on" | "off">;

export function installGracefulShutdown(
  signals: SignalSource,
  shutdown: (signal: ShutdownSignal) => Promise<void>,
  onError: (error: unknown) => void
): () => void {
  let started = false;
  const start = (signal: ShutdownSignal) => {
    if (started) return;
    started = true;
    void shutdown(signal).catch(onError);
  };
  const onSigterm = () => start("SIGTERM");
  const onSigint = () => start("SIGINT");

  signals.on("SIGTERM", onSigterm);
  signals.on("SIGINT", onSigint);

  return () => {
    signals.off("SIGTERM", onSigterm);
    signals.off("SIGINT", onSigint);
  };
}

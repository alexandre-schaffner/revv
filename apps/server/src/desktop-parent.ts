/** Stop an orphaned server if the owning desktop app crashes or is force-quit. */
export function watchDesktopParent(parentPid: number, shutdown: () => void): void {
  if (parentPid <= 0) return;
  const timer = setInterval(() => {
    if (process.ppid === parentPid) return;
    clearInterval(timer);
    shutdown();
  }, 1_000);
  timer.unref();
}

// SvelteKit client hooks.
//
// In dev, boot web RUM and export spans to the local telemetry collector. The
// import is dynamic and guarded on `import.meta.env.DEV` so the OpenTelemetry
// browser SDK is dead-code-eliminated from the production desktop bundle.
if (import.meta.env.DEV) {
  void import("$lib/observability/rum")
    .then((m) => m.initRum())
    .catch(() => {
      // RUM is best-effort dev tooling; never let it break the app.
    });
}

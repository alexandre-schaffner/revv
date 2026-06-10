type MermaidApi = typeof import("mermaid").default;
type AppTheme = "light" | "dark";
type MermaidTheme = "default" | "dark";
type RenderResult = { svg: string } | { error: string };

let mermaidApi: MermaidApi | null = null;
let loadPromise: Promise<MermaidApi> | null = null;
let activeTheme: MermaidTheme | null = null;
let renderCounter = 0;

const svgCache = new Map<string, string>();

function toMermaidTheme(theme: AppTheme): MermaidTheme {
  return theme === "dark" ? "dark" : "default";
}

async function loadMermaid(): Promise<MermaidApi> {
  if (mermaidApi) return mermaidApi;
  if (!loadPromise) {
    loadPromise = import("mermaid").then((mod) => mod.default);
  }
  mermaidApi = await loadPromise;
  return mermaidApi;
}

export async function initMermaid(theme: AppTheme): Promise<void> {
  const nextTheme = toMermaidTheme(theme);
  const api = await loadMermaid();
  if (activeTheme === nextTheme) return;

  api.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: nextTheme,
  });
  activeTheme = nextTheme;
}

export async function renderMermaid(source: string): Promise<RenderResult> {
  if (!activeTheme) {
    await initMermaid("light");
  }

  const theme = activeTheme ?? "default";
  const cacheKey = `${theme}\u0000${source}`;
  const cached = svgCache.get(cacheKey);
  if (cached) return { svg: cached };

  try {
    const api = await loadMermaid();
    const id = `revv-mermaid-${++renderCounter}`;
    const result = await api.render(id, source);
    svgCache.set(cacheKey, result.svg);
    return { svg: result.svg };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Diagram failed to render.",
    };
  }
}

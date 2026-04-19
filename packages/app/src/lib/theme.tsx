import { createContext, useCallback, useContext, useEffect, useState } from "react";

export const themes = {
  "zinc-light": { label: "Zinc", dark: false, family: "zinc", shikiTheme: "github-light" },
  "zinc-dark": { label: "Zinc", dark: true, family: "zinc", shikiTheme: "github-dark" },
  "catppuccin-latte": { label: "Catppuccin Latte", dark: false, family: "catppuccin", shikiTheme: "catppuccin-latte" },
  "catppuccin-mocha": { label: "Catppuccin Mocha", dark: true, family: "catppuccin", shikiTheme: "catppuccin-mocha" },
  "gruvbox-light": { label: "Gruvbox", dark: false, family: "gruvbox", shikiTheme: "gruvbox-light-medium" },
  "gruvbox-dark": { label: "Gruvbox", dark: true, family: "gruvbox", shikiTheme: "gruvbox-dark-medium" },
} as const;

export type ThemeId = keyof typeof themes;

const STORAGE_KEY = "rev-theme";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "zinc-dark",
  setTheme: () => {},
});

function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  for (const key of Object.keys(themes)) {
    root.classList.remove(`theme-${key}`);
  }
  root.classList.remove("dark");

  root.classList.add(`theme-${id}`);
  if (themes[id].dark) {
    root.classList.add("dark");
  }

  // Set color-scheme so CSS light-dark() resolves correctly
  // (this also propagates into Shadow DOM for @pierre/diffs)
  root.style.colorScheme = themes[id].dark ? "dark" : "light";
}

function getStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in themes) return stored as ThemeId;
  } catch {
    // SSR or storage unavailable
  }
  return "zinc-dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(getStoredTheme);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

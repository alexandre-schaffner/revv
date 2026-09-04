// Theme switch: light / dark / system, persisted to localStorage and applied
// as a `.dark` class on <html>. The pre-paint inline script in index.html sets
// the initial class; this store keeps it in sync after hydration.

export type Theme = "light" | "dark" | "system";

const KEY = "revv-collector-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function load(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function resolve(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && media.matches);
}

class ThemeStore {
  current = $state<Theme>(load());
  isDark = $state(resolve(load()));

  constructor() {
    media.addEventListener("change", () => {
      if (this.current === "system") this.#apply();
    });
  }

  set(theme: Theme): void {
    this.current = theme;
    localStorage.setItem(KEY, theme);
    this.#apply();
  }

  /** Cycle light → dark → system for a single toggle control. */
  cycle(): void {
    const order: Theme[] = ["light", "dark", "system"];
    const i = order.indexOf(this.current);
    this.set(order[(i + 1) % order.length] ?? "system");
  }

  #apply(): void {
    this.isDark = resolve(this.current);
    document.documentElement.classList.toggle("dark", this.isDark);
  }
}

export const theme = new ThemeStore();

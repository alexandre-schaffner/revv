import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useMatches,
} from "@tanstack/react-router";
import appCss from "@rev/ui/styles/globals.css?url";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@rev/ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rev/ui/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@rev/ui/components/ui/popover";
import { CwdBlock } from "../blocks/cwd/ui";
import { ApprovalBlock } from "../blocks/approval/ui";
import { FilesBlock } from "../blocks/files/ui";
import { PrsBlock } from "../blocks/prs/ui";
import { Terminal, Blocks, Palette } from "lucide-react";
import { ThemeProvider, useTheme, themes, type ThemeId } from "../lib/theme";
import { initShortcuts, useRegisterShortcuts, toggleMode, useActiveMode, useShortcutPressed, formatKeysString, type ShortcutDef } from "../lib/shortcuts";
import { Kbd } from "@rev/ui/components/ui/kbd";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Rev" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

const navItems = [
  { to: "/", icon: Terminal, label: "Home" },
  { to: "/design", icon: Blocks, label: "Design System" },
] as const;

function ActivityBar() {
  const matches = useMatches();
  const pathname = matches[matches.length - 1]?.pathname ?? "/";

  return (
    <nav className="flex flex-col items-center justify-between w-12 border-r border-border bg-background py-2 shrink-0">
      <div className="flex flex-col items-center gap-1">
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <Tooltip key={to}>
              <TooltipTrigger asChild>
                <Link
                  to={to}
                  className={`relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-primary" />
                  )}
                  <Icon className="size-[18px]" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-1">
        <ThemePicker />
      </div>
    </nav>
  );
}

const themeSwatches: Record<ThemeId, string> = {
  "zinc-light": "bg-white border border-zinc-300",
  "zinc-dark": "bg-zinc-900 border border-zinc-700",
  "catppuccin-latte": "bg-[#eff1f5] border border-[#acb0be]",
  "catppuccin-mocha": "bg-[#1e1e2e] border border-[#585b70]",
  "gruvbox-light": "bg-[#fbf1c7] border border-[#d5c4a1]",
  "gruvbox-dark": "bg-[#282828] border border-[#504945]",
};

// Group themes by family for the picker
const themeGroups = [
  { label: "Zinc", ids: ["zinc-light", "zinc-dark"] as ThemeId[] },
  { label: "Catppuccin", ids: ["catppuccin-latte", "catppuccin-mocha"] as ThemeId[] },
  { label: "Gruvbox", ids: ["gruvbox-light", "gruvbox-dark"] as ThemeId[] },
];

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button className="flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors">
              <Palette className="size-[18px]" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          Theme
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" sideOffset={8} className="w-52 p-2">
        <p className="text-xs font-medium text-muted-foreground px-2 pb-1.5">Theme</p>
        <div className="space-y-2">
          {themeGroups.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider px-2 pb-0.5">{group.label}</p>
              {group.ids.map((id) => (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  className={`flex items-center gap-2.5 w-full rounded-md px-2 py-1.5 text-sm transition-colors ${
                    theme === id
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <span className={`inline-block w-3.5 h-3.5 rounded-full shrink-0 ${themeSwatches[id]}`} />
                  {themes[id].label}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {themes[id].dark ? "dark" : "light"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SidebarTabs() {
  const [tab, setTab] = useState("files");
  const modeActive = useActiveMode() === "sidebar";
  const focusPressed = useShortcutPressed("sidebar:focus");
  const filesPressed = useShortcutPressed("sidebar:files");
  const prsPressed = useShortcutPressed("sidebar:prs");

  const switchToFiles = useCallback(() => setTab("files"), []);
  const switchToPrs = useCallback(() => setTab("prs"), []);
  const focusSidebar = useCallback(() => toggleMode("sidebar"), []);

  const shortcuts = useMemo<ShortcutDef[]>(
    () => [
      { id: "sidebar:focus", label: "Focus Sidebar", keys: { mod: true, key: "r" }, category: "Sidebar", action: focusSidebar },
      { id: "sidebar:files", label: "Files", keys: { mod: true, key: "1" }, mode: "sidebar", category: "Sidebar", action: switchToFiles },
      { id: "sidebar:prs", label: "PRs", keys: { mod: true, key: "2" }, mode: "sidebar", category: "Sidebar", action: switchToPrs },
    ],
    [switchToFiles, switchToPrs, focusSidebar],
  );

  useRegisterShortcuts(shortcuts);

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col h-full">
      <div className="flex items-center h-8 border-b border-border shrink-0">
        <button
          type="button"
          onClick={focusSidebar}
          className={`flex items-center justify-center h-8 px-1.5 transition-colors ${
            modeActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Kbd className={`text-[9px] transition-all duration-100 ${modeActive ? "bg-primary/15 text-primary border-primary/25" : ""} ${focusPressed ? "translate-y-px scale-95 brightness-90" : ""}`}>
            {formatKeysString({ mod: true, key: "r" })}
          </Kbd>
        </button>
        <div className="w-px self-stretch my-1.5 bg-border" />
        <TabsList className="h-8 rounded-none bg-transparent p-0 border-0">
          <TabsTrigger value="files" className="h-8 rounded-none text-xs data-[state=active]:shadow-none data-[state=active]:bg-background/50">
            Files
            <Kbd className={`ml-1.5 text-[9px] transition-all duration-100 ${modeActive ? "bg-primary/15 text-primary border-primary/25" : "opacity-50"} ${filesPressed ? "translate-y-px scale-95 brightness-90" : ""}`}>1</Kbd>
          </TabsTrigger>
          <TabsTrigger value="prs" className="h-8 rounded-none text-xs data-[state=active]:shadow-none data-[state=active]:bg-background/50">
            PRs
            <Kbd className={`ml-1.5 text-[9px] transition-all duration-100 ${modeActive ? "bg-primary/15 text-primary border-primary/25" : "opacity-50"} ${prsPressed ? "translate-y-px scale-95 brightness-90" : ""}`}>2</Kbd>
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="files" className="mt-0 flex-1 min-h-0">
        <FilesBlock />
      </TabsContent>
      <TabsContent value="prs" className="mt-0 flex-1 min-h-0">
        <PrsBlock />
      </TabsContent>
    </Tabs>
  );
}

function RootComponent() {
  useEffect(() => initShortcuts(), []);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <div className="flex flex-1 min-h-0">
            <ActivityBar />
            <aside className="w-56 border-r border-border bg-muted/50 overflow-hidden flex flex-col">
              <SidebarTabs />
            </aside>
            <main className="flex-1 min-w-0">
              <Outlet />
            </main>
          </div>
          <footer className="flex items-center border-t border-border bg-muted px-4 py-2 gap-3">
            <CwdBlock />
            <div className="w-px self-stretch bg-border" />
            <div className="flex-1 min-w-0">
              <ApprovalBlock />
            </div>
          </footer>
        </TooltipProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

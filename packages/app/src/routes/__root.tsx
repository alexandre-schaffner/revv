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
import { CwdBlock } from "../blocks/cwd/ui";
import { ApprovalBlock } from "../blocks/approval/ui";
import { FilesBlock } from "../blocks/files/ui";
import { PrsBlock } from "../blocks/prs/ui";
import { Terminal, Blocks, Settings } from "lucide-react";

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
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors">
              <Settings className="size-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <TooltipProvider delayDuration={300}>
          <div className="flex flex-1 min-h-0">
            <ActivityBar />
            <aside className="w-56 border-r border-border bg-muted/50 overflow-hidden flex flex-col">
              <Tabs defaultValue="files" className="flex flex-col h-full">
                <TabsList className="h-8 rounded-none border-b border-border bg-transparent p-0 shrink-0">
                  <TabsTrigger value="files" className="h-8 rounded-none text-xs data-[state=active]:shadow-none data-[state=active]:bg-background/50">Files</TabsTrigger>
                  <TabsTrigger value="prs" className="h-8 rounded-none text-xs data-[state=active]:shadow-none data-[state=active]:bg-background/50">PRs</TabsTrigger>
                </TabsList>
                <TabsContent value="files" className="mt-0 flex-1 min-h-0">
                  <FilesBlock />
                </TabsContent>
                <TabsContent value="prs" className="mt-0 flex-1 min-h-0">
                  <PrsBlock />
                </TabsContent>
              </Tabs>
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
        <Scripts />
      </body>
    </html>
  );
}

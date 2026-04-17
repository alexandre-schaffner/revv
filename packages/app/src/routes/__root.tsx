import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import appCss from "@rev/ui/styles/globals.css?url";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@rev/ui/components/ui/tabs";
import { CwdBlock } from "../blocks/cwd/ui";
import { ApprovalBlock } from "../blocks/approval/ui";
import { FilesBlock } from "../blocks/files/ui";
import { PrsBlock } from "../blocks/prs/ui";

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

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <div className="flex flex-1 min-h-0">
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
        <Scripts />
      </body>
    </html>
  );
}

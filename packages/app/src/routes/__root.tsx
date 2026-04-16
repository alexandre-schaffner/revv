import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import appCss from "@rev/ui/styles/globals.css?url";
import { CwdBlock } from "../components/cwd-block";

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
      <body className="flex min-h-screen flex-col">
        <main className="flex-1">
          <Outlet />
        </main>
        <footer className="border-t border-border bg-muted px-4 py-2">
          <CwdBlock />
        </footer>
        <Scripts />
      </body>
    </html>
  );
}

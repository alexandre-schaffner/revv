import appCss from "@revv/ui/styles/globals.css?url";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { ApprovalBlock } from "../blocks/approval/ui";
import { CwdBlock } from "../blocks/cwd/ui";
import { FilesBlock } from "../blocks/files/ui";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Revv" },
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
				<div className="flex flex-1 min-h-0">
					<aside className="w-56 border-r border-border bg-muted/50 overflow-hidden flex flex-col">
						<FilesBlock />
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

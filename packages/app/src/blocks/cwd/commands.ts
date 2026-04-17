import { createServerFn } from "@tanstack/react-start";
import { run } from "../../lib/command-log";

const BLOCK = "cwd";

export const getCwd = createServerFn({ method: "GET" }).handler(async () => {
	const entry = await run(BLOCK, "pwd");
	return entry.result!.stdout.trim();
});

// cd can't work in a subprocess, but we log it through the bus
export const setCwd = createServerFn({ method: "POST" })
	.inputValidator((input: { path: string }) => input)
	.handler(async ({ data }) => {
		await run(BLOCK, "cd", [data.path]);
		process.chdir(data.path);
		const entry = await run(BLOCK, "pwd");
		return entry.result!.stdout.trim();
	});

export const getGitRepos = createServerFn({ method: "GET" }).handler(
	async () => {
		const home = (
			await run(BLOCK, "sh", ["-c", "echo $HOME"])
		).result!.stdout.trim();

		const searchDirs = [
			"dev",
			"Developer",
			"projects",
			"src",
			"code",
			"repos",
			"workspace",
		].map((d) => `${home}/${d}`);

		const results = await Promise.all(
			searchDirs.map((dir) =>
				run(BLOCK, "find", [
					dir,
					"-maxdepth",
					"2",
					"-name",
					".git",
					"-type",
					"d",
				]),
			),
		);

		const repos = results
			.flatMap((entry) =>
				(entry.result?.stdout ?? "")
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean),
			)
			.map((gitDir) => gitDir.replace(/\/\.git$/, ""))
			.filter(Boolean);

		const cwd = (await run(BLOCK, "pwd")).result!.stdout.trim();
		const cwdCheck = await run(BLOCK, "git", ["revv-parse", "--git-dir"]);
		if (cwdCheck.result?.code === 0 && !repos.includes(cwd)) {
			repos.unshift(cwd);
		}

		return [...new Set(repos)].sort();
	},
);

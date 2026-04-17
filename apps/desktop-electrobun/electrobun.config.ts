import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Revv",
		identifier: "com.revv.desktop",
		version: "0.0.1",
	},
	build: {
		bun: {
			entrypoint: "./src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "./src/view/index.ts",
			},
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
} satisfies ElectrobunConfig;

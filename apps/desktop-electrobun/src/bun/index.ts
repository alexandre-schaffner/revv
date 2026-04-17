import { BrowserWindow } from "electrobun";

const win = new BrowserWindow({
	title: "Revv",
	frame: {
		x: 0,
		y: 0,
		width: 1280,
		height: 800,
	},
	url: process.env.NODE_ENV === "development" ? "http://localhost:3000" : null,
});

console.log("Revv desktop started");

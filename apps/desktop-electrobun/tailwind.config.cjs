const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "src/**/*.{ts,tsx}"),
    path.join(__dirname, "../../packages/solid-app/src/**/*.{ts,tsx}"),
    path.join(__dirname, "../../packages/solid-ui/src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

// tsc only emits .js from .ts — static assets like capture.html need to be
// copied into dist-electron alongside the compiled renderer script by hand.
const fs = require("node:fs");
const path = require("node:path");

const from = path.join(__dirname, "..", "electron", "renderer", "capture.html");
const to = path.join(__dirname, "..", "dist-electron", "electron", "renderer", "capture.html");

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
console.log(`copied ${path.relative(process.cwd(), from)} -> ${path.relative(process.cwd(), to)}`);

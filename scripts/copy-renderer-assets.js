// tsc only emits .js from .ts — static assets like capture.html/pairing.html need to be
// copied into dist-electron alongside the compiled renderer script by hand.
const fs = require("node:fs");
const path = require("node:path");

for (const file of ["capture.html", "pairing.html"]) {
  const from = path.join(__dirname, "..", "electron", "renderer", file);
  const to = path.join(__dirname, "..", "dist-electron", "electron", "renderer", file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${path.relative(process.cwd(), from)} -> ${path.relative(process.cwd(), to)}`);
}

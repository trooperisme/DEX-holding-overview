import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Vercel dashboard copy stays identical to the source dashboard", () => {
  const root = path.resolve(__dirname, "..");
  for (const file of ["index.html", "main.js", "styles.css"]) {
    const source = fs.readFileSync(path.join(root, "dashboard", file), "utf8");
    const publicCopy = fs.readFileSync(path.join(root, "public", "dashboard", file), "utf8");
    assert.equal(publicCopy, source, `dashboard/${file} and public/dashboard/${file} diverged`);
  }
});

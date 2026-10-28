import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("deployment builds from the website repository without neighboring source folders", async (t) => {
  const prefix = join(tmpdir(), "iatron-web-");
  const checkout = await mkdtemp(prefix);
  assert.ok(resolve(checkout).startsWith(resolve(prefix)));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  for (const name of ["package.json", "vite.config.ts", "web", "scripts", "vercel.json"]) {
    await cp(new URL("../" + name, import.meta.url), join(checkout, name), { recursive: true });
  }
  // Reuse installed tooling only; all app content must come from the isolated copy.
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(checkout, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = spawnSync(process.execPath, ["--run", "build"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  const assets = await readdir(join(checkout, "dist/assets"));
  assert.equal(assets.filter((name) => name.endsWith(".png")).length, 97);
  const worker = await readFile(join(checkout, "dist/sw.js"), "utf8");
  const files = JSON.parse(worker.match(/const FILES = (\[[^\n]*\]);/u)[1]);
  assert.ok(files.includes("./index.html"));
  for (const asset of assets) assert.ok(files.includes("./assets/" + asset));

  // An incomplete upload must fail before creating another production build.
  const images = await readdir(join(checkout, "web/src/assets/pathways"));
  await rm(join(checkout, "web/src/assets/pathways", images[0]));
  const incomplete = spawnSync(process.execPath, ["scripts/verify-web-content.mjs"], {
    cwd: checkout,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /ENOENT/u);
});

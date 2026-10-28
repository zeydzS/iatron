import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const libraryText = await readFile(
  new URL("../web/src/data/library.json", import.meta.url),
  "utf8",
);
const library = JSON.parse(libraryText);
test("website bundle exactly matches the native library", async () => {
  assert.deepEqual(
    library,
    JSON.parse(
      await readFile(new URL("../../mobile/src/data/library.json", import.meta.url), "utf8"),
    ),
  );
});
const source = await readFile(
  new URL("../../mobile/src/services/pathwayLibrary.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(
  source.replace(
    'import bundledLibrary from "../data/library.json";',
    "const bundledLibrary = " + libraryText + ";",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText;
const loader = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

test("native loader serves every procedure locally and honors cancellation", async () => {
  assert.doesNotMatch(source, /fetch\s*\(|https?:\/\//u);
  const catalog = await loader.loadCatalog();
  assert.deepEqual(catalog, library.catalog);
  for (const record of Object.values(catalog.procedures)) {
    assert.deepEqual(await loader.loadProcedure(record.path), library.flows[record.path]);
  }
  await assert.rejects(loader.loadProcedure("/flows/missing.json"), /not included/u);
  await assert.rejects(
    loader.loadProcedure("https://example.com/flows/test.json"),
    /not included/u,
  );
  await assert.rejects(loader.loadProcedure("__proto__"), /not included/u);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loader.loadCatalog(controller.signal), { name: "AbortError" });
  await assert.rejects(loader.loadProcedure(Object.keys(library.flows)[0], controller.signal), {
    name: "AbortError",
  });
  assert.equal(loader.IsCancelationError(Object.assign(new Error(), { name: "AbortError" })), true);
});

test("packaged library exactly preserves all generated flow content", async () => {
  const fresh = library.provenance?.kind === "fresh-visio-extraction";
  for (const [key, flow] of Object.entries(library.flows)) {
    const generated = JSON.parse(
      await readFile(
        new URL(
          fresh ? "../../first_aid_reextracted/runtime" + key : "../generated" + key,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(flow, generated);
  }
});

test("fresh extraction keeps uncertain pictures separate and preserves original source text", () => {
  assert.equal(library.provenance.kind, "fresh-visio-extraction");
  const flows = Object.values(library.flows);
  const placements = flows.flatMap((flow) =>
    flow.pages.flatMap((page) => page.nodes.flatMap((node) => node.media)),
  );
  const unassigned = flows.flatMap((flow) => flow.unassigned_media);
  assert.equal(placements.length, 849);
  assert.equal(unassigned.length, 155);
  const attachedIds = new Set(placements.map((image) => image.placement_id));
  for (const image of unassigned) {
    assert.equal(image.association_status, "needs_review");
    assert.equal(attachedIds.has(image.placement_id), false);
  }
  assert.equal(
    flows
      .flatMap((flow) => flow.source_content.pages.flatMap((page) => page.nodes))
      .filter((node) => node.text.trim()).length,
    3323,
  );
  assert.equal(
    flows.flatMap((flow) => flow.source_content.pages.flatMap((page) => page.connectors)).length,
    1579,
  );
});

test("production offline cache covers every illustration, font, and app file", async () => {
  const output = new URL("../dist/", import.meta.url);
  const worker = await readFile(new URL("sw.js", output), "utf8");
  const files = JSON.parse(worker.match(/const FILES = (\[[^\n]*\]);/u)[1]);
  const assets = await readdir(new URL("assets/", output));
  assert.equal(assets.filter((name) => name.endsWith(".png")).length, 97);
  assert.ok(
    assets.some((name) => name.endsWith(".woff2")),
    "Fonts must be bundled locally",
  );
  for (const asset of assets)
    assert.ok(files.includes("./assets/" + asset), "Missing offline asset: " + asset);
  assert.ok(files.includes("./index.html"));
  for (const asset of assets.filter((name) => name.endsWith(".css"))) {
    const css = await readFile(new URL("assets/" + asset, output), "utf8");
    assert.doesNotMatch(css, /https?:\/\//u);
  }
  const html = await readFile(new URL("index.html", output), "utf8");
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/u);
});

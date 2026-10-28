import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Deployment uses the committed web bundle, without neighboring source projects.
const library = JSON.parse(
  await readFile(new URL("../web/src/data/library.json", import.meta.url), "utf8"),
);
const { catalog, flows, provenance } = library;
assert.equal(Object.keys(catalog.procedures).length, 111);
assert.equal(Object.keys(flows).length, 116);
assert.equal(catalog.entry_policy, "one-original-procedure-file-per-age");
assert.equal(provenance.kind, "fresh-visio-extraction");

const listed = [];
for (const [age, items] of Object.entries(catalog.age_groups)) {
  for (const item of items) {
    const record = catalog.procedures[item.procedure_id];
    assert.ok(record, "Missing procedure: " + item.procedure_id);
    assert.equal(record.age_group, age);
    const flow = flows[record.path];
    assert.ok(flow, "Missing flow: " + record.path);
    const entry = item.entry_node_id ?? flow.pages[0]?.entry_node_id;
    assert.ok(
      flow.pages.some((page) => page.nodes.some((node) => node.id === entry)),
      "Invalid entry: " + item.id,
    );
    listed.push(item.procedure_id);
  }
}
assert.deepEqual(listed.sort(), Object.keys(catalog.procedures).sort());

const mediaIds = new Set();
for (const flow of Object.values(flows)) {
  const media = [
    ...flow.pages.flatMap((page) => page.nodes.flatMap((node) => node.media ?? [])),
    ...(flow.unassigned_media ?? []),
  ];
  for (const item of media) {
    assert.match(item.asset_id, /^img-[a-f0-9]{16}$/u);
    assert.equal(item.url, "/media/" + item.asset_id + ".png");
    mediaIds.add(item.asset_id);
  }
}
assert.equal(mediaIds.size, 97);
const originals = new Map(provenance.original_media.map((item) => [item.asset_id, item]));
const registry = await readFile(new URL("../web/src/data/media.ts", import.meta.url), "utf8");
for (const id of mediaIds) {
  const image = await readFile(
    new URL("../web/src/assets/pathways/" + id + ".png", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(image).digest("hex"),
    originals.get(id)?.bundled_sha256,
    "Illustration differs from the audited extraction: " + id,
  );
  assert.ok(registry.includes('from "../assets/pathways/' + id + '.png";'));
  assert.ok(registry.includes('"/media/' + id + '.png":'));
}
console.log(
  "Verified standalone website content: 111 procedures, 116 flows, and 97 exact illustrations.",
);

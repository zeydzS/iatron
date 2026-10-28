import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const library = JSON.parse(
  await readFile(new URL("../../mobile/src/data/library.json", import.meta.url), "utf8"),
);
const ages = { infant: "Infant", child: "Child", adolescent: "Adolescent", adult: "Adult" };

test("age lists match every individual original Visio file exactly once", async () => {
  assert.equal(library.catalog.entry_policy, "one-original-procedure-file-per-age");
  const allProcedures = [];
  for (const [age, folder] of Object.entries(ages)) {
    const directory = new URL(
      "../../first_aid_visio_original/0%20-%20First%20aid/" + folder + "/",
      import.meta.url,
    );
    const files = (await readdir(directory)).filter((name) => name.endsWith(".vsdx"));
    const expected = files.map((name) =>
      name.replace(/\s+[-\u2013\u2014]\s+(Adult|Adolescent|Child|Infant)\s+(FA|AF)\.vsdx$/iu, ""),
    );
    const items = library.catalog.age_groups[age];
    assert.deepEqual(
      items.map((item) => item.label).sort(),
      expected.sort(),
      age + " must have the original filenames, without extra symptom aliases or missing files",
    );
    assert.equal(new Set(items.map((item) => item.procedure_id)).size, files.length);
    for (const item of items) {
      const record = library.catalog.procedures[item.procedure_id];
      const flow = library.flows[record.path];
      assert.equal(record.age_group, age);
      assert.equal(record.title, item.label);
      assert.equal(flow.source.relative_path, item.source.relative_path);
      assert.equal(flow.source.sha256, item.source.sha256);
      const original = new URL(
        "../../first_aid_visio_original/" +
          item.source.relative_path.split("/").map(encodeURIComponent).join("/"),
        import.meta.url,
      );
      const bytes = await readFile(original);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), item.source.sha256);
      const nodes = flow.pages.flatMap((page) => page.nodes);
      const entry = nodes.find((node) => node.id === item.entry_node_id);
      assert.ok(entry, "Procedure must open an existing source step: " + item.id);
      assert.equal(entry.source.original_shape_id, item.source.entry_shape_id);
      assert.ok(flow.pages.some((page) => page.entry_node_ids.includes(entry.id)));
      allProcedures.push(item.procedure_id);
    }
  }
  assert.deepEqual(allProcedures.sort(), Object.keys(library.catalog.procedures).sort());
});

test("Child lists all 29 procedure files while symptom choices remain inside source flows", () => {
  const items = library.catalog.age_groups.child;
  assert.equal(items.length, 29);
  assert.equal(
    items.some((item) => /^(Severe )?Headache$/iu.test(item.label)),
    false,
  );
  for (const title of ["Asthma", "Stroke", "Hypoglycaemia", "Control of life-threatening bleeding"])
    assert.ok(
      items.some((item) => item.label === title),
      "Missing original procedure: " + title,
    );
  const concussion = items.find((item) => item.label === "Concussion");
  const flow = library.flows[library.catalog.procedures[concussion.procedure_id].path];
  const entry = flow.pages
    .flatMap((page) => page.nodes)
    .find((node) => node.id === concussion.entry_node_id);
  assert.equal(entry.text.split("\n")[0].trim(), "Concussion");
  const menu = Object.values(library.flows).find(
    (flow) =>
      flow.age_group === "child" && /Menu.+Child FA\.vsdx$/u.test(flow.source.relative_path),
  );
  const symptoms = menu.pages.flatMap((page) =>
    page.nodes.flatMap((node) => node.input?.options ?? []),
  );
  assert.equal(symptoms.length, 86);
  assert.ok(symptoms.some((option) => option.label.split("\n")[0] === "Headache"));
});

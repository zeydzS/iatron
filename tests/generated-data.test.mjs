import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("current corpus content is represented without patient data", async () => {
  const report = await readJson("../generated/build-report.json");
  assert.equal(report.flow_count, 116);
  assert.equal(report.current_source_hash_count, 116);
  assert.equal(report.catalog_procedure_count, 111);
  assert.equal(report.menu_choice_count, 322);
  assert.equal(report.canonical_asset_count, 97);
  assert.equal(report.source_semantic_node_count, 3323);
  assert.equal(report.represented_semantic_node_count, 3323);
  assert.equal(report.missing_semantic_node_count, 0);
  assert.equal(report.source_connector_count, 1579);
  assert.equal(report.source_image_placement_count, 1004);
  assert.equal(report.guided_image_placement_count, 1004);
  assert.equal(report.resolved_branch_code_count, 253);
  assert.equal(report.unresolved_branch_code_count, 1);
  assert.equal(report.all_flows_matched_current_corpus, true);
  assert.equal(report.patient_data_included, false);
});

test("catalog exposes guided procedures and no diagram endpoints", async () => {
  const catalog = await readJson("../generated/public/data/catalog.json");
  assert.equal(Object.keys(catalog.procedures).length, 111);
  for (const procedure of Object.values(catalog.procedures)) {
    assert.match(procedure.path, /^\/flows\/[a-z0-9-]+\.json$/u);
    assert.equal("full_scheme_path" in procedure, false);
  }
});

test("every generated flow has valid deterministic routes and exact associated media", async () => {
  const directory = new URL("../generated/flows/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 116);
  const mediaIds = new Set();
  let placements = 0;
  for (const file of files) {
    const flow = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    const nodes = flow.pages.flatMap((page) => page.nodes);
    const ids = new Set(nodes.map((node) => node.id));
    assert.equal(ids.size, nodes.length);
    for (const page of flow.pages) assert.ok(ids.has(page.entry_node_id));
    for (const node of nodes) {
      assert.match(node.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
      if (node.next) assert.ok(ids.has(node.next));
      for (const destination of Object.values(node.input?.combination_routes ?? {}))
        assert.ok(ids.has(destination));
      for (const option of node.input?.options ?? [])
        if (option.go_to) assert.ok(ids.has(option.go_to));
      for (const media of node.media ?? []) {
        assert.match(media.url, /^\/media\/img-[a-f0-9]{16}\.png$/u);
        mediaIds.add(media.asset_id);
        placements += 1;
      }
    }
  }
  assert.equal(mediaIds.size, 97);
  assert.equal(placements, 1004);
});

test("only the source-ambiguous opioid branch remains unresolved", async () => {
  const review = await readJson("../generated/development/route-review.json");
  const unresolved = review.items.filter((item) => item.status.startsWith("unresolved"));
  assert.deepEqual(
    unresolved.map(({ procedure_id, choice_source_shape_id, result_code, status }) => ({
      procedure_id,
      choice_source_shape_id,
      result_code,
      status,
    })),
    [
      {
        procedure_id: "adult-opiate-or-opioid-poisoning",
        choice_source_shape_id: "3337",
        result_code: "1",
        status: "unresolved_no_source_router",
      },
    ],
  );
});

test("representative multi-branch procedure preserves every semantic item and image", async () => {
  const completeness = await readJson("../generated/development/source-completeness.json");
  const procedure = completeness.procedures.find(
    (item) =>
      item.procedure_id === "adolescent-abdominal-pain-breathing-difficulties-and-clammy-skin",
  );
  assert.ok(procedure);
  assert.equal(procedure.missing_semantic_nodes.length, 0);
  assert.equal(procedure.represented_semantic_node_count, procedure.source_semantic_node_count);
  assert.equal(procedure.guided_image_placement_count, procedure.source_image_placement_count);
  const flow = await readJson(
    "../generated/flows/adolescent-abdominal-pain-breathing-difficulties-and-clammy-skin.json",
  );
  const choices = flow.pages.flatMap((page) => page.nodes).filter((node) => node.input);
  assert.ok(
    choices.some(
      (node) => new Set(node.input.options.map((option) => option.go_to).filter(Boolean)).size >= 3,
    ),
  );
});

test("front end is guided-only and does not truncate source lines", async () => {
  const source = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CompleteScheme|full_scheme|blockscheme|diagram viewer/iu);
  assert.doesNotMatch(source, /split\("\\n"\)\.slice/gu);
  assert.match(source, /<TextContent text=\{current\.text\}/u);
  assert.match(source, /Review path/u);
  assert.match(source, /Restart/u);
});

test("every picture placement has an auditable source attachment", async () => {
  const report = await readJson("../generated/development/media-association-review.json");
  assert.equal(report.items.length, 1004);
  assert.ok(report.summary.repaired > 0);
  const repaired = report.items.find(
    (item) =>
      item.procedure_id === "adolescent-abnormally-pale-skin-body-is-floppy-and-rigid" &&
      item.source_image_shape_id === "34",
  );
  assert.equal(repaired.attached_text_shape_id, "5022");
  assert.equal(repaired.status, "repaired");
  const flow = await readJson(
    "../generated/flows/adolescent-abnormally-pale-skin-body-is-floppy-and-rigid.json",
  );
  const step = flow.pages
    .flatMap((page) => page.nodes)
    .find((node) => node.source.original_shape_id === "5022");
  assert.ok(step.media.some((media) => media.source_image_shape_id === "34"));
});

test("combined source branch exposes previously unreachable instructions", async () => {
  const flow = await readJson(
    "../generated/flows/adolescent-abnormally-pale-skin-body-is-floppy-and-rigid.json",
  );
  const nodes = flow.pages.flatMap((page) => page.nodes);
  const choice = nodes.find((node) => node.source.original_shape_id === "5183");
  const expected = nodes.find((node) => node.source.original_shape_id === "5022");
  assert.equal(choice.input.combination_routes.AB, expected.id);
  assert.notEqual(choice.input.options[0].go_to, expected.id);
});

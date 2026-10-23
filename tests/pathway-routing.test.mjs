import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

for (const [name, path] of [
  ["mobile", "../../mobile/src/content.ts"],
  ["web", "../web/src/main.tsx"],
]) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functionNode = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "FindChoice",
  );
  assert.ok(functionNode, name + " routing helper must exist");
  const estimateNode = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "estimateRemaining",
  );
  const estimateSource = estimateNode.getText(ast);
  const compiled = ts.transpileModule(
    functionNode.getText(ast) +
      "\n" +
      (estimateSource.startsWith("export") ? estimateSource : "export " + estimateSource),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    },
  ).outputText;
  const { FindChoice, estimateRemaining } = await import(
    "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
  );
  test(name + " honors exact combined source routes and preserves uncertainty", () => {
    const node = {
      next: null,
      input: {
        combination_routes: { AB: "combined-step" },
        options: [
          { id: "a", result_codes: ["A"], go_to: "a-step" },
          { id: "b", result_codes: ["B"], go_to: "b-step" },
          { id: "c", result_codes: ["C"], go_to: "c-step" },
          { id: "none", result_codes: ["0"], go_to: "none-step" },
        ],
      },
    };
    assert.equal(FindChoice(node, ["b", "a"]), "combined-step");
    assert.equal(FindChoice(node, ["a"]), "a-step");
    assert.equal(FindChoice(node, ["none"]), "none-step");
    assert.equal(FindChoice(node, ["a", "c"]), undefined);
    assert.equal(FindChoice({ next: "next", input: null }, []), "next");
    assert.equal(FindChoice({ next: null, input: null }, []), null);
    const nodes = new Map([
      ["question", { ...node, id: "question" }],
      ["a-step", { id: "a-step", next: null, input: null }],
      ["b-step", { id: "b-step", next: null, input: null }],
      ["c-step", { id: "c-step", next: null, input: null }],
      ["none-step", { id: "none-step", next: null, input: null }],
      ["combined-step", { id: "combined-step", next: "last", input: null }],
      ["last", { id: "last", next: null, input: null }],
    ]);
    assert.equal(estimateRemaining("question", nodes), 3);
  });
}

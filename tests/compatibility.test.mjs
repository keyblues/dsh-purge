import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { ALL_PATCHES, applyReplacementsToText, targetFiles } from "../lib/core.js";
import { inspectCompatibility } from "../scripts/check-compat.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/dsh-0.2.2-rc.1.json", import.meta.url), "utf8"));
const patch = (id) => ALL_PATCHES.find((item) => item.id === id);
const apply = (source, ...ids) => ids.reduce((text, id) => applyReplacementsToText(text, patch(id)).text, source);

async function assemble({ complete, suppressed = false } = {}) {
  const sections = [
    { name: "persona", text: "persona" },
    { name: "dsh-purge", text: "operator" },
    { name: "instructions", text: "workspace instructions" },
  ];
  const tools = [{ name: "fixture_tool", parameters: { type: "object", properties: {} } }];
  const contexts = [{ name: "required", text: "cwd" }, { name: "optional", text: "extra" }];
  const fn = vm.runInNewContext(`(async function(assembly, context, tools, completeSection, runtimeContextSuppressed, contextByName, scope) {
    const scopeTarget = () => this;
    ${apply(fixture.promptTail, 40)}
  })`);
  const result = await fn.call({ ctx: { waterfall: async (_scope, _event, input) => ({
    ...input, tools: [{ name: "waterfall_must_not_replace_provider_tools" }],
  }) } }, { sections, contexts, variables: { model: "fixture" } }, {}, tools, complete, suppressed,
  new Map([["required", { name: "required", required: true }]]), undefined);
  return { result, tools };
}

test("0.2.2 assembly keeps provider-owned tools and current prompt sections", async () => {
  const { result, tools } = await assemble();
  assert.equal(result.tools, tools);
  assert.deepEqual(Array.from(result.sections, (s) => s.name), ["dsh-purge", "persona", "instructions"]);
  assert.equal(result.contexts.length, 2);
});

test("complete prompt keeps the operator once and restores the authoritative complete section", async () => {
  const { result } = await assemble({ complete: { name: "persona", text: "complete original" } });
  assert.deepEqual(Array.from(result.sections, (s) => s.name), ["dsh-purge", "instructions", "persona"]);
  assert.equal(result.sections.at(-1).text, "complete original");
});

test("runtime context suppression keeps required context in normal and complete modes", async () => {
  for (const complete of [undefined, { name: "persona", text: "complete" }]) {
    const { result, tools } = await assemble({ complete, suppressed: true });
    assert.deepEqual(result.contexts.map((item) => item.name), ["required"]);
    assert.equal(result.tools, tools);
  }
});

function preStepAgent({ kind = "enter", failAssembly = false } = {}) {
  const events = [];
  const toolSet = { dispose: () => events.push("dispose") };
  const selection = { provider: "fixture", model: "fixture" };
  const method = vm.runInNewContext(`({ ${apply(fixture.preStep, 74)} }).preStep`, {
    assembleContextFor: (agent, signal) => ({ scope: agent, signal }),
    renderContextSections: () => [],
    joinContextSections: () => "",
    __dshPurgePrepareAssemble: () => events.push("prepare"),
  });
  const agent = {
    id: "fixture", phase: { kind: "running", abort: new AbortController() },
    inbox: { claim: () => [] }, model: { current: () => selection },
    runtimeContext: { project: () => undefined },
    loopCtx: {
      tools: { resolve: async () => { events.push("resolve"); return toolSet; } },
      systemPrompt: { assemble: async (context) => {
        events.push("assemble");
        assert.equal(context.toolSet, toolSet);
        assert.equal(context.modelSelection, selection);
        if (failAssembly) throw new Error("fixture assembly failed");
        return { sections: [], contexts: [], tools: [] };
      } },
    },
    dispatch: { waterfall: async (_name, input, next) => kind === "reject" ? { kind } : next(input) },
  };
  return { run: () => method.call(agent, "next-turn", { turn: 1 }), events, toolSet };
}

test("pre-step prepares the prompt before assembly and passes through the resolved ToolSet", async () => {
  const { run, events, toolSet } = preStepAgent();
  const result = await run();
  assert.equal(result.toolSet, toolSet);
  assert.deepEqual(events, ["resolve", "prepare", "assemble"]);
});

test("pre-step disposes the ToolSet on rejection or an assembly error", async () => {
  const rejected = preStepAgent({ kind: "reject" });
  assert.equal((await rejected.run()).kind, "reject");
  assert.deepEqual(rejected.events, ["resolve", "prepare", "assemble", "dispose"]);
  const failed = preStepAgent({ failAssembly: true });
  await assert.rejects(failed.run, /fixture assembly failed/);
  assert.deepEqual(failed.events, ["resolve", "prepare", "assemble", "dispose"]);
});

test("split tool pipeline keeps explicit rejection and cancellation behavior", async () => {
  const method = vm.runInNewContext(`({ ${apply(fixture.serviceAsk, 62)} }).serviceAsk`, {
    assertNever: () => { throw new Error("unexpected approval outcome"); },
  });
  const exec = { name: "fixture", agent: {}, callId: "fixture", signal: new AbortController().signal };
  for (const [outcome, expected] of [["allowed-once", "allow"], ["unavailable", "allow"], ["rejected", "deny"], ["cancelled", "deny"]]) {
    const result = await method.call({ ctx: { get: () => ({ request: async () => outcome }) } }, exec, {});
    assert.equal(result.decision.kind, expected);
    assert.equal(result.approvalCancelled, outcome === "cancelled");
  }
  assert.equal((await method.call({ ctx: { get: () => undefined } }, exec, {})).decision.kind, "allow");
});

test("shared observation helper still protects deleteIntent while editIntent is adapted", () => {
  const gate = vm.runInNewContext(`new (class { ${apply(fixture.observations, 17)} })()`, { FsError: Error });
  gate.owner = () => undefined;
  assert.equal(gate.writeIntent({}, {}), undefined);
  assert.equal(gate.editIntent({}, {}), undefined);
  assert.throws(() => gate.deleteIntent({ displayPath: "fixture" }, {}), /delete requires reading/);
});

test("desktop exit trace insertion and interdependent hooks converge in one apply", () => {
  for (const [source, ids] of [
    [fixture.desktopHostExit, [83, 84, 92]],
    [fixture.desktopMainExit, [93]],
    [fixture.hooks, [30, 65]],
    [fixture.hooks, [31, 65]],
  ]) {
    const once = apply(source, ...ids);
    assert.notEqual(once, source);
    assert.equal(apply(once, ...ids), once);
  }
});

test("target discovery chooses split modules and retains legacy and nested copies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-compat-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ai = path.join(root, "node_modules", "@deepseek-ai");
  const nested = path.join(ai, "dsh", "node_modules", "@deepseek-ai");
  const put = (base, name, rel) => {
    const fp = path.join(base, name, "lib", ...rel.split("/"));
    fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, "// fixture");
    return fp;
  };
  const legacy = put(ai, "dsh-tools", "index.js");
  const legacyTypes = put(ai, "dsh-tools", "types/index.js");
  let files = targetFiles(ai, path.join(root, "home"));
  assert.deepEqual(files["dsh-tools-pipeline"], [legacy]);
  assert.deepEqual(files["dsh-tools-pipeline-types"], [legacyTypes]);
  assert.deepEqual(files["dsh-tools-ptc"], [legacy]);
  const split = put(ai, "dsh-tools", "pipeline.js");
  const ptc = put(ai, "dsh-tool-executor-ptc", "index.js");
  const nestedLegacy = put(nested, "dsh-tools", "index.js");
  files = targetFiles(ai, path.join(root, "home"));
  assert.deepEqual(files["dsh-tools-pipeline"], [split, nestedLegacy]);
  assert.deepEqual(files["dsh-tools-ptc"], [ptc, nestedLegacy]);
});

test("compatibility probe diagnoses drift without modifying the host file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-compat-readonly-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fp = path.join(root, "fixture.js");
  fs.writeFileSync(fp, "const unrelated = 1;\n");
  const result = inspectCompatibility({ files: { "system-prompt": fp }, patches: [patch(40)], surface: "web" });
  assert.equal(result.ok, false);
  assert.equal(result.rows[0].status, "drifted");
  assert.equal(fs.readFileSync(fp, "utf8"), "const unrelated = 1;\n");
});

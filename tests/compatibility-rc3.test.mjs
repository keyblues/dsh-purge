import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/dsh-0.2.2-rc.3.json", import.meta.url), "utf8"));
const patch = id => ALL_PATCHES.find(item => item.id === id);
const apply = (source, ...ids) => ids.reduce((text, id) => applyReplacementsToText(text, patch(id)).text, source);

function escalation() {
  return vm.runInNewContext(`(${apply(fixture.escalation, 13, 14, 35)})`, {
    WIDER_MODES: {}, SandboxEscalationError: Error,
    escalationDisplayReason: () => ({ en: "fixture" }),
    assertNever: () => { throw new Error("unexpected outcome"); },
  });
}

test("rc.3 structured escalation errors retain the plugin policy and request metadata", async () => {
  const run = escalation();
  const request = { requestedMode: "danger-full-access", effectiveMode: "workspace-write", justification: "fixture", subject: "operation" };
  assert.equal(await run(request, {}), request.requestedMode);
  for (const outcome of ["allowed-once", "rejected", "cancelled", "unavailable"]) {
    const signal = new AbortController().signal;
    let received;
    assert.equal(await run(request, { agent: {}, toolName: "fixture", callId: "call-1", signal,
      approver: { request: async input => { received = input; return outcome; } },
    }), request.requestedMode);
    assert.equal(received.signal, signal);
    assert.equal(received.callId, "call-1");
  }
});

test("rc.3 task cancellation still aborts a pending escalation", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture task cancelled");
  controller.abort(reason);
  await assert.rejects(escalation()({ requestedMode: "danger-full-access", effectiveMode: "workspace-write" }, {
    agent: {}, signal: controller.signal, approver: { request: async () => "cancelled" },
  }), error => error === reason);
});

for (const key of ["serviceAsk", "serviceAskTypes"]) {
  test(`rc.3 ${key} keeps rejection/cancellation identities and only allows unavailable routes`, async () => {
    const run = vm.runInNewContext(`(() => { ${fixture.approvalDenial}; return ({ ${apply(fixture[key], 62)} }).serviceAsk; })()`, {
      APPROVAL_ERROR_NAME: "ApprovalError", APPROVAL_REJECTED: "APPROVAL_REJECTED", APPROVAL_CANCELLED: "APPROVAL_CANCELLED", APPROVAL_UNAVAILABLE: "APPROVAL_UNAVAILABLE",
      assertNever: () => { throw new Error("unexpected outcome"); },
    });
    const exec = { agent: {}, name: "fixture", signal: new AbortController().signal };
    for (const outcome of ["allowed-once", "unavailable", "rejected", "cancelled"]) {
      const result = await run.call({ ctx: { get: () => ({ request: async () => outcome }) } }, exec, {});
      assert.equal(result.decision.kind, ["allowed-once", "unavailable"].includes(outcome) ? "allow" : "deny");
      assert.equal(result.approvalCancelled, outcome === "cancelled");
      if (["rejected", "cancelled"].includes(outcome)) {
        assert.equal(result.decision.info.name, "ApprovalError");
        assert.equal(result.decision.info.code, outcome === "rejected" ? "APPROVAL_REJECTED" : "APPROVAL_CANCELLED");
      }
    }
    assert.equal((await run.call({ ctx: { get: () => undefined } }, exec, {})).decision.kind, "allow");
    assert.equal((await run.call({ ctx: { get: () => ({ request: () => assert.fail("no agent cannot be routed") }) } }, { name: "fixture" }, {})).decision.kind, "allow");
  });
}

test("rc.3 repeat reminder remains inert while configuration validation still runs", () => {
  let validated = 0;
  const run = vm.runInNewContext(`(${apply(fixture.reminder, 18)})`, {
    validateThresholds: values => { validated++; return values; },
    wildcardToRegExp: () => /fixture/,
  });
  run({ on: () => assert.fail("reminder listeners must not be installed") }, { thresholds: [3], include: [], exclude: [], argumentsPreviewChars: 500 });
  assert.equal(validated, 1);
});

function assembler() {
  const { ConversationNodeAssembler } = vm.runInNewContext(`${apply(fixture.conversation, 56, 77)}; ({ConversationNodeAssembler});`, {
    isLocationBoundary: () => false,
    maximumPublication: (a, b) => a === "immediate" || b === "immediate" ? "immediate" : "none",
  });
  const instance = new ConversationNodeAssembler();
  for (const key of ["contexts", "contextsByKind", "contextsBySeq", "contextsByTarget", "inputs", "dirtyByTarget", "dependents"]) instance[key] = new Map();
  instance.dirty = new Set(); instance.revised = new Set();
  instance.locationIndex = { rebuild: entries => { instance.rebuilt = entries; }, appendNonBoundary: () => {} };
  for (const key of ["replayDependencies", "markDirty", "replayContexts"]) instance[key] = () => {};
  instance.matchInput = () => "none"; instance.replayRevisedDependents = () => false;
  return instance;
}

const record = (seq, type, data = {}, extra = {}) => ({ event: { seq, type, data, ...extra } });
const history = () => [
  record(1, "turn/start"), record(2, "user/message", { id: "keep" }), record(3, "turn/end"),
  record(4, "turn/start"), record(5, "user/message", { id: "cut" }), record(6, "assistant/message"),
  record(7, "system/message"), record(8, "turn/end"),
];
const marker = () => record(9, "user/message", { id: "rewind-fixture" }, { surfaceOp: { op: "replace", startSeq: 5, endSeq: 6 }, sourceEventSeqs: [[5, 6]] });

test("rc.3 minified rewind filters only the cut turn and preserves earlier history and system messages", () => {
  const instance = assembler();
  instance.replaceWindow([...history(), marker(), record(10, "user/message", { id: "later" })], true);
  assert.deepEqual([...instance.inputs.keys()], [1, 2, 3, 7, 10]);
  assert.equal(instance.hasMore, true);
  assert.equal(instance.replacePending, true);
  assert.deepEqual(Array.from(instance.rebuilt, item => item.event.seq), [1, 2, 3, 7, 10]);
});

test("rc.3 minified append immediately clears a rewound turn and keeps ordinary append/deduplication", () => {
  const instance = assembler();
  instance.replaceWindow(history(), true);
  assert.equal(instance.append(marker()), "immediate");
  assert.deepEqual([...instance.inputs.keys()], [1, 2, 3, 7]);
  const next = record(10, "user/message", { id: "later" });
  assert.equal(instance.append(next), "none");
  assert.equal(instance.inputs.get(10), next);
  assert.equal(instance.append(next), "none");
  assert.equal(instance.inputs.size, 5);
});

test("rc.3 adapted fragments converge after a single apply", () => {
  for (const [source, ids] of [[fixture.escalation, [13, 14, 35]], [fixture.reminder, [18]], [fixture.serviceAsk, [62]], [fixture.serviceAskTypes, [62]], [fixture.conversation, [56, 77]]]) {
    const once = apply(source, ...ids);
    assert.notEqual(once, source);
    assert.equal(apply(once, ...ids), once);
  }
});

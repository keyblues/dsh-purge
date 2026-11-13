import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import vm from "node:vm";
import { checkUpdate, dedupeVersionEntries, listedUpdateRef, markCurrent, pluginRoot, resolveApplyRef } from "../lib/update.js";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const entries = () => [
  { id: "main", ref: "main", channel: "stable", version: "1.1.94", sha, kind: "head", latest: true },
  { id: "v1.1.94", ref: "v1.1.94", channel: "stable", version: "1.1.94", sha, kind: "tag" },
];

test("a branch and release tag for the same build produce one option", () => {
  const rows = entries();
  const original = structuredClone(rows);
  const result = dedupeVersionEntries(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].ref, "main");
  assert.equal(result[0].latest, true);
  assert.deepEqual(result[0].aliases, ["main", "v1.1.94"]);
  assert.deepEqual(rows, original);
  assert.deepEqual(dedupeVersionEntries(result), result);
});

test("history and short commit IDs merge with the same tagged build", () => {
  const tag = entries()[1];
  const result = dedupeVersionEntries([{ ...tag, kind: "history", ref: sha.slice(0, 7), sha: sha.slice(0, 7) }, tag]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ref, "v1.1.94");
  assert.ok(result[0].aliases.includes(sha.slice(0, 7)));
});

test("different commits or channels are not silently collapsed", () => {
  assert.equal(dedupeVersionEntries([entries()[0], { ...entries()[1], sha: otherSha }]).length, 2);
  assert.equal(dedupeVersionEntries([entries()[0], { ...entries()[1], channel: "beta" }]).length, 2);
  assert.equal(dedupeVersionEntries([entries()[0], { ...entries()[1], sha: "" }]).length, 2);
});

test("a pinned tag still marks the merged build current and remains addressable", () => {
  const rows = dedupeVersionEntries(entries());
  const marked = markCurrent(rows, { channel: "stable", pin: "v1.1.94" }, "1.1.94", sha);
  assert.equal(marked.filter((row) => row.current).length, 1);
  assert.equal(listedUpdateRef("main", { versions: rows }), "main");
  assert.equal(listedUpdateRef("v1.1.94", { versions: rows }), "v1.1.94");
  assert.equal(listedUpdateRef("v9.9.9", { versions: rows }), "");
  assert.equal(listedUpdateRef("../../main", { versions: rows }), "");
});

test("legacy stable update requests follow main and explicit tags remain fixed", () => {
  assert.equal(resolveApplyRef({ ref: "master", channel: "stable" }, { channel: "stable" }), "main");
  assert.equal(resolveApplyRef({}, { channel: "stable" }), "main");
  assert.equal(resolveApplyRef({ ref: "v1.1.94" }, { channel: "stable" }), "v1.1.94");
  assert.equal(resolveApplyRef({}, { channel: "beta" }), "beta");
  assert.equal(resolveApplyRef({ channel: "beta" }, { channel: "stable" }), "beta");
  assert.equal(resolveApplyRef({ ref: "../main" }, { channel: "stable" }), "");
});

const client = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
function clientFunction(name) {
  const start = client.indexOf(`\t\tfunction ${name}(`);
  assert.ok(start >= 0, `missing client function ${name}`);
  const end = client.indexOf("\n\t\tfunction ", start + 1);
  return vm.runInNewContext(`(${client.slice(start, end)})`);
}

test("the real client update payload follows the server's lane instead of master", () => {
  const request = clientFunction("channelUpdateRequest");
  const payload = (id, info) => JSON.parse(JSON.stringify(request(id, info)));
  assert.deepEqual(payload("stable", { lanes: { stable: { ref: "main" } } }), { op: "apply", channel: "stable", ref: "main" });
  assert.deepEqual(payload("stable", null), { op: "apply", channel: "stable" });
  assert.deepEqual(payload("beta", null), { op: "apply", channel: "beta", ref: "beta" });
  assert.deepEqual(payload("stable", { lanes: { stable: { ref: "release" } } }), { op: "apply", channel: "stable", ref: "release" });
});

test("the dropdown selects tag aliases and distinguishes separate builds", () => {
  const prefer = clientFunction("preferListed");
  const label = clientFunction("versionChoiceLabel");
  const rows = dedupeVersionEntries(entries());
  assert.equal(prefer(rows, "1.1.93", "v1.1.94").ref, "main");
  assert.equal(label(rows[0], (key) => key, rows), "v1.1.94 · update.tip");
  const separate = [entries()[0], { ...entries()[1], sha: otherSha }];
  assert.match(label(separate[0], (key) => key, separate), /aaaaaaa/);
  assert.match(label(separate[1], (key) => key, separate), /bbbbbbb/);
});

test("update check returns one latest version with old tags still available", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-update-list-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (fp, ...args) {
    if (String(fp) === path.join(pluginRoot(), "package.json")) return JSON.stringify({ name: "dsh-purge", version: "1.1.93" });
    return read.call(this, fp, ...args);
  });
  t.mock.method(https, "request", (url, _options, callback) => {
    const address = String(url);
    let status = 200;
    let body;
    if (address.includes("/commits/main")) body = JSON.stringify({ sha });
    else if (address.includes("/commits/beta")) { status = 404; body = "{}"; }
    else if (address.includes("/tags?")) body = JSON.stringify([
      { name: "v1.1.94", commit: { sha } },
      { name: "v1.1.93", commit: { sha: otherSha } },
    ]);
    else if (address.includes("package.json")) body = JSON.stringify({ version: "1.1.94" });
    else if (address.endsWith(".atom")) body = "<feed></feed>";
    else throw new Error(`unexpected network request: ${address}`);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = {};
      callback(response);
    });
    return req;
  });
  const result = await checkUpdate();
  assert.equal(result.hasUpdate, true);
  assert.equal(result.lanes.stable.ref, "main");
  assert.equal(result.versions.filter((row) => row.version === "1.1.94").length, 1);
  assert.equal(result.versions.filter((row) => row.version === "1.1.93").length, 1);
  assert.equal(result.versions.find((row) => row.version === "1.1.93").current, true);
  assert.equal(listedUpdateRef("v1.1.94", result), "v1.1.94");
});

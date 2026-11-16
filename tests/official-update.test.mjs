import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const template = fs.readFileSync(new URL("../lib/official-update.wscript", import.meta.url), "utf8");
function transaction({ fails = false } = {}) {
  const install = "C:\\Apps\\DeepSeek Harness";
  const temp = "C:\\Temp";
  const exe = install + "\\DeepSeek Harness.exe";
  const resources = install + "\\resources";
  const asar = resources + "\\app.asar";
  const app = resources + "\\app";
  const norm = value => value.replace(/\\+/g, "\\").toLowerCase();
  const files = new Map([[norm(exe), 100], [norm(asar + ".bak"), 200]]);
  const folders = new Set([norm(app)]);
  const logs = [], commands = [];
  const fso = {
    GetSpecialFolder: index => { assert.equal(index, 2); return { Path: temp }; },
    FileExists: value => files.has(norm(value)), FolderExists: value => folders.has(norm(value)),
    GetFile: value => ({ Size: files.get(norm(value)), DateLastModified: "fixture" }),
    CopyFile: (from, to) => files.set(norm(to), files.get(norm(from))),
    DeleteFile: value => files.delete(norm(value)),
    MoveFolder: (from, to) => { assert.ok(folders.delete(norm(from))); folders.add(norm(to)); },
    DeleteFolder: value => folders.delete(norm(value)),
    OpenTextFile: () => ({ WriteLine: value => logs.push(value.replace(/^[^ ]+ /, "")), Close() {} }),
    CreateTextFile: value => ({ WriteLine: () => files.set(norm(value), 1), Close() {} }),
  };
  const environment = { Remove() {} };
  const shell = {
    CurrentDirectory: install,
    Environment: () => environment,
    Run: command => {
      commands.push({ command, cwd: shell.CurrentDirectory });
      if (command.startsWith('"C:\\Temp\\installer.exe"')) {
        // Windows refuses directory promotion while a helper/installer holds
        // the destination as its working directory (ERROR_SHARING_VIOLATION).
        if (shell.CurrentDirectory === install || fails) return 2;
        files.set(norm(exe), 101); files.set(norm(asar), 201);
      }
      return 0;
    },
  };
  const placeholders = { EXE: exe, INSTALLER: temp + "\\installer.exe", RESOURCES: resources, INSTALL_DIR: install, LOG: temp + "\\update.log" };
  let source = template;
  for (const [key, value] of Object.entries(placeholders)) source = source.replaceAll(`__${key}_JSON__`, JSON.stringify(value));
  vm.runInNewContext(source, {
    ActiveXObject: function (name) { return name === "Scripting.FileSystemObject" ? fso : shell; },
    GetObject: () => ({ ExecQuery: () => [] }),
    Enumerator: function () { this.atEnd = () => true; },
    WScript: { Sleep() {} },
  });
  return { commands, logs, files, folders, norm, app, asar, resources, temp };
}

test("the official directory installer runs outside the application root and promotes the new version", () => {
  const result = transaction();
  assert.ok(result.commands.every(item => item.cwd === result.temp));
  assert.ok(result.logs.includes("installer 0"));
  assert.ok(result.logs.includes("started"));
  assert.equal(result.files.has(result.norm(result.resources + "\\dsh-purge-reapply-asar")), true);
  assert.equal(result.files.get(result.norm(result.asar)), 201);
});

test("a failed official update restores the original patched directory and reopens it", () => {
  const result = transaction({ fails: true });
  assert.ok(result.logs.includes("installer 2"));
  assert.ok(result.logs.includes("installer-plain 2"));
  assert.ok(result.logs.includes("restored-app"));
  assert.ok(result.logs.includes("started-old"));
  assert.equal(result.folders.has(result.norm(result.app)), true);
  assert.equal(result.files.has(result.norm(result.asar)), false);
  assert.equal(result.files.get(result.norm(result.asar + ".bak")), 200);
});

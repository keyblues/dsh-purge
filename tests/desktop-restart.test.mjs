import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restart-test-"));
const savedEnv = { ...process.env };
process.env.TEMP = root;
process.env.TMPDIR = root;
process.env.DSH_HOME = path.join(root, "home");
process.env.DSH_DESKTOP_INSTALL = path.join(root, "install");
const desktop = await import("../lib/desktop.js");
after(() => {
  process.env = savedEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeWorker(t) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 123456;
  child.unref = () => {};
  t.mock.method(childProcess, "spawn", (...args) => { calls.push(args); return child; });
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("WSH unavailable"); });
  t.mock.method(process, "exit", () => assert.fail("the host must not exit before its worker"));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { calls, child };
}

test("a slow archive-swap worker never triggers a host exit or a competing runtime restart", (t) => {
  const { calls } = fakeWorker(t);
  const runtime = { requestRestart: () => assert.fail("runtime must not race the archive worker") };
  const result = desktop.scheduleAsarSwapRestart({
    exe: path.join(root, "DeepSeek Harness.exe"), asar: path.join(root, "resources/app.asar"),
    exit: true, runtime,
  });
  assert.equal(result.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(typeof calls[0][2].stdio[2], "number", "worker errors survive host shutdown in a log file");
  t.mock.timers.tick(30_000);
});

test("worker startup and exit failures are logged without crashing the host", (t) => {
  const { child } = fakeWorker(t);
  desktop.scheduleAsarSwapRestart({ exe: path.join(root, "DeepSeek Harness.exe"), asar: path.join(root, "app.asar"), exit: true });
  assert.doesNotThrow(() => child.emit("error", new Error("restart-test-ENOENT")));
  child.emit("exit", 1, null);
  t.mock.timers.tick(30_000);
  const log = fs.readFileSync(path.join(root, "dsh-purge-desktop.log"), "utf8");
  assert.match(log, /spawn failed: restart-test-ENOENT/);
  assert.match(log, /exited code=1/);
});

test("the unpacked Windows restart also leaves shutdown to the worker", { skip: process.platform !== "win32" }, (t) => {
  const { calls } = fakeWorker(t);
  const exe = path.join(root, "install", "DeepSeek Harness.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "fixture");
  const result = desktop.restartOfficialHarness({ exe, requireClean: false, exit: true });
  assert.equal(result.restarting, true);
  assert.equal(result.mode, "unpacked-helper");
  assert.equal(JSON.parse(calls[0][2].env.DSH_PURGE_RESTART).killApp, true);
  t.mock.timers.tick(30_000);
});

test("the Node helper swaps the archive and stops the shell before a host returned first by WMI", { skip: process.platform !== "win32" }, () => {
  const dir = path.join(root, "node-helper");
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "DeepSeek Harness.exe");
  const app = path.join(dir, "resources", "app");
  const asar = path.join(dir, "resources", "app.asar");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ main: "main.js" }));
  fs.writeFileSync(path.join(app, "main.js"), "// ready");
  fs.writeFileSync(asar, "original archive");
  fs.writeFileSync(asar + ".rename-pending", "pending");
  const events = path.join(dir, "events.txt");
  const preload = path.join(dir, "preload.mjs");
  const rows = [`200|100|${exe}`, `100|1|${exe}`, `999|1|${dir}-other/DeepSeek Harness.exe`].join("\n");
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + '\\n');
cp.execFileSync = () => ${JSON.stringify(rows)};
cp.spawn = (command) => { record(command === ${JSON.stringify(exe)} ? 'start' : 'focus-helper'); const child = new EventEmitter(); child.unref = () => {}; return child; };
process.kill = (pid, signal) => { if (signal !== 0) record('stop:' + pid); };
syncBuiltinESMExports();
`);
  const helper = fileURLToPath(new URL("../lib/restart-desktop.js", import.meta.url));
  const result = childProcess.spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, helper], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, DSH_PURGE_RESTART: JSON.stringify({ execPath: exe, asar, cwd: dir, killApp: true, respawn: true }) },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(fs.readFileSync(events, "utf8").trim().split(/\r?\n/), ["stop:100", "stop:200", "stop:100", "stop:200", "start", "focus-helper"]);
  assert.equal(fs.existsSync(asar), false);
  assert.equal(fs.readFileSync(asar + ".bak", "utf8"), "original archive");
  assert.equal(fs.existsSync(asar + ".rename-pending"), false);
});

test("the real PowerShell worker reaches its preflight without DETACHED_PROCESS", { skip: process.platform !== "win32" }, async () => {
  const dir = path.join(root, "real-spawn");
  const app = path.join(dir, "resources", "app");
  const exe = path.join(dir, "DeepSeek Harness.exe");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(exe, "fixture");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ main: "missing.js" }));
  const log = path.join(root, "dsh-purge-desktop.log");
  const offset = fs.existsSync(log) ? fs.statSync(log).size : 0;
  desktop.schedulePowerShellAsarSwapRestart({ exe, asar: path.join(dir, "resources", "app.asar"), exit: true });
  const deadline = Date.now() + 10_000;
  let tail = "";
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      tail = fs.existsSync(log) ? fs.readFileSync(log).subarray(offset).toString("utf8") : "";
    } catch (error) {
      if (!["EBUSY", "ENOENT"].includes(error.code)) throw error;
    }
  } while (!tail.includes("Unpacked desktop entry is missing") && Date.now() < deadline);
  assert.match(tail, /begin helperPid=/);
  assert.match(tail, /Unpacked desktop entry is missing/);
});

const quotePS = (text) => "'" + text.replace(/'/g, "''") + "'";
function runSwapFixture(name, { noEntry = false, noWmi = false, renameFails = false, foreignArchive = false, exitedHandles = false } = {}) {
  const dir = path.join(root, name, "中文安装目录");
  const exe = path.join(dir, "DeepSeek Harness.exe");
  const asar = path.join(dir, "resources", "app.asar");
  const app = path.join(dir, "resources", "app");
  const events = path.join(dir, "events.txt");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(exe, "fixture");
  fs.writeFileSync(asar, "original archive");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ main: "main.js" }));
  if (!noEntry) fs.writeFileSync(path.join(app, "main.js"), "// ready");
  const script = path.join(dir, "worker.ps1");
  fs.writeFileSync(script, "\uFEFF" + desktop.ASAR_SWAP_PS1);
  const harness = path.join(dir, "harness.ps1");
  fs.writeFileSync(harness, "\uFEFF" + `
$ErrorActionPreference = 'Stop'
$global:events = ${quotePS(events)}
$global:fixtureExe = ${quotePS(exe)}
$global:alive = @{ 200 = $true; 100 = $true; 999 = $true }
$global:exited = @{}
function global:Get-CimInstance {
  ${noWmi ? "throw 'fixture WMI failure'" : ""}
  @(
    [pscustomobject]@{ ProcessId=200; ParentProcessId=100; ExecutablePath=$global:fixtureExe; CommandLine='--expose-internals host.js' }
    [pscustomobject]@{ ProcessId=100; ParentProcessId=1; ExecutablePath=$global:fixtureExe; CommandLine='desktop' }
    [pscustomobject]@{ ProcessId=999; ParentProcessId=1; ExecutablePath=($global:fixtureExe.Replace('中文安装目录', '中文安装目录-other')); CommandLine='foreign' }
  ) | Where-Object { $global:alive[[int]$_.ProcessId] }
}
function global:Get-Process {
  param([int]$Id)
  if ($global:alive[$Id]) { [pscustomobject]@{ Id=$Id; HasExited=$false } }
  ${exitedHandles ? "elseif ($global:exited[$Id]) { [pscustomobject]@{ Id=$Id; HasExited=$true } }" : ""}
}
function global:Stop-Process {
  param([int]$Id, [switch]$Force)
  Add-Content -LiteralPath $global:events -Value ('stop:' + $Id)
  if ($Id -eq 999) { throw 'foreign process selected' }
  $global:alive.Remove($Id)
  $global:exited[$Id] = $true
}
function global:Wait-Process { param([int]$Id, [int]$Timeout) }
function global:Start-Sleep { param([int]$Milliseconds) }
function global:Start-Process {
  param([string]$FilePath, [string]$WorkingDirectory)
  Add-Content -LiteralPath $global:events -Value 'start'
}
${renameFails ? "function global:Move-Item { param($LiteralPath, $Destination, [switch]$Force) throw 'fixture archive lock' }" : ""}
$global:LASTEXITCODE = 0
& ${quotePS(script)} -WaitPid 200 -AsarPath ${quotePS(foreignArchive ? path.join(root, "foreign", "resources", "app.asar") : asar)} -ExePath ${quotePS(exe)}
exit $LASTEXITCODE
`);
  const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
    encoding: "utf8", windowsHide: true, timeout: 25_000, env: { ...process.env, TEMP: dir },
  });
  return {
    result, asar, events: fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split(/\r?\n/) : [],
    log: fs.readFileSync(path.join(dir, "dsh-purge-desktop.log"), "utf8"),
  };
}

test("Windows PowerShell swaps the archive, stops the shell first, and leaves other installs alone", { skip: process.platform !== "win32" }, () => {
  const { result, asar, events, log } = runSwapFixture("success");
  assert.equal(result.status, 0, result.stderr || result.error?.message || log);
  assert.deepEqual(events, ["stop:100", "stop:200", "start"]);
  assert.equal(fs.existsSync(asar), false);
  assert.equal(fs.readFileSync(asar + ".bak", "utf8"), "original archive");
  assert.match(log, /begin helperPid=/);
  assert.match(log, /moved asar -> bak \(verified\)/);
});

test("an exited process whose handle still exists does not block the archive swap", { skip: process.platform !== "win32" }, () => {
  const { result, asar, events, log } = runSwapFixture("exited-handles", { exitedHandles: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || log);
  assert.deepEqual(events, ["stop:100", "stop:200", "start"]);
  assert.equal(fs.existsSync(asar), false);
});

for (const [name, options, reason] of [
  ["no-wmi", { noWmi: true }, /fixture WMI failure/],
  ["no-entry", { noEntry: true }, /Unpacked desktop entry is missing/],
  ["foreign-archive", { foreignArchive: true }, /Archive does not belong/],
]) {
  test(`Windows restart preserves the running app on ${name}`, { skip: process.platform !== "win32" }, () => {
    const { result, asar, events, log } = runSwapFixture(name, options);
    assert.equal(result.status, 1, result.stderr || result.error?.message || log);
    assert.deepEqual(events, []);
    assert.equal(fs.readFileSync(asar, "utf8"), "original archive");
    assert.match(log, reason);
  });
}

test("an archive lock after stopping the app relaunches the original and records the failure", { skip: process.platform !== "win32" }, () => {
  const { result, asar, events, log } = runSwapFixture("locked", { renameFails: true });
  assert.equal(result.status, 1, result.stderr || result.error?.message || log);
  assert.deepEqual(events, ["stop:100", "stop:200", "start"]);
  assert.equal(fs.readFileSync(asar, "utf8"), "original archive");
  assert.match(log, /failed: fixture archive lock/);
});

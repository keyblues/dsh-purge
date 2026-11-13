/**
 * Read-only compatibility probe against an installed or extracted DSH runtime.
 * Simulates every patch in memory, checks the final state and a second apply,
 * and asks Node to parse the resulting JavaScript. Never calls applyPatches.
 *
 * node scripts/check-compat.mjs --base <node_modules/@deepseek-ai> --surface desktop
 *   --desktop-shell <resources/app/lib/main.js> --home <isolated-home> --json
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fsFor } from "../lib/extract-asar.js";
import { detectSurface } from "../lib/surface.js";
import * as core from "../lib/core.js";

const pathsOf = (value) => [...new Set([value].flat().filter(Boolean))];
const keysOf = (patch) => [patch.file].flat();

function transform(text, patch, fp) {
  const result = core.applyReplacementsToText(text, patch, fp);
  return {
    ...result,
    text: /\.ya?ml$/i.test(fp) ? core.sanitizeYamlPersonaScalars(result.text) : result.text,
  };
}

/** Exported for integration checks using real release artifacts. All writes stay in memory. */
export function inspectCompatibility({ files, patches = core.ALL_PATCHES, surface, checkSyntax = true }) {
  const originals = new Map();
  const contents = new Map();
  const errors = [];
  const active = patches.filter((patch) => core.patchAppliesHere(patch, surface));
  const patchPaths = new Map();
  for (const patch of active) {
    const paths = [...new Set(keysOf(patch).flatMap((key) => pathsOf(files[key])))];
    const existing = [];
    for (const fp of paths) {
      const fs = fsFor(fp);
      if (!fs.existsSync(fp)) continue;
      existing.push(fp);
      try {
        if (!contents.has(fp)) {
          const text = fs.readFileSync(fp, "utf8");
          originals.set(fp, text);
          contents.set(fp, text);
        }
        const result = transform(contents.get(fp), patch, fp);
        if (result.hitMismatch) errors.push({ kind: "hit_count_mismatch", ...result.hitMismatch });
        contents.set(fp, result.text);
      } catch (error) {
        errors.push({ kind: "read_or_transform", patch_id: patch.id, file: fp, error: String(error) });
      }
    }
    patchPaths.set(patch.id, existing);
  }
  const rows = active.map((patch) => {
    const outcomes = patchPaths.get(patch.id).filter((fp) => contents.has(fp)).map((fp) => ({
      path: fp,
      before: core.filePatchOutcome(originals.get(fp), patch, fp),
      after: core.filePatchOutcome(contents.get(fp), patch, fp),
    }));
    return {
      id: patch.id,
      name: patch.name,
      optional: patch.optional === true,
      status: outcomes.length ? core.rollupDisplayStatus(outcomes.map((item) => item.after)) : "missing_file",
      files: outcomes,
    };
  });
  // A full second pass catches interactions between patches, as well as a
  // single replacement repeatedly matching its own inserted text.
  const second = new Map(contents);
  const unstable = new Set();
  for (const patch of active) {
    for (const fp of patchPaths.get(patch.id)) {
      if (!second.has(fp)) continue;
      const result = transform(second.get(fp), patch, fp);
      if (result.text !== second.get(fp)) unstable.add(patch.id);
      if (result.hitMismatch) errors.push({ kind: "second_pass_hit_count_mismatch", ...result.hitMismatch });
      second.set(fp, result.text);
    }
  }
  for (const id of unstable) errors.push({ kind: "not_idempotent", patch_id: id });
  if (checkSyntax) for (const [fp, text] of contents) {
    if (fp.endsWith(".js") || fp.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: text,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) errors.push({ kind: "javascript_syntax", file: fp, error: String(result.error || result.stderr) });
    } else if (fp.endsWith(".json")) {
      try { JSON.parse(text); }
      catch (error) { errors.push({ kind: "json_syntax", file: fp, error: String(error) }); }
    }
  }
  const unresolved = rows.filter((row) => row.status === "drifted" || row.status === "pending" || row.status === "unmatched");
  const summary = {
    patches: rows.length,
    ready: rows.filter((row) => row.status === "applied").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    missing: rows.filter((row) => row.status === "missing_file").length,
    unresolved: unresolved.length,
    files: contents.size,
    changed_files: [...contents].filter(([fp, text]) => text !== originals.get(fp)).length,
    errors: errors.length,
  };
  return { ok: contents.size > 0 && unresolved.length === 0 && errors.length === 0, summary, rows, errors, contents };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--json" || key === "--help") options[key.slice(2)] = true;
    else if (["--base", "--home", "--surface", "--desktop-shell"].includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[key.slice(2)] = args[++i];
    } else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  if (options.help) {
    console.log("Usage: node scripts/check-compat.mjs [--base <@deepseek-ai directory>] [--home <DSH_HOME>] [--surface web|desktop] [--desktop-shell <main.js>] [--json]\nSimulates patches, parses JavaScript/JSON and checks repeat application without writing host files. Exit code 1 means unresolved compatibility; 2 means invalid input.");
    return;
  }
  if (options.surface && !["web", "desktop"].includes(options.surface)) throw new Error("--surface must be web or desktop");
  if (options.surface) process.env.DSH_SURFACE = options.surface;
  if (options.home) process.env.DSH_HOME = path.resolve(options.home);
  if (options.base) process.env.DSH_BASE = path.resolve(options.base);
  core.resetPathMemo();
  const base = options.base ? path.resolve(options.base) : core.findAiBase();
  if (!base) throw new Error("DSH runtime not found. Pass --base <node_modules/@deepseek-ai>.");
  const surface = options.surface || detectSurface();
  const home = options.home ? path.resolve(options.home) : core.findDshHome();
  const files = core.targetFiles(base, home);
  if (options["desktop-shell"]) files["desktop-shell"] = path.resolve(options["desktop-shell"]);
  if (!files["system-prompt"] || !files["agent-loop"]) throw new Error("--base must contain the DSH system-prompt and agent-loop runtime packages.");
  const host = core.hostCompat(base);
  const result = inspectCompatibility({ files, surface });
  const { contents, ...report } = result;
  report.ok = result.ok && host.ok === true;
  report.host = host;
  report.base = base;
  report.surface = surface;
  report.home = home;
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`DSH ${host.host || "unknown"} / ${surface}; declared: ${host.target}`);
    console.log(JSON.stringify(report.summary));
    for (const row of report.rows.filter((item) => ["drifted", "pending", "unmatched"].includes(item.status))) {
      console.log(`#${row.id} ${row.name}: ${row.status}`);
      for (const file of row.files.filter((item) => item.after !== "applied")) console.log(`  ${file.after}: ${file.path}`);
    }
    for (const error of report.errors) console.log(JSON.stringify(error));
    console.log(report.ok ? "PASS: simulated patches are stable and JavaScript/JSON parses." : "FAIL: inspect unresolved patches, errors, or the host version declaration.");
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`check-compat: ${error.message || error}`);
    process.exitCode = 2;
  }
}

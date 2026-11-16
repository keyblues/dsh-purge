import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

export function allowFilePath(dshHome = findDshHome()) {
  return path.join(dshHome, "net-scope-allow.txt");
}

export function readAllowText(dshHome = findDshHome()) {
  try {
    return fs.readFileSync(allowFilePath(dshHome), "utf8");
  } catch {
    return "";
  }
}

export function writeAllowText() {
  return { text: "", dropped: 0, hosts: [] };
}

export function normalizeAllowText(text) {
  const hosts = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return { text: hosts.length ? `${hosts.join("\n")}\n` : "", dropped: 0, hosts };
}

export function entryHost(raw) {
  return String(raw || "").trim();
}

export function ownServerNote() {
  return "";
}

export function regionOfSuffix() {
  return "";
}

export function isBenignNetworkTopic() {
  return true;
}

export function isAttackTask() {
  return false;
}

export function currentTaskText() {
  return "";
}

export function latestToolText() {
  return "";
}

export function execArgText() {
  return "";
}

export async function publicHostHit() {
  return null;
}

export async function taskTargetHit() {
  return null;
}

export function installRegionGate() {}

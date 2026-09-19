import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const DEFAULTS = Object.freeze({
  url: "https://daisukedaisuke.github.io/tool/font_akinator_webgpu.html",
  chrome_path: "",
  headless: false,
  startup_timeout_ms: 30000,
  file_timeout_ms: 60000,
  command_timeout_ms: 600000,
  profile_root: ".font-teacher/profiles",
  download_root: ".font-teacher/downloads"
});

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }
    if (ch === "#" && quote === null) return line.slice(0, i);
  }
  return line;
}

function findAssignment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }
    if (ch === "=" && quote === null) return i;
  }
  return -1;
}

function parseValue(raw, lineNumber) {
  const value = raw.trim();
  if (!value) throw new Error(`TOML line ${lineNumber}: value is empty`);
  if (value[0] === "'" && value[value.length - 1] === "'") return value.slice(1, -1);
  if (value[0] === '"' && value[value.length - 1] === '"') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`TOML line ${lineNumber}: invalid quoted string: ${error.message}`);
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value.replaceAll("_", ""));
  if (Number.isFinite(number)) return number;
  throw new Error(`TOML line ${lineNumber}: unsupported value ${value}`);
}

function ensureTable(root, parts, lineNumber) {
  let cursor = root;
  for (const part of parts) {
    if (!part) throw new Error(`TOML line ${lineNumber}: empty table segment`);
    const existing = cursor[part];
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      throw new Error(`TOML line ${lineNumber}: ${part} is already a scalar value`);
    }
    if (existing === undefined) cursor[part] = {};
    cursor = cursor[part];
  }
  return cursor;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      table = ensureTable(root, name.split(".").map((part) => part.trim()), lineNumber);
      continue;
    }
    const equals = findAssignment(line);
    if (equals < 1) throw new Error(`TOML line ${lineNumber}: expected key = value`);
    const key = line.slice(0, equals).trim();
    if (!key) throw new Error(`TOML line ${lineNumber}: key is empty`);
    if (Object.hasOwn(table, key)) throw new Error(`TOML line ${lineNumber}: duplicate key ${key}`);
    table[key] = parseValue(line.slice(equals + 1), lineNumber);
  }
  return root;
}

export function decodeUtf8(buffer, label = "file") {
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      throw new Error(`${label} is UTF-16. This MCP accepts UTF-8 only.`);
    }
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function absoluteFrom(baseDir, value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const candidate = value.trim();
  return path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate));
}

function optionalAbsoluteFrom(baseDir, value) {
  if (!value) return "";
  const candidate = String(value).trim();
  return path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate));
}

function basenamePortable(filePath) {
  const win = path.win32.basename(filePath);
  const posix = path.posix.basename(filePath);
  return win.length < posix.length ? win : posix;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function normalizeMcpPath(value, name = "path") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty path`);
  return path.normalize(path.resolve(value.trim()));
}

export function resolveConfig(raw, configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const baseDir = path.dirname(absoluteConfigPath);
  const merged = { ...DEFAULTS, ...raw };
  if (typeof merged.url !== "string" || !merged.url.trim()) throw new Error("url must be a non-empty string");
  if (typeof merged.headless !== "boolean") throw new Error("headless must be boolean");
  const configTables = raw.configs;
  if (!configTables || typeof configTables !== "object" || Array.isArray(configTables)) {
    throw new Error("At least one [configs.NAME] table is required");
  }
  const entries = Object.entries(configTables);
  if (!entries.length) throw new Error("At least one [configs.NAME] table is required");
  const configs = new Map();
  for (const [name, value] of entries) {
    if (!name || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`configs.${name || "<empty>"} must be a TOML table`);
    }
    const ttfPath = absoluteFrom(baseDir, value.ttf_path, `configs.${name}.ttf_path`);
    const jsonPath = absoluteFrom(baseDir, value.json_path, `configs.${name}.json_path`);
    configs.set(name, Object.freeze({
      name,
      ttfPath,
      jsonPath,
      ttfFile: basenamePortable(ttfPath),
      jsonFile: basenamePortable(jsonPath)
    }));
  }
  return Object.freeze({
    configPath: absoluteConfigPath,
    url: merged.url.trim(),
    chromePath: optionalAbsoluteFrom(baseDir, merged.chrome_path),
    headless: merged.headless,
    startupTimeoutMs: positiveInteger(merged.startup_timeout_ms, "startup_timeout_ms"),
    fileTimeoutMs: positiveInteger(merged.file_timeout_ms, "file_timeout_ms"),
    commandTimeoutMs: positiveInteger(merged.command_timeout_ms, "command_timeout_ms"),
    profileRoot: absoluteFrom(baseDir, merged.profile_root, "profile_root"),
    downloadRoot: absoluteFrom(baseDir, merged.download_root, "download_root"),
    configs
  });
}

export async function loadConfig(configPath) {
  const absolute = path.resolve(configPath);
  const text = decodeUtf8(await readFile(absolute), absolute);
  return resolveConfig(parseToml(text), absolute);
}
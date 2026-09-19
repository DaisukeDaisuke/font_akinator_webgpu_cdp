import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { ChromeSession } from "./chrome-session.js";
import { loadConfig, normalizeMcpPath } from "./config.js";

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function regularFile(filePath, label) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
}

export class TeacherHarness {
  constructor({ configPath, sessionFactory = (config) => new ChromeSession(config) }) {
    this.configPath = configPath;
    this.sessionFactory = sessionFactory;
    this.session = null;
    this.sessionKey = null;
    this.generateActive = false;
  }

  async #load() {
    return await loadConfig(this.configPath);
  }

  async listConfigs() {
    const config = await this.#load();
    return {
      configs: [...config.configs.values()].map((item) => ({
        name: item.name,
        ttf_file: item.ttfFile,
        json_file: item.jsonFile
      }))
    };
  }

  async #sessionFor(config) {
    const key = JSON.stringify({
      url: config.url,
      chromePath: config.chromePath,
      headless: config.headless,
      profileRoot: config.profileRoot,
      downloadRoot: config.downloadRoot
    });
    if (this.session && this.sessionKey !== key) {
      await this.session.close();
      this.session = null;
    }
    if (!this.session) {
      this.session = this.sessionFactory(config);
      this.sessionKey = key;
    }
    return this.session;
  }

  async #closeSession() {
    const session = this.session;
    this.session = null;
    this.sessionKey = null;
    await session?.close();
  }

  async generate({ config: configName, source_png: sourcePng, char_count: charCount, output_path: outputPath }) {
    if (this.generateActive) throw new Error("generate_teacher_png is already running");
    this.generateActive = true;
    try {
      if (typeof configName !== "string" || !configName) throw new Error("config is required");
      if (!Number.isSafeInteger(charCount) || charCount < 1 || charCount > 256) throw new Error("char_count must be an integer from 1 to 256");
      const sourcePath = normalizeMcpPath(sourcePng, "source_png");
      const destinationPath = normalizeMcpPath(outputPath, "output_path");
      if (path.extname(sourcePath).toLowerCase() !== ".png") throw new Error("source_png must end with .png");
      if (path.extname(destinationPath).toLowerCase() !== ".png") throw new Error("output_path must end with .png");
      await regularFile(sourcePath, "source_png");
      if (await exists(destinationPath)) throw new Error(`Output destination already exists: ${destinationPath}`);
      const root = await this.#load();
      const selected = root.configs.get(configName);
      if (!selected) throw new Error(`Unknown config: ${configName}`);
      await regularFile(selected.ttfPath, `configs.${configName}.ttf_path`);
      await regularFile(selected.jsonPath, `configs.${configName}.json_path`);
      const session = await this.#sessionFor(root);
      await session.loadInputs({
        ttfPath: selected.ttfPath,
        jsonPath: selected.jsonPath,
        samplePath: sourcePath
      });
      const metrics = await session.runMatch(charCount);
      const saved = await session.downloadOutputPng(destinationPath);
      return {
        ok: true,
        path: saved.path,
        bytes: saved.bytes,
        recognized_text: metrics.recognized_text,
        overall_match_percent: metrics.overall_match_percent,
        image: metrics.image,
        per_character: metrics.per_character
      };
    } finally {
      try {
        await this.#closeSession();
      } finally {
        this.generateActive = false;
      }
    }
  }

  async close() {
    await this.#closeSession();
  }
}
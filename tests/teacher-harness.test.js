import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TeacherHarness } from "../src/teacher-harness.js";

test("generate normalizes MCP paths, returns recognized characters, and closes Chrome after download", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "font-teacher-harness-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "font.ttf"), Buffer.from([0]));
  await writeFile(path.join(assets, "glyphs.json"), "{}", "utf8");
  await writeFile(path.join(directory, "source.png"), Buffer.from([1]));
  const configPath = path.join(directory, "font-teacher.toml");
  await writeFile(configPath, `
url = 'https://example.test/font.html'
profile_root = '.profiles'
download_root = '.downloads'
[configs.main]
ttf_path = 'assets/font.ttf'
json_path = 'assets/glyphs.json'
`, "utf8");
  const calls = [];
  let closeCount = 0;
  const fakeSession = {
    async loadInputs(input) {
      calls.push({ loadInputs: input });
    },
    async runMatch(charCount) {
      calls.push({ runMatch: charCount });
      return {
        recognized_text: "A",
        overall_match_percent: 99,
        image: { match_percent: 99, diff_pixels: 2 },
        per_character: [{ index: 1, character: "A", match_percent: 98, diff_pixels: 3 }]
      };
    },
    async downloadOutputPng(destinationPath) {
      calls.push({ downloadOutputPng: destinationPath });
      return { path: destinationPath, bytes: 456 };
    },
    async close() {
      calls.push({ close: true });
      closeCount++;
    }
  };
  const harness = new TeacherHarness({ configPath, sessionFactory: () => fakeSession });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sourceWithDotSegments = path.join(directory, "assets", "..", "source.png");
  const outputWithDotSegments = path.join(directory, "generated", "..", "teacher.png");
  const result = await harness.generate({
    config: "main",
    source_png: sourceWithDotSegments,
    char_count: 1,
    output_path: outputWithDotSegments
  });
  assert.deepEqual(calls, [
    {
      loadInputs: {
        ttfPath: path.join(assets, "font.ttf"),
        jsonPath: path.join(assets, "glyphs.json"),
        samplePath: path.join(directory, "source.png")
      }
    },
    { runMatch: 1 },
    { downloadOutputPng: path.join(directory, "teacher.png") },
    { close: true }
  ]);
  assert.deepEqual(result, {
    ok: true,
    path: path.join(directory, "teacher.png"),
    bytes: 456,
    recognized_text: "A",
    overall_match_percent: 99,
    image: { match_percent: 99, diff_pixels: 2 },
    per_character: [{ index: 1, character: "A", match_percent: 98, diff_pixels: 3 }]
  });
  assert.equal(closeCount, 1);
});

test("generate closes Chrome when generation fails", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "font-teacher-harness-failure-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "font.ttf"), Buffer.from([0]));
  await writeFile(path.join(assets, "glyphs.json"), "{}", "utf8");
  await writeFile(path.join(directory, "source.png"), Buffer.from([1]));
  const configPath = path.join(directory, "font-teacher.toml");
  await writeFile(configPath, `
url = 'https://example.test/font.html'
profile_root = '.profiles'
download_root = '.downloads'
[configs.main]
ttf_path = 'assets/font.ttf'
json_path = 'assets/glyphs.json'
`, "utf8");
  let closeCount = 0;
  const fakeSession = {
    async loadInputs() {},
    async runMatch() {
      throw new Error("matcher failed");
    },
    async close() {
      closeCount++;
    }
  };
  const harness = new TeacherHarness({ configPath, sessionFactory: () => fakeSession });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(() => harness.generate({
    config: "main",
    source_png: path.join(directory, "source.png"),
    char_count: 1,
    output_path: path.join(directory, "teacher.png")
  }), /matcher failed/u);
  assert.equal(closeCount, 1);
});
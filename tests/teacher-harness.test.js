import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TeacherHarness } from "../src/teacher-harness.js";

test("generate normalizes MCP paths, uses TOML TTF/JSON, and returns metrics only", async (t) => {
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
  const fakeSession = {
    async loadInputs(input) {
      calls.push({ loadInputs: input });
    },
    async runMatch(charCount) {
      calls.push({ runMatch: charCount });
      return {
        image: { match_percent: 99, diff_pixels: 2 },
        per_character: [{ index: 1, match_percent: 98, diff_pixels: 3 }]
      };
    },
    async downloadOutputPng(destinationPath) {
      calls.push({ downloadOutputPng: destinationPath });
      return { path: destinationPath, bytes: 456 };
    },
    async close() {}
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
    { downloadOutputPng: path.join(directory, "teacher.png") }
  ]);
  assert.deepEqual(result, {
    ok: true,
    path: path.join(directory, "teacher.png"),
    bytes: 456,
    image: { match_percent: 99, diff_pixels: 2 },
    per_character: [{ index: 1, match_percent: 98, diff_pixels: 3 }]
  });
});
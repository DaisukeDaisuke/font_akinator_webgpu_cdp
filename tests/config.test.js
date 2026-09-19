import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decodeUtf8, parseToml, resolveConfig } from "../src/config.js";

test("multiple TOML configs resolve TTF and JSON paths and expose basenames", () => {
  const raw = parseToml(`
url = 'https://example.test/font.html'
profile_root = '.profiles'
download_root = '.downloads'
[configs.small]
ttf_path = 'fonts/small.ttf'
json_path = 'json/small.json'
[configs.large]
ttf_path = 'fonts/large.ttf'
json_path = 'json/large.json'
`);
  const configPath = path.join(process.cwd(), "fixture", "font-teacher.toml");
  const config = resolveConfig(raw, configPath);
  assert.equal(config.configs.size, 2);
  assert.equal(config.configs.get("small").ttfFile, "small.ttf");
  assert.equal(config.configs.get("small").jsonFile, "small.json");
  assert.equal(config.configs.get("large").ttfPath, path.resolve(path.dirname(configPath), "fonts", "large.ttf"));
});

test("UTF-16 config text is rejected", () => {
  assert.throws(() => decodeUtf8(Buffer.from([0xff, 0xfe, 0x61, 0x00]), "font-teacher.toml"), /UTF-16/u);
});
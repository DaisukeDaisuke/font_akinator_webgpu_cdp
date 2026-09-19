import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, TOOLS } from "../src/mcpMain.js";

test("tool inventory contains only list_config and generate_teacher_png", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ["list_config", "generate_teacher_png"]);
  const generate = TOOLS.find((tool) => tool.name === "generate_teacher_png");
  assert.deepEqual(Object.keys(generate.inputSchema.properties), ["config", "source_png", "char_count", "output_path"]);
});

test("list_config returns config name with TTF and JSON filenames", async () => {
  const fake = {
    async listConfigs() {
      return { configs: [{ name: "pixel12", ttf_file: "font12.ttf", json_file: "font12.json" }] };
    },
    async close() {}
  };
  const server = new McpServer({ harnessFactory: () => fake });
  const reply = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_config", arguments: {} } });
  assert.deepEqual(reply.result.structuredContent, { configs: [{ name: "pixel12", ttf_file: "font12.ttf", json_file: "font12.json" }] });
});

test("generate response contains recognized characters but omits internal character metadata", async () => {
  const fake = {
    async generate(args) {
      assert.deepEqual(args, { config: "pixel12", source_png: "in.png", char_count: 2, output_path: "out.png" });
      return {
        ok: true,
        path: "out.png",
        bytes: 123,
        recognized_text: "AB",
        overall_match_percent: 99.5,
        image: { match_percent: 99.5, diff_pixels: 2 },
        per_character: [
          { index: 1, character: "A", match_percent: 99.0, diff_pixels: 1 },
          { index: 2, character: "B", match_percent: 98.0, diff_pixels: 3 }
        ]
      };
    },
    async close() {}
  };
  const server = new McpServer({ harnessFactory: () => fake });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "generate_teacher_png", arguments: { config: "pixel12", source_png: "in.png", char_count: 2, output_path: "out.png" } }
  });
  assert.deepEqual(reply.result.structuredContent, {
    ok: true,
    path: "out.png",
    bytes: 123,
    recognized_text: "AB",
    overall_match_percent: 99.5,
    image: { match_percent: 99.5, diff_pixels: 2 },
    per_character: [
      { index: 1, character: "A", match_percent: 99.0, diff_pixels: 1 },
      { index: 2, character: "B", match_percent: 98.0, diff_pixels: 3 }
    ]
  });
});
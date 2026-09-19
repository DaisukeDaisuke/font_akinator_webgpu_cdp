import process from "node:process";
import { fileURLToPath } from "node:url";
import { TeacherHarness } from "./teacher-harness.js";

const SERVER_NAME = "font-teacher-cdp-mcp";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

export const TOOLS = Object.freeze([
  {
    name: "list_config",
    description: "List configured font matcher profiles and the TTF/JSON filenames assigned to each profile.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: "generate_teacher_png",
    description: "Run the configured WebGPU font matcher for a source PNG, download the generated teacher PNG through Chrome, and move it to output_path without overwriting an existing file. Returns match metrics only; recognized characters and character metadata are omitted.",
    inputSchema: objectSchema({
      config: { type: "string", minLength: 1, description: "Config name returned by list_config." },
      source_png: { type: "string", minLength: 1, description: "Source PNG path. Normalized internally." },
      char_count: { type: "integer", minimum: 1, maximum: 256, description: "Number of characters to match." },
      output_path: { type: "string", minLength: 1, description: "Destination PNG path. Normalized internally; existing files are never overwritten." }
    }, ["config", "source_png", "char_count", "output_path"])
  }
]);

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function toolError(error) {
  const value = { error: error?.message ?? String(error) };
  return {
    isError: true,
    content: [{ type: "text", text: value.error }],
    structuredContent: value
  };
}

export class McpServer {
  constructor({ configPath = "font-teacher.toml", harnessFactory = (options) => new TeacherHarness(options) } = {}) {
    this.harness = harnessFactory({ configPath });
  }

  async handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return errorResponse(null, -32600, "Invalid JSON-RPC request");
    }
    const id = Object.hasOwn(message, "id") ? message.id : null;
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      if (typeof requested !== "string") return errorResponse(id, -32602, "initialize requires protocolVersion");
      return response(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "Font Teacher CDP MCP", version: SERVER_VERSION },
        instructions: "Use list_config to choose a TOML-defined TTF/JSON profile. generate_teacher_png accepts only the profile name, source PNG, character count, and destination PNG. Generated character identities and metadata are not returned."
      });
    }
    if (message.method === "ping") return response(id, {});
    if (message.method === "tools/list") return response(id, { tools: TOOLS });
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) return errorResponse(id, -32602, `Unknown tool: ${name}`);
      try {
        if (name === "list_config") return response(id, toolResult(await this.harness.listConfigs()));
        return response(id, toolResult(await this.harness.generate(args)));
      } catch (error) {
        return response(id, toolError(error));
      }
    }
    if (id === null) return null;
    return errorResponse(id, -32601, `Method not found: ${message.method}`);
  }

  async close() {
    await this.harness.close();
  }
}

export async function runStdioMcp({ input = process.stdin, output = process.stdout, configPath = process.argv[2] || "font-teacher.toml", harnessFactory } = {}) {
  const server = new McpServer({ configPath, harnessFactory });
  let buffered = "";
  input.setEncoding?.("utf8");
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  try {
    for await (const chunk of input) {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const result = await server.handle(JSON.parse(line));
          if (result) write(result);
        } catch (error) {
          write(errorResponse(null, -32700, "Parse error", { message: String(error.message) }));
        }
      }
    }
  } finally {
    await server.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await runStdioMcp();
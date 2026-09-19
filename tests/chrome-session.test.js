import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChromeSession } from "../src/chrome-session.js";

function config(directory) {
  return {
    url: "https://example.test/font.html",
    chromePath: "",
    headless: true,
    startupTimeoutMs: 1000,
    fileTimeoutMs: 1000,
    commandTimeoutMs: 1000,
    profileRoot: path.join(directory, "profiles"),
    downloadRoot: path.join(directory, "downloads")
  };
}

test("managed PNG download moves Chrome output to a new destination", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "font-teacher-cdp-"));
  const destination = path.join(directory, "result", "teacher.png");
  const listeners = new Map();
  let downloadPath = null;
  const session = new ChromeSession(config(directory));
  session.chrome = { exitCode: null };
  session.cdp = {
    isOpen: () => true,
    onEvent(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    async send(method, params) {
      if (method === "Page.setDownloadBehavior" && params.behavior === "allow") downloadPath = params.downloadPath;
      return {};
    },
    close() {}
  };
  session.callGlobal = async () => {
    assert.ok(downloadPath);
    const fileName = "akinator_hidden-sequence.png";
    await writeFile(path.join(downloadPath, fileName), Buffer.from([1, 2, 3, 4]));
    listeners.get("Page.downloadWillBegin")({ guid: "png-guid", suggestedFilename: fileName });
    listeners.get("Page.downloadProgress")({ guid: "png-guid", state: "completed" });
    return true;
  };
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const result = await session.downloadOutputPng(destination);
  assert.equal(result.path, destination);
  assert.equal(result.bytes, 4);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4]));
});

test("managed PNG download refuses an existing destination before invoking the page", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "font-teacher-cdp-existing-"));
  const destination = path.join(directory, "teacher.png");
  await writeFile(destination, Buffer.from([9]));
  const session = new ChromeSession(config(directory));
  session.chrome = { exitCode: null };
  session.cdp = { isOpen: () => true, close() {} };
  let invoked = false;
  session.callGlobal = async () => { invoked = true; };
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(() => session.downloadOutputPng(destination), /already exists/u);
  assert.equal(invoked, false);
});
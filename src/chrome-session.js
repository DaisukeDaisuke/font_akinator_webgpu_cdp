import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { CdpClient } from "./cdp.js";

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireRegularFile(filePath, label) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  return filePath;
}

async function findChrome(configuredPath) {
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) candidates.push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
    if (programFilesX86) candidates.push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
    if (localAppData) candidates.push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) return candidate;
  }
  throw new Error("Google Chrome was not found. Set chrome_path in font-teacher.toml.");
}

async function readDevToolsPort(profileDir) {
  const text = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
  const port = Number(text.split(/\r?\n/u)[0]?.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("DevToolsActivePort contains an invalid port");
  return port;
}

async function fetchJson(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1000);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Chrome page target did not become available${lastError ? `: ${lastError.message}` : ""}`);
}

export class ChromeSession {
  constructor(config) {
    this.config = config;
    this.profileDir = path.join(config.profileRoot, "default");
    this.chrome = null;
    this.cdp = null;
    this.targetId = null;
    this.downloadActive = false;
  }

  isAlive() {
    return this.chrome?.exitCode === null && this.cdp?.isOpen() === true;
  }

  async start() {
    if (this.cdp) {
      if (this.isAlive()) return;
      throw new Error("Chrome session is no longer alive");
    }
    await mkdir(this.profileDir, { recursive: true });
    const chromePath = await findChrome(this.config.chromePath);
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ];
    if (this.config.headless) args.unshift("--headless=new");
    this.chrome = spawn(chromePath, args, { stdio: "ignore", windowsHide: true });
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let page = null;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.chrome.exitCode !== null) throw new Error(`Chrome exited during startup with code ${this.chrome.exitCode}`);
      try {
        const port = await readDevToolsPort(this.profileDir);
        page = await discoverPage(port, 250);
        if (page) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(50);
    }
    if (!page) throw new Error(`Chrome DevTools page did not become available: ${lastError?.message ?? "timeout"}`);
    this.targetId = page.id ?? null;
    this.cdp = new CdpClient(page.webSocketDebuggerUrl);
    await this.cdp.connect(this.config.startupTimeoutMs);
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("DOM.enable")
    ]);
    const navigation = await this.cdp.send("Page.navigate", { url: this.config.url }, this.config.startupTimeoutMs);
    if (navigation.errorText) throw new Error(`Page.navigate failed: ${navigation.errorText}`);
    await this.waitForFunction(
      "function(){ return document.readyState === 'complete' && typeof globalThis.matcher?.run === 'function' && typeof globalThis.matcher?.savePng === 'function'; }",
      [],
      this.config.startupTimeoutMs,
      "font matcher page API"
    );
  }

  async callGlobal(functionDeclaration, args = [], timeoutMs = this.config.commandTimeoutMs) {
    const globalObject = await this.cdp.send("Runtime.evaluate", { expression: "globalThis", returnByValue: false }, timeoutMs);
    const objectId = globalObject.result?.objectId;
    if (!objectId) throw new Error("Unable to resolve page global object");
    const response = await this.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "page evaluation failed";
      throw new Error(description);
    }
    return response.result?.value;
  }

  async waitForFunction(functionDeclaration, args, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.callGlobal(functionDeclaration, args, Math.min(3000, timeoutMs))) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(50);
    }
    throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
  }

  async setFileInput(selector, filePath, label) {
    await requireRegularFile(filePath, label);
    const remote = await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false
    }, this.config.fileTimeoutMs);
    const objectId = remote.result?.objectId;
    if (!objectId) throw new Error(`File input not found: ${selector}`);
    try {
      const described = await this.cdp.send("DOM.describeNode", { objectId }, this.config.fileTimeoutMs);
      const backendNodeId = described.node?.backendNodeId;
      if (!backendNodeId) throw new Error(`Unable to resolve file input: ${selector}`);
      await this.cdp.send("DOM.setFileInputFiles", { files: [filePath], backendNodeId }, this.config.fileTimeoutMs);
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, 2000).catch(() => {});
    }
  }

  async loadInputs({ ttfPath, jsonPath, samplePath }) {
    await this.start();
    await this.setFileInput("#ttfFile", ttfPath, "TTF");
    await this.waitForFunction(
      "function(){ return document.querySelector('#status')?.textContent === 'TTF読込完了。'; }",
      [], this.config.fileTimeoutMs, "TTF load"
    );
    await this.setFileInput("#jsonFile", jsonPath, "JSON");
    await this.waitForFunction(
      "function(){ return document.querySelector('#status')?.textContent === 'JSON読込完了。' && (globalThis.matcher?.stats()?.glyphs ?? 0) > 0; }",
      [], this.config.fileTimeoutMs, "JSON load"
    );
    await this.setFileInput("#sampleFile", samplePath, "source PNG");
    await this.waitForFunction(
      "function(){ const s=globalThis.matcher?.stats?.(); return document.querySelector('#status')?.textContent === 'PNG読込完了。' && !!s?.sample; }",
      [], this.config.fileTimeoutMs, "PNG load"
    );
  }

  async runMatch(charCount) {
    await this.callGlobal(
      "function(charCount){ globalThis.matcher.setConfig({ charCount }); return true; }",
      [charCount]
    );
    await this.callGlobal(
      "async function(){ await globalThis.matcher.run(); return true; }",
      [],
      this.config.commandTimeoutMs
    );
    return await this.callGlobal(`function(){
      const results=globalThis.matcher.results();
      const recognized=results.map((r)=>String(r.char??''));
      const canvas=document.querySelector('#outputDiffCanvas');
      if(!canvas) throw new Error('outputDiffCanvas is missing');
      const image=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;
      let bothWhite=0,outputOnly=0,inputOnly=0,bothBlack=0;
      for(let i=0;i<image.length;i+=4){
        const r=image[i],g=image[i+1],b=image[i+2];
        if(r===255&&g===255&&b===255) bothWhite++;
        else if(r===255&&g===24&&b===24) outputOnly++;
        else if(r===30&&g===80&&b===255) inputOnly++;
        else bothBlack++;
      }
      const total=bothWhite+outputOnly+inputOnly+bothBlack;
      const same=bothWhite+bothBlack;
      const overallMatchPercent=total?same*100/total:0;
      return {
        recognized_text:recognized.join(''),
        overall_match_percent:overallMatchPercent,
        image:{
          match_percent:overallMatchPercent,
          same_pixels:same,
          diff_pixels:outputOnly+inputOnly,
          total_pixels:total,
          output_only_pixels:outputOnly,
          input_only_pixels:inputOnly
        },
        per_character:results.map((r,index)=>({
          index:index+1,
          character:recognized[index],
          match_percent:Number(r.percent),
          diff_pixels:Number(r.diff)
        }))
      };
    }`);
  }

  async downloadOutputPng(destinationPath) {
    await this.start();
    if (this.downloadActive) throw new Error("Another managed Chrome download is already active");
    this.downloadActive = true;
    const absoluteDestination = path.normalize(path.resolve(destinationPath));
    const destinationDirectory = path.dirname(absoluteDestination);
    await mkdir(destinationDirectory, { recursive: true });
    if (await fileExists(absoluteDestination)) {
      this.downloadActive = false;
      throw new Error(`Output destination already exists: ${absoluteDestination}`);
    }
    await mkdir(this.config.downloadRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(this.config.downloadRoot, "teacher-"));
    let downloadGuid = null;
    let suggestedFilename = null;
    let timeout = null;
    let removeBeginListener = () => {};
    let removeProgressListener = () => {};
    try {
      const completed = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`PNG download did not complete within ${this.config.fileTimeoutMs} ms`)), this.config.fileTimeoutMs);
        removeBeginListener = this.cdp.onEvent("Page.downloadWillBegin", (event) => {
          if (downloadGuid !== null) return;
          const fileName = String(event.suggestedFilename ?? "");
          if (!fileName.toLowerCase().endsWith(".png")) return;
          if (path.basename(fileName) !== fileName) {
            reject(new Error("Chrome returned an unsafe PNG download filename"));
            return;
          }
          downloadGuid = String(event.guid ?? "");
          suggestedFilename = fileName;
          if (!downloadGuid) reject(new Error("PNG download metadata was incomplete"));
        });
        removeProgressListener = this.cdp.onEvent("Page.downloadProgress", (event) => {
          if (!downloadGuid || String(event.guid ?? "") !== downloadGuid) return;
          if (event.state === "completed") resolve();
          else if (event.state === "canceled") reject(new Error("PNG download was canceled"));
        });
      });
      await this.cdp.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: tempDirectory
      }, this.config.fileTimeoutMs);
      await this.callGlobal(
        "async function(){ await globalThis.matcher.savePng(); return true; }",
        [],
        this.config.fileTimeoutMs
      );
      await completed;
      if (!suggestedFilename) throw new Error("PNG download filename was not reported");
      let downloadedPath = path.join(tempDirectory, suggestedFilename);
      if (!await fileExists(downloadedPath)) {
        const files = (await readdir(tempDirectory)).filter((name) => !name.endsWith(".crdownload"));
        if (files.length !== 1) throw new Error("Unable to identify the completed PNG download");
        downloadedPath = path.join(tempDirectory, files[0]);
      }
      const info = await stat(downloadedPath);
      if (!info.isFile()) throw new Error("PNG download did not produce a regular file");
      await copyFile(downloadedPath, absoluteDestination, fsConstants.COPYFILE_EXCL);
      await rm(downloadedPath);
      return { path: absoluteDestination, bytes: info.size };
    } finally {
      if (timeout) clearTimeout(timeout);
      removeBeginListener();
      removeProgressListener();
      await this.cdp?.send("Page.setDownloadBehavior", { behavior: "default" }, 2000).catch(() => {});
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
      this.downloadActive = false;
    }
  }

  async close() {
    this.cdp?.close();
    this.cdp = null;
    if (this.chrome && this.chrome.exitCode === null) this.chrome.kill();
    this.chrome = null;
  }
}
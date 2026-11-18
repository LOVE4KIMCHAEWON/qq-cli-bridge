#!/usr/bin/env node
/**
 * Build the portable Windows x64 release of qq-cli-bridge.
 *
 *   npm run release:win
 *
 * Output (git-ignored):
 *   release/qq-cli-bridge-windows-x64/        staged folder
 *   release/qq-cli-bridge-windows-x64.zip     distributable archive
 *   release/qq-cli-bridge-windows-x64.zip.sha256
 *
 * Layout of the archive:
 *   QQ CLI Bridge.cmd   double-click launcher (first-run wizard + menu)
 *   qqbridge.cmd        command-line entry point
 *   runtime/node/       official Node.js (node.exe only), SHA256-verified
 *   runtime/python/     official CPython embeddable + hash-locked ddgs wheels
 *   app/                compiled Bridge (dist/), production node_modules,
 *                       DDGS helper, launcher, docs, examples
 *
 * Requirements on the BUILD machine only: Windows, Node >= 22.13 with npm,
 * a Python 3 with pip (for `pip install --target`; set PYTHON to choose),
 * network access to nodejs.org, python.org and pypi.org.
 *
 * No runtime data is ever copied: the app is compiled from src/ into a fresh
 * staging folder, dependencies are installed fresh from package-lock.json, and
 * a final scan fails the build if anything resembling credentials, databases,
 * logs or local paths is found.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.14.0";
const PYTHON_VERSION = "3.12.10";
// Published SHA256 of python-3.12.10-embed-amd64.zip (python.org SPDX SBOM:
// https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.spdx.json).
const PYTHON_EMBED_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3";

const NAME = "qq-cli-bridge-windows-x64";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const cacheDir = path.join(root, ".release-cache");
const releaseDir = path.join(root, "release");
const stage = path.join(releaseDir, NAME);
const zipPath = path.join(releaseDir, `${NAME}.zip`);
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function step(msg) {
  console.log(`\n==> ${msg}`);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(" ")}`);
}
function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  console.log(`    downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(dest + ".part", Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + ".part", dest);
  return dest;
}
function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}
function crlf(src, dest) {
  fs.writeFileSync(dest, fs.readFileSync(src, "utf8").replace(/\r?\n/g, "\r\n"));
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main() {
  if (process.platform !== "win32") throw new Error("Build on Windows (uses bundled tar.exe and win-x64 runtimes).");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(zipPath + ".sha256", { force: true });
  fs.mkdirSync(stage, { recursive: true });

  // ------------------------------------------------------------ Node.js
  step(`Node.js ${NODE_VERSION} (win-x64)`);
  const nodeZipName = `node-v${NODE_VERSION}-win-x64.zip`;
  const sums = await download(
    `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
    path.join(cacheDir, `SHASUMS256-node-${NODE_VERSION}.txt`),
  );
  const expectedNode = fs
    .readFileSync(sums, "utf8")
    .split("\n")
    .find((l) => l.trim().endsWith(nodeZipName))
    ?.split(/\s+/)[0];
  if (!expectedNode) throw new Error(`No checksum for ${nodeZipName}`);
  const nodeZip = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeZipName}`, path.join(cacheDir, nodeZipName));
  if (sha256File(nodeZip) !== expectedNode) throw new Error("Node.js zip checksum mismatch");
  console.log("    checksum OK (nodejs.org SHASUMS256.txt)");
  const nodeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqb-node-"));
  const inner = `node-v${NODE_VERSION}-win-x64`;
  run(TAR, ["-xf", nodeZip, "-C", nodeTmp, `${inner}/node.exe`, `${inner}/LICENSE`]);
  fs.mkdirSync(path.join(stage, "runtime", "node"), { recursive: true });
  fs.copyFileSync(path.join(nodeTmp, inner, "node.exe"), path.join(stage, "runtime", "node", "node.exe"));
  fs.copyFileSync(path.join(nodeTmp, inner, "LICENSE"), path.join(stage, "runtime", "node", "LICENSE"));
  fs.rmSync(nodeTmp, { recursive: true, force: true });

  // ------------------------------------------------------------ Python + ddgs
  step(`Python ${PYTHON_VERSION} embeddable (amd64) + ddgs`);
  const pyZipName = `python-${PYTHON_VERSION}-embed-amd64.zip`;
  const pyZip = await download(`https://www.python.org/ftp/python/${PYTHON_VERSION}/${pyZipName}`, path.join(cacheDir, pyZipName));
  if (sha256File(pyZip) !== PYTHON_EMBED_SHA256) throw new Error("Python embeddable zip checksum mismatch");
  console.log("    checksum OK (python.org SBOM)");
  const pyDir = path.join(stage, "runtime", "python");
  fs.mkdirSync(pyDir, { recursive: true });
  run(TAR, ["-xf", pyZip, "-C", pyDir]);
  const pthName = fs.readdirSync(pyDir).find((f) => /^python\d+\._pth$/.test(f));
  if (!pthName) throw new Error("python*._pth not found in embeddable package");
  const pthPath = path.join(pyDir, pthName);
  fs.writeFileSync(pthPath, fs.readFileSync(pthPath, "utf8").replace(/\r?\n?$/, "\r\nLib\\site-packages\r\n"));
  const sitePackages = path.join(pyDir, "Lib", "site-packages");
  const hostPython = process.env.PYTHON || "python";
  run(hostPython, [
    "-m", "pip", "install",
    "--disable-pip-version-check", "--no-input", "--no-compile", "--no-deps",
    "--require-hashes", "--only-binary=:all:",
    "--platform", "win_amd64", "--python-version", PYTHON_VERSION.split(".").slice(0, 2).join("."),
    "--implementation", "cp",
    "--target", sitePackages,
    "-r", path.join(here, "requirements-ddgs.lock.txt"),
  ]);
  // pip --target console-script shims point at the BUILD machine's Python; drop them.
  fs.rmSync(path.join(sitePackages, "bin"), { recursive: true, force: true });
  for (const f of walk(sitePackages)) {
    if (path.basename(f) === "direct_url.json") fs.rmSync(f);
  }
  const pyExe = path.join(pyDir, "python.exe");
  const probe = spawnSync(pyExe, ["-c", "import ddgs, lxml, primp; print('ddgs OK')"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`Bundled Python cannot import ddgs:\n${probe.stderr}`);
  console.log(`    ${probe.stdout.trim()}`);
  // Precompile with hash-based .pyc (valid regardless of zip-extraction mtimes)
  // so Python never writes __pycache__ into the app folder at runtime.
  for (const d of walk(sitePackages).filter((f) => f.includes(`${path.sep}__pycache__${path.sep}`))) fs.rmSync(d);
  // -s/-p rewrite the embedded source path so no build-machine path ends up in .pyc files.
  run(pyExe, [
    "-m", "compileall", "-q", "--invalidation-mode", "unchecked-hash",
    "-s", sitePackages, "-p", "Lib\\site-packages",
    sitePackages,
  ]);

  // ------------------------------------------------------------ App
  step("Compile Bridge (TypeScript -> app/dist)");
  const appDir = path.join(stage, "app");
  fs.mkdirSync(appDir, { recursive: true });
  run(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(root, "tsconfig.json"),
    "--outDir", path.join(appDir, "dist"),
    "--sourceMap", "false",
    "--declaration", "false",
  ]);

  step("Install production dependencies (npm ci --omit=dev --omit=optional)");
  const releasePkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    license: pkg.license,
    type: pkg.type,
    engines: pkg.engines,
    bin: pkg.bin,
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
  };
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify(releasePkg, null, 2) + "\n");
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(appDir, "package-lock.json"));
  // node-pty (optional) is only used for interactive terminals / custom agents,
  // both disabled under the Chat-only policy; omitting it avoids shipping native code.
  run("cmd.exe", ["/d", "/s", "/c", "npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error"], {
    cwd: appDir,
  });
  fs.rmSync(path.join(appDir, "package-lock.json"));
  fs.rmSync(path.join(appDir, "node_modules", ".package-lock.json"), { force: true });

  step("Copy launcher, helper scripts, docs and templates");
  fs.mkdirSync(path.join(appDir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts", "ddgs_images.py"), path.join(appDir, "scripts", "ddgs_images.py"));
  fs.mkdirSync(path.join(appDir, "launcher"), { recursive: true });
  fs.copyFileSync(path.join(here, "launcher.mjs"), path.join(appDir, "launcher", "launcher.mjs"));
  copy(path.join(root, "examples"), path.join(appDir, "examples"));
  copy(path.join(root, "docs"), path.join(appDir, "docs"));
  for (const f of ["README.md", "SECURITY.md", "CHANGELOG.md", "LICENSE"]) {
    fs.copyFileSync(path.join(root, f), path.join(appDir, f));
  }
  crlf(path.join(here, "QQ CLI Bridge.cmd"), path.join(stage, "QQ CLI Bridge.cmd"));
  crlf(path.join(here, "qqbridge.cmd"), path.join(stage, "qqbridge.cmd"));
  crlf(path.join(here, "QUICKSTART.txt"), path.join(stage, "QUICKSTART.txt"));
  crlf(path.join(root, "LICENSE"), path.join(stage, "LICENSE.txt"));
  fs.writeFileSync(
    path.join(stage, "VERSION.txt"),
    [
      `qq-cli-bridge ${pkg.version} (windows-x64 portable)`,
      `Node.js ${NODE_VERSION}`,
      `Python ${PYTHON_VERSION} (embeddable) with ddgs`,
      `Built ${new Date().toISOString()}`,
      "",
    ].join("\r\n"),
  );

  step("Generate THIRD-PARTY-NOTICES.txt");
  writeNotices(appDir, sitePackages);

  step("Safety scan (no credentials, runtime data or local paths)");
  safetyScan();

  step("Create zip + SHA256");
  run(TAR, ["-a", "-c", "-f", zipPath, "-C", releaseDir, NAME]);
  const hash = sha256File(zipPath);
  fs.writeFileSync(zipPath + ".sha256", `${hash}  ${path.basename(zipPath)}\n`);
  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n    ${path.relative(root, zipPath)}  (${size} MB)`);
  console.log(`    SHA256 ${hash}`);
}

function readLicenseFiles(dir) {
  const texts = [];
  const cands = [];
  for (const sub of [dir, path.join(dir, "licenses")]) {
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub)) {
      if (/^(licen[cs]e|copying|notice|authors)/i.test(f) && fs.statSync(path.join(sub, f)).isFile()) cands.push(path.join(sub, f));
    }
  }
  for (const f of cands) texts.push(fs.readFileSync(f, "utf8").trim());
  return texts;
}

function writeNotices(appDir, sitePackages) {
  const sep = "\r\n" + "-".repeat(78) + "\r\n";
  const parts = [
    "THIRD-PARTY NOTICES — qq-cli-bridge Windows portable release",
    "This package bundles the following third-party software under their own licenses.",
  ];
  parts.push(`Node.js ${NODE_VERSION} (runtime/node)\r\n\r\n${fs.readFileSync(path.join(stage, "runtime", "node", "LICENSE"), "utf8").trim()}`);
  const pyLicense = path.join(stage, "runtime", "python", "LICENSE.txt");
  if (fs.existsSync(pyLicense)) parts.push(`Python ${PYTHON_VERSION} (runtime/python)\r\n\r\n${fs.readFileSync(pyLicense, "utf8").trim()}`);

  const nm = path.join(appDir, "node_modules");
  const pkgDirs = [];
  for (const e of fs.readdirSync(nm)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) for (const s of fs.readdirSync(path.join(nm, e))) pkgDirs.push(path.join(nm, e, s));
    else pkgDirs.push(path.join(nm, e));
  }
  for (const d of pkgDirs.sort()) {
    const pj = path.join(d, "package.json");
    if (!fs.existsSync(pj)) continue;
    const p = JSON.parse(fs.readFileSync(pj, "utf8"));
    const lic = readLicenseFiles(d);
    parts.push(`npm: ${p.name}@${p.version} — ${p.license ?? "see package"}\r\n\r\n${lic.join("\r\n\r\n") || "(no license file shipped; see the package's license field)"}`);
  }
  for (const d of fs.readdirSync(sitePackages).filter((f) => f.endsWith(".dist-info")).sort()) {
    const full = path.join(sitePackages, d);
    const meta = fs.readFileSync(path.join(full, "METADATA"), "utf8");
    const name = meta.match(/^Name: (.+)$/m)?.[1] ?? d;
    const ver = meta.match(/^Version: (.+)$/m)?.[1] ?? "";
    const licField = meta.match(/^License-Expression: (.+)$/m)?.[1] ?? meta.match(/^License: (.+)$/m)?.[1] ?? "see package";
    const lic = readLicenseFiles(full);
    parts.push(`PyPI: ${name}==${ver} — ${licField}\r\n\r\n${lic.join("\r\n\r\n") || "(see package metadata)"}`);
  }
  fs.writeFileSync(path.join(stage, "THIRD-PARTY-NOTICES.txt"), parts.join(sep).replace(/(?<!\r)\n/g, "\r\n") + "\r\n");
}

function safetyScan() {
  const files = walk(stage);
  const rel = (f) => path.relative(stage, f).replace(/\\/g, "/");
  const forbiddenPath = [
    /(^|\/)data\//i,
    /(^|\/)\.env(\.|$)/i,
    /\.(sqlite|sqlite-shm|sqlite-wal|db|jsonl|log|pem|key|p12|pfx)$/i,
    /(^|\/)auth\.json$/i,
    /\.enc\.json$/i,
    /(^|\/)config\.json$/i,
    /(^|\/)persona\.md$/, // the private Persona (docs/PERSONA.md is documentation)
    /(^|\/)(secrets|sessions|codex-qq-home|chat-runtime)\//i,
    /(^|\/)node-pty\//i,
  ];
  const badPaths = files.map(rel).filter((r) => forbiddenPath.some((re) => re.test(r)));
  if (badPaths.length) throw new Error(`Forbidden files in release:\n  ${badPaths.join("\n  ")}`);

  const localMarkers = [root, process.env.USERPROFILE, os.hostname()]
    .filter((s) => s && s.length > 3)
    .flatMap((s) => [s, s.replace(/\\/g, "/"), s.replace(/\\/g, "\\\\")]);
  const secretRe = /(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const textExt = /\.(m?js|cjs|json|md|txt|cmd|py|pth|toml|cfg|ini|yml|yaml)$/i;
  const hits = [];
  const markersLc = [...new Set(localMarkers.map((m) => m.toLowerCase()))];
  for (const f of files) {
    // Every file, binary included (.pyc / .node embed paths): check raw bytes as
    // latin1 and UTF-16LE for build-machine paths / host name.
    const buf = fs.readFileSync(f);
    const hay = `${buf.toString("latin1")}\n${buf.toString("utf16le")}`.toLowerCase();
    for (const m of markersLc) if (hay.includes(m)) hits.push(`${rel(f)}: contains build-machine path/name`);
    if (textExt.test(f) && buf.length <= 5 * 1024 * 1024) {
      const m = buf.toString("utf8").match(secretRe);
      if (m) hits.push(`${rel(f)}: secret-like token ${m[0].slice(0, 12)}…`);
    }
  }
  if (hits.length) throw new Error(`Safety scan failed:\n  ${[...new Set(hits)].join("\n  ")}`);
  console.log(`    ${files.length} files scanned, clean`);
}

main().catch((err) => {
  console.error(`\nRELEASE BUILD FAILED: ${err.message}`);
  process.exitCode = 1;
});

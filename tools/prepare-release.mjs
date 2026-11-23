import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = (path) => readFile(join(root, path), "utf8");
const digest = (bytes) => createHash("sha256").update(bytes).digest("base64");
const assetRecord = (bytes) => ({ sha256: hash(bytes), bytes: Buffer.byteLength(bytes, "utf8") });

async function readReleaseAsset(path) {
  const content = await source(path);
  if (!path.endsWith(".js")) return content;
  return content.replace(/((?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']\.{1,2}\/[^"']+?\.js)\?v=\d+(?=["'])/g, "$1");
}

function replaceEntry(source, value, replacement) {
  if (!source.includes(value)) throw new Error(`Missing release entry: ${value}`);
  return source.replace(value, () => replacement);
}

async function prepareRelease(directory) {
  const [html, worker, tool, modules] = await Promise.all([
    source("index.html"), source("sw.js"), readFile(fileURLToPath(import.meta.url)), readdir(join(root, "js")),
  ]);
  const paths = ["player.js", "player.css", "i18n.js", ...modules.filter((name) => name.endsWith(".js")).sort().map((name) => `js/${name}`)];
  const files = new Map(await Promise.all(paths.map(async (path) => [path, await readReleaseAsset(path)])));
  const sequence = Date.now();
  const id = hash(JSON.stringify([sequence, hash(html), hash(worker), hash(tool), [...files].map(([path, bytes]) => [path, hash(bytes)])]));
  const base = `releases/${id}`;
  const page = `release-${id}.html`;
  const workerPath = `sw-${id}.js`;
  const scriptEntry = html.match(/<script type="module" src="(\.\/player\.js\?v=\d+)"/);
  const startupEntry = html.match(/<script src="(\.\/js\/startup-error\.js\?v=\d+)"/);
  const styleEntry = html.match(/<link rel="stylesheet" href="(\.\/player\.css\?v=\d+)"/);
  if (!scriptEntry || !startupEntry || !styleEntry) throw new Error("Missing a player script or stylesheet in index.html.");
  const integrity = Object.fromEntries([...files]
    .filter(([path]) => path.endsWith(".js"))
    .map(([path, bytes]) => [`./${base}/${path}`, `sha256-${digest(bytes)}`]));
  const importMap = JSON.stringify({ integrity }).replaceAll("<", "\\u003c");
  const playerUrl = `./${base}/player.js`;
  const startupUrl = `./${base}/js/startup-error.js`;
  let releasePage = replaceEntry(html, `src="${scriptEntry[1]}"`,
    `src="${playerUrl}" integrity="${integrity[playerUrl]}"`);
  releasePage = replaceEntry(releasePage, `src="${startupEntry[1]}"`,
    `src="${startupUrl}" integrity="${integrity[startupUrl]}"`);
  releasePage = replaceEntry(releasePage, `href="${styleEntry[1]}"`,
    `href="./${base}/player.css" integrity="sha256-${digest(files.get("player.css"))}"`);
  releasePage = replaceEntry(releasePage, "</head>", `  <meta name="compact-player-worker" content="${workerPath}">\n  <meta name="compact-player-release" content="${sequence}">\n  <script type="importmap">${importMap}</script>\n</head>`);

  const assets = Object.fromEntries([...files].map(([path, bytes]) => [`${base}/${path}`, assetRecord(bytes)]));
  const release = { id, sequence, page, assets: { [page]: assetRecord(releasePage), ...assets } };
  const importLine = worker.match(/^importScripts\((.*)\);$/m);
  if (!importLine) throw new Error("Missing classic worker imports in sw.js.");
  const workerDependencies = JSON.parse(`[${importLine[1]}]`).map((url) => {
    const bytes = files.get(url.replace(/^\.\//, "").split("?")[0]);
    if (!bytes) throw new Error(`Missing worker dependency: ${url}`);
    return bytes;
  });
  let releaseWorker = replaceEntry(worker, importLine[0], workerDependencies.join("\n"));
  releaseWorker = replaceEntry(releaseWorker, "const SHELL_RELEASE = null;", `const SHELL_RELEASE = ${JSON.stringify(release)};`);

  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("The release output directory must be empty.");
  async function write(path, bytes) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await Promise.all([...files].map(([path, bytes]) => write(`${base}/${path}`, bytes)));
  await write(`${base}/manifest.json`, JSON.stringify(release, null, 2) + "\n");
  await write(page, releasePage);
  await write(workerPath, releaseWorker);
  await write("sw.js", releaseWorker);
  await write("index.html", releasePage);
  return { id, page, workerPath };
}

if (process.argv.length !== 3) {
  console.error("Usage: node tools/prepare-release.mjs <empty-output-directory>");
  process.exitCode = 1;
} else {
  try {
    const release = await prepareRelease(resolve(process.argv[2]));
    console.log(JSON.stringify(release));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

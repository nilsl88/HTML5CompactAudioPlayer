import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("document IDs are unique and labels point to controls", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, target] of html.matchAll(/<label[^>]+for="([^"]+)"/g)) assert.ok(ids.includes(target), `Missing labelled control #${target}`);
  assert.doesNotMatch(html, /onclick=|onkeydown=|javascript:/i);
});

test("chapter navigation uses platform-independent icons", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  for (const id of ["prevChapterBtn", "nextChapterBtn"]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]*>\\s*<svg class="control-icon"[^>]*aria-hidden="true"[^>]*focusable="false"`));
  }
  assert.doesNotMatch(html, /[⏮⏭]/u);
});

test("player metadata includes only the active chapter title", async () => {
  const source = await readFile(new URL("player.js", root), "utf8");
  assert.match(source, /const chapterTitle = cues\[activeCueIndex\]\?\.title \|\| "";/);
  assert.match(source, /setMeta\(\[language\?\.label \|\| languageCode, sourceLabel\(source, false\), chapterTitle\]\.filter\(Boolean\)/);
  assert.match(source, /function markActiveChapter\(position\)[\s\S]*?activeCueIndex = index;[\s\S]*?updateMeta\(\);/);
});

test("vertical arrow shortcuts use the configured skip interval", async () => {
  const source = await readFile(new URL("player.js", root), "utf8");
  assert.match(source, /event\.code === "ArrowUp"[^{]*\{[^}]*event\.preventDefault\(\);[^}]*media\.seek\(media\.position\(\) \+ uiPrefs\.skipSeconds\);/);
  assert.match(source, /event\.code === "ArrowDown"[^{]*\{[^}]*event\.preventDefault\(\);[^}]*media\.seek\(media\.position\(\) - uiPrefs\.skipSeconds\);/);
});

test("visual notifications are centered inside the player", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(html, /<div id="toastHost" class="toast-host" aria-hidden="true"><\/div>\s*<audio id="audio"[^>]*><\/audio>\s*<\/section>/);
  const rule = css.match(/\.toast-host\s*{([^}]*)}/)?.[1] || "";
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /top:\s*50%/);
  assert.match(rule, /left:\s*50%/);
  assert.match(rule, /transform:\s*translate\(-50%,\s*-50%\)/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /z-index:\s*30/);
  assert.match(rule, /width:\s*min\(26rem,\s*calc\(100% - 2rem\)\)/);
});

test("options uses a platform-independent icon", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /<button id="optionsBtn"[^>]*>\s*<svg class="control-icon control-icon-stroke"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(html, /⚙/u);
});

test("control tooltips support mouse and keyboard users", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  const source = await readFile(new URL("player.js", root), "utf8");
  assert.match(css, /\[data-tooltip\]::after\s*{[^}]*content:\s*attr\(data-tooltip\)/s);
  assert.match(css, /\[data-tooltip\]:focus-visible::after/);
  assert.match(css, /\[data-tooltip\]:hover::after/);
  assert.match(source, /function setTooltip\(element, message\)/);
  for (const id of ["playPauseBtn", "skipBackBtn", "skipForwardBtn", "sleepBtn", "resetBtn"]) {
    assert.match(source, new RegExp(`setTooltip\\(els\\.${id},`), `Missing tooltip assignment for #${id}`);
  }
  for (const id of ["prevChapterBtn", "nextChapterBtn"]) {
    assert.match(source, new RegExp(`\\[els\\.${id},\\s*t\\(`), `Missing mapped tooltip assignment for #${id}`);
  }
  for (const id of ["chaptersBtn", "optionsBtn"]) {
    assert.match(source, new RegExp(`setControlLabel\\(els\\.${id},`), `Missing labelled tooltip assignment for #${id}`);
  }
});

test("CSS custom properties are defined", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  const definitions = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const uses = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
  assert.deepEqual([...uses].filter((name) => !definitions.has(name)), []);
});

test("open cover dialog fills the viewport and centers its image", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(css, /\.cover-dialog\s*{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100dvh;/s);
  assert.match(css, /\.cover-dialog\[open\]\s*{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(css, /\.cover-dialog-image\s*{[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;/s);
});

test("cover hover uses theme-neutral colors", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  const rule = css.match(/\.cover-button:hover:not\(:disabled\)\s*{([^}]*)}/)?.[1] || "";
  assert.match(rule, /var\(--text\)/);
  assert.match(rule, /var\(--surface-raised\)/);
  assert.doesNotMatch(rule, /var\(--accent\)/);
});

test("reset player action is centered and styled as a control", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(css, /\.reset-row\s*{[^}]*justify-content:\s*center;/s);
  const rule = css.match(/\.text-button\s*{([^}]*)}/)?.[1] || "";
  assert.match(rule, /min-height:\s*var\(--control-size\)/);
  assert.match(rule, /border:\s*1px solid var\(--border\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-sm\)/);
  assert.match(rule, /color:\s*inherit/);
  assert.match(rule, /text-decoration:\s*none/);
});

test("phone transport controls stay on one row", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(css, /@media \(max-width:\s*26\.875rem\)[\s\S]*?\.transport-controls\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(css, /\.transport-controls\s*>\s*button\s*{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
});

test("production HTML has no runtime dependencies", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.doesNotMatch(html, /node_modules|unpkg|jsdelivr|cdnjs/i);
  assert.match(html, /<audio[^>]+preload="none"/);
  assert.match(html, /type="module"/);
});

test("library titles load lazily from cached episode configurations", async () => {
  const source = await readFile(new URL("player.js", root), "utf8");
  const library = JSON.parse(await readFile(new URL("media/library.json", root), "utf8"));
  assert.ok(library.audiofiles.every((item) => item.id && !item.title && !item.label));
  assert.match(source, /const episodeConfigCache = new Map\(\);/);
  assert.match(source, /Array\.from\(\{ length: Math\.min\(2, records\.length\) \}/);
  assert.match(source, /openPanel\(els\.optionsPanel[\s\S]*?void loadLibraryTitles\(\);/);
  assert.match(source, /record\.title = loadedEpisode\.title;/);
});

test("onboarding policy belongs to the library", async () => {
  const source = await readFile(new URL("player.js", root), "utf8");
  const library = JSON.parse(await readFile(new URL("media/library.json", root), "utf8"));
  const episode = JSON.parse(await readFile(new URL("media/episode-001/episode.json", root), "utf8"));
  assert.equal(library.ui.onboardingEnabled, true);
  assert.equal(Object.hasOwn(episode, "ui"), false);
  assert.match(source, /library\.ui\.onboardingEnabled && !storage\.hasSeenOnboarding\(\)/);
  assert.doesNotMatch(source, /episode\.ui\.onboardingEnabled/);
});

test("offline controls are semantic and media opts into service-worker handling", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /<section id="offlineRow"[^>]*aria-labelledby="offlineLabel"[^>]*hidden>/);
  for (const id of ["offlineDownloadBtn", "offlineCancelBtn", "offlineRemoveBtn"]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]*type="button"`));
  }
  assert.match(html, /<progress id="offlineProgress"[^>]*aria-labelledby="offlineLabel offlineStatus"/);
  assert.match(html, /<audio id="audio"[^>]*preload="none"[^>]*crossorigin="anonymous"/);
});

test("service worker keeps online requests first and serves cached byte ranges", async () => {
  const worker = await readFile(new URL("sw.js", root), "utf8");
  assert.match(worker, /async function networkFirst\(request\)[\s\S]*?await fetch\(request\)/);
  assert.match(worker, /new Response\(stream, \{ status: range\.partial \? 206 : 200, headers \}\)/);
  assert.match(worker, /"content-range"\] = `bytes \$\{range\.start\}-\$\{range\.end\}\/\$\{manifest\.totalSize\}`/);
  assert.match(worker, /request\.headers\.get\(DOWNLOAD_HEADER\) === "1"/);
  assert.doesNotMatch(worker, /importScripts\(|https:\/\/.*(?:workbox|unpkg|jsdelivr)/i);
});

test("service-worker shell and versioned entry points stay in sync", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const source = await readFile(new URL("player.js", root), "utf8");
  const worker = await readFile(new URL("sw.js", root), "utf8");
  assert.match(html, /player\.css\?v=6/);
  assert.match(html, /player\.js\?v=6/);
  assert.match(source, /i18n\.js\?v=6/);
  assert.match(worker, /const SHELL_VERSION = "v6"/);
  for (const path of ["player.css?v=6", "player.js?v=6", "i18n.js?v=6", "js/offline.js", "js/mp4-chapters.js"]) assert.ok(worker.includes(`"./${path}"`), `Missing ${path} from the offline shell`);
});

test("offline lifecycle is optional and reset clears downloaded media", async () => {
  const source = await readFile(new URL("player.js", root), "utf8");
  assert.match(source, /const offline = new OfflineManager/);
  assert.match(source, /offline\.init\(\)/);
  assert.match(source, /await offline\.reset\(\)/);
  assert.match(source, /navigator\.onLine === false \? offline\.active\?\.episodeId/);
  assert.match(source, /function saveProgress\(force = false\)\s*{\s*if \(!episode \|\| resetInProgress\) return;/);
  assert.match(source, /resetInProgress = true;[\s\S]*?clearTimeout\(progressTimer\);[\s\S]*?media\.destroy\(\);[\s\S]*?storage\.reset\(\);[\s\S]*?await offline\.reset\(\);[\s\S]*?location\.reload\(\);/);
});

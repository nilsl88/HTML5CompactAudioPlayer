import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

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

test("options uses a platform-independent gear icon", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const button = html.match(/<button id="optionsBtn"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(button, /<svg class="control-icon control-icon-stroke"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(button, /<path d="[^"]+z"><\/path><circle cx="12" cy="12" r="3"><\/circle>/);
  assert.doesNotMatch(button, /⚙/u);
});

test("popup close buttons use inverse theme colors", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const css = await readFile(new URL("player.css", root), "utf8");
  for (const id of ["closeChaptersBtn", "closeSleepBtn"]) {
    assert.match(html, new RegExp(`<button id="${id}" class="icon-button panel-close"`));
  }
  const rule = css.match(/\.panel-close\s*{([^}]*)}/)?.[1] || "";
  assert.match(rule, /background:\s*var\(--text\)/);
  assert.match(rule, /color:\s*var\(--background\)/);
  assert.match(rule, /border-color:\s*var\(--text\)/);
});

test("control tooltips support mouse and keyboard users", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(css, /\[data-tooltip\]::after\s*{[^}]*content:\s*attr\(data-tooltip\)/s);
  assert.match(css, /\[data-tooltip\]:focus-visible::after/);
  assert.match(css, /\[data-tooltip\]:hover::after/);
});

test("select controls use aligned custom arrows", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const css = await readFile(new URL("player.css", root), "utf8");
  for (const id of ["bookSelect", "langSelect", "qualitySelect", "skipSelect", "themeSelect", "fontSizeSelect", "uiLangSelect"]) {
    assert.match(html, new RegExp(`<div class="select-wrap"><select id="${id}"[\\s\\S]*?</select><span class="select-arrow" aria-hidden="true"><\\/span><\\/div>`));
  }
  assert.match(css, /\.select-wrap\s*{[^}]*position:\s*relative;/s);
  assert.match(css, /select\s*{[^}]*appearance:\s*none;[^}]*-webkit-appearance:\s*none;/s);
  assert.match(css, /\.select-arrow\s*{[^}]*top:\s*50%;[^}]*right:\s*var\(--space-3\);/s);
  assert.match(css, /\.select-arrow\s*{[^}]*transform:\s*translateY\(-50%\) rotate\(45deg\);/s);
  assert.match(css, /\.select-button::after\s*{[^}]*transform:\s*translateY\(-50%\) rotate\(45deg\);/s);
  assert.match(css, /\.select-wrap select:disabled \+ \.select-arrow\s*{[^}]*opacity:\s*\.55;/s);
});

test("select controls use styled accessible popups", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  assert.match(css, /\.select-button\s*{[^}]*min-height:\s*var\(--control-size\);[^}]*justify-content:\s*space-between;/s);
  assert.match(css, /\.select-button::after\s*{[^}]*border-right:[^;]+;[^}]*border-bottom:[^;]+;/s);
  assert.match(css, /\.select-menu\s*{[^}]*position:\s*absolute;[^}]*max-height:[^;]+;[^}]*overflow:\s*auto;/s);
  assert.match(css, /\.select-wrap\.opens-up \.select-menu\s*{/);
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

test("button hover uses neutral gray colors", async () => {
  const css = await readFile(new URL("player.css", root), "utf8");
  const standardRule = css.match(/(?:^|\n)button:hover:not\(:disabled\)\s*{([^}]*)}/)?.[1] || "";
  const inverseRule = css.match(/\.play-button:hover:not\(:disabled\)[^{]+{([^}]*)}/)?.[1] || "";
  assert.match(standardRule, /var\(--text\)/);
  assert.doesNotMatch(standardRule, /var\(--accent\)/);
  assert.match(inverseRule, /var\(--text\)/);
  assert.match(inverseRule, /var\(--surface-raised\)/);
  assert.doesNotMatch(inverseRule, /var\(--accent\)/);
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

test("the example catalog leaves book titles in the book configurations", async () => {
  const library = JSON.parse(await readFile(new URL("media/library.json", root), "utf8"));
  assert.ok(library.books.every((item) => item.id && !item.title && !item.label));
});

test("onboarding policy belongs to the library", async () => {
  const library = JSON.parse(await readFile(new URL("media/library.json", root), "utf8"));
  const book = JSON.parse(await readFile(new URL("media/episode-001/book.json", root), "utf8"));
  assert.equal(library.ui.onboardingEnabled, true);
  assert.equal(Object.hasOwn(book, "ui"), false);
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

test("service-worker shell and versioned entry points stay in sync", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const source = await readFile(new URL("js/player-app.js", root), "utf8");
  const worker = await readFile(new URL("sw.js", root), "utf8");
  const version = worker.match(/const SHELL_VERSION = "v(\d+)"/)?.[1];
  assert.ok(version);
  const script = "./player.js?v=" + version;
  const style = "./player.css?v=" + version;
  const strings = "./i18n.js?v=" + version;
  assert.ok(html.includes('src="' + script + '"'));
  assert.ok(html.includes('href="' + style + '"'));
  assert.ok(source.includes('from ".' + strings + '"'));
  const urls = worker.match(/const SHELL_URLS = \[([\s\S]*?)\];/)[1];
  const paths = new Set([...urls.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  const modules = (await readdir(new URL("js/", root))).filter((name) => name.endsWith(".js"));
  for (const path of [script, style, strings, ...modules.map((name) => "./js/" + name)]) {
    assert.ok(paths.has(path), "Missing offline shell asset " + path);
  }
});

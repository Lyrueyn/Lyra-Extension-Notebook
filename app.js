(() => {
  "use strict";

  const FORMAT = "lyra-notebook";
  const FORMAT_VERSION = 2;
  const MIME = "application/vnd.lyra.notebook+zip";
  const EDIT_CHANNEL = "lyra-editor";
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const params = new URLSearchParams(location.search);
  const editorOrigin = params.get("extensionsOrigin") || "https://lyra-extensions.local";
  const isFilePreview = location.protocol === "file:";
  const $ = (id) => document.getElementById(id);

  const state = {
    manifest: null,
    notes: new Map(),
    assets: new Map(),
    currentId: "",
    mode: "edit",
    dirty: false,
    saveTimer: 0,
    saveInFlight: false,
    requestId: 1,
    editorReady: false,
    editorInited: false,
    docWaiter: null,
  };

  function showError(err) {
    $("errorText").textContent = String(err && err.message ? err.message : err);
    $("errorMask").hidden = false;
  }
  function setStatus(text, tone) {
    const el = $("saveState");
    el.textContent = text;
    el.classList.toggle("saving", tone === "saving");
    el.style.color = tone === "error" ? "#fca5a5" : "";
  }
  function uid(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }
  function nowIso() { return new Date().toISOString(); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64 || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  // ---------- 旧版结构树 -> HTML（迁移 v1 笔记） ----------
  function legacyInline(list) {
    if (!Array.isArray(list)) return "";
    return list.map((t) => {
      if (!t) return "";
      if (t.type === "hardBreak") return "<br>";
      let out = escapeHtml(t.text || "");
      const marks = Array.isArray(t.marks) ? t.marks : [];
      for (const mark of marks) {
        const type = mark && mark.type;
        if (type === "bold") out = "<strong>" + out + "</strong>";
        else if (type === "italic") out = "<em>" + out + "</em>";
        else if (type === "underline") out = "<u>" + out + "</u>";
        else if (type === "strike") out = "<s>" + out + "</s>";
        else if (type === "inlineCode") out = "<code>" + out + "</code>";
        else if (type === "link") out = '<a href="' + escapeAttr(mark.href || "#") + '">' + out + "</a>";
        else if (type === "color") out = '<span style="color:' + escapeAttr(mark.value || "inherit") + '">' + out + "</span>";
        else if (type === "highlight") out = '<span style="background-color:' + escapeAttr(mark.value || "#fff3b0") + '">' + out + "</span>";
      }
      return out;
    }).join("");
  }
  function legacyList(block, ordered) {
    const tag = ordered ? "ol" : "ul";
    const items = (block.items || []).map((raw) => {
      const item = Array.isArray(raw) ? { children: raw, blocks: [] } : (raw || {});
      let inner = "";
      if (item.checked !== undefined) inner += '<input type="checkbox" ' + (item.checked ? "checked " : "") + 'disabled> ';
      inner += legacyInline(item.children || []);
      for (const nested of item.blocks || []) inner += legacyBlock(nested);
      return "<li>" + inner + "</li>";
    }).join("");
    return "<" + tag + ">" + items + "</" + tag + ">";
  }
  function legacyBlock(block) {
    if (!block) return "";
    const type = block.type || "paragraph";
    if (type === "heading") {
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      return "<h" + level + ">" + legacyInline(block.children) + "</h" + level + ">";
    }
    if (type === "bulletList") return legacyList(block, false);
    if (type === "orderedList") return legacyList(block, true);
    if (type === "taskList") return legacyList(block, false);
    if (type === "blockquote") return "<blockquote>" + legacyInline(block.children) + "</blockquote>";
    if (type === "codeBlock") return "<pre><code>" + escapeHtml(block.text || "") + "</code></pre>";
    if (type === "divider") return "<hr>";
    if (type === "image") {
      const asset = state.assets.get(block.assetId);
      return asset ? '<img src="' + escapeAttr(asset.path) + '" alt="' + escapeAttr(asset.name || "") + '">' : "<p>[图片缺失]</p>";
    }
    if (type === "table") {
      const rows = (block.rows || []).map((row) => {
        const cells = (Array.isArray(row) ? row : []).map((cell) => "<td>" + legacyInline(cell && cell.children ? cell.children : []) + "</td>").join("");
        return "<tr>" + cells + "</tr>";
      }).join("");
      return "<table><tbody>" + rows + "</tbody></table>";
    }
    return "<p>" + legacyInline(block.children) + "</p>";
  }
  function legacyBlocksToHtml(blocks) {
    if (!Array.isArray(blocks)) return defaultHtml();
    return blocks.map(legacyBlock).join("\n");
  }


  function ensureFullHtml(html, title) {
    const value = String(html || "");
    if (/<html[\s>]/i.test(value)) return value;
    const safeTitle = escapeHtml(title || "笔记");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1f2937;
      background: #ffffff;
      line-height: 1.65;
    }
    img, video, canvas, svg { max-width: 100%; min-width: 0; height: auto; }
  </style>
</head>
<body>
${value}
</body>
</html>`;
  }
  function defaultHtml(title) {
    return ensureFullHtml("<h1>" + escapeHtml(title || "新笔记") + "</h1>\n<p>左边写 HTML，中间实时预览，右边检查元素并调整样式。</p>", title);
  }
  function defaultNote(title) {
    const now = nowIso();
    return {
      meta: { id: uid("note"), title: title || "新笔记", createdAt: now, updatedAt: now },
      html: defaultHtml(title || "新笔记"),
    };
  }
  function defaultManifest() {
    const note = defaultNote("新笔记");
    const now = nowIso();
    return {
      manifest: {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        id: uid("book"),
        title: "未命名笔记本",
        createdAt: now,
        updatedAt: now,
        appVersion: "2.0.0",
        notes: [note.meta],
        assets: [],
        settings: { theme: "dark" },
      },
      notes: new Map([[note.meta.id, note]]),
    };
  }

  function hostCall(type, payload) {
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error("请从璃鸢镜扩展中打开笔记本")); return; }
      const requestId = String(state.requestId++);
      const timer = setTimeout(() => reject(new Error("宿主响应超时")), 20000);
      const onMessage = (event) => {
        const d = event.data || {};
        if (d.type === type + ".result" && d.requestId === requestId) {
          clearTimeout(timer);
          try { host.removeEventListener("message", onMessage); } catch { }
          resolve(d);
        }
      };
      host.addEventListener("message", onMessage);
      host.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
    });
  }

  // ---------- 包读写 ----------
  async function loadPackage(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const mf = zip.file("manifest.json");
    if (!mf) throw new Error("缺少 manifest.json");
    const manifest = JSON.parse(await mf.async("string"));
    if (manifest.format !== FORMAT) throw new Error("不是 .lyrnb 笔记本文件");
    if (Number(manifest.formatVersion) > FORMAT_VERSION) throw new Error("这个笔记本由更高版本创建，请升级扩展");

    const assets = new Map();
    for (const asset of (Array.isArray(manifest.assets) ? manifest.assets : [])) {
      try {
        const f = zip.file(asset.path);
        if (!f) continue;
        const bytes = await f.async("uint8array");
        assets.set(asset.id, Object.assign({}, asset, { base64: bytesToBase64(bytes) }));
      } catch { }
    }

    const notes = new Map();
    for (const meta of (Array.isArray(manifest.notes) ? manifest.notes : [])) {
      if (!meta || !meta.id) continue;
      let html = "";
      const htmlFile = zip.file("notes/" + meta.id + ".html");
      const jsonFile = zip.file("notes/" + meta.id + ".json");
      if (htmlFile) {
        html = await htmlFile.async("string");
      } else if (jsonFile) {
        try {
          const legacy = JSON.parse(await jsonFile.async("string"));
          html = legacyBlocksToHtml(legacy.blocks);
        } catch { html = defaultHtml(meta.title); }
      } else {
        html = defaultHtml(meta.title);
      }
      notes.set(meta.id, { meta: Object.assign({}, meta), html: ensureFullHtml(html, meta.title) });
    }
    if (notes.size === 0) {
      const note = defaultNote("新笔记");
      notes.set(note.meta.id, note);
      manifest.notes = [note.meta];
    }
    state.manifest = manifest;
    state.assets = assets;
    state.notes = notes;
    state.currentId = [...notes.keys()][0];
  }

  async function encodePackage() {
    syncCurrent();
    state.manifest.updatedAt = nowIso();
    state.manifest.notes = Array.from(state.notes.values()).map((n) => n.meta);
    state.manifest.assets = Array.from(state.assets.values()).map((a) => ({
      id: a.id, path: a.path, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256,
    }));
    const zip = new JSZip();
    zip.file("mimetype", MIME, { compression: "STORE" });
    zip.file("manifest.json", JSON.stringify(state.manifest, null, 2));
    for (const [id, note] of state.notes.entries()) zip.file("notes/" + id + ".html", note.html || "");
    for (const asset of state.assets.values()) {
      if (!asset.base64) continue;
      zip.file(asset.path, base64ToBytes(asset.base64), { binary: true });
    }
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }

  function syncCurrent() {
    const note = state.notes.get(state.currentId);
    if (!note) return;
    note.meta.updatedAt = nowIso();
  }

  async function saveNow() {
    if (state.saveInFlight || !state.manifest) return;
    state.saveInFlight = true;
    try {
      const bytes = await encodePackage();
      const res = await hostCall("host.workspace.save", { data: bytesToBase64(bytes) });
      if (!res || !res.ok) throw new Error((res && res.error) || "保存失败");
      state.dirty = false;
      setStatus("已保存 " + new Date().toLocaleTimeString().slice(0, 5));
      refreshNoteSelect();
    } catch (e) {
      setStatus("保存失败", "error");
      throw e;
    } finally {
      state.saveInFlight = false;
    }
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow().catch(showError), 900);
  }
  function markDirty() {
    state.dirty = true;
    setStatus("未保存", "saving");
    scheduleSave();
  }

  // ---------- 编辑器层 ----------
  function editorUrl() {
    if (isFilePreview) return "../Lyra-Extension-HTML-Editor/index.html?embedded=1&extensionsOrigin=" + encodeURIComponent(editorOrigin);
    return editorOrigin + "/html-editor/index.html?embedded=1&extensionsOrigin=" + encodeURIComponent(editorOrigin);
  }
  function editorTargetOrigin() { return isFilePreview ? "*" : editorOrigin; }
  function sendEditor(type, extra) {
    const frame = $("editorFrame");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(Object.assign({ channel: EDIT_CHANNEL, type: type }, extra || {}), editorTargetOrigin());
  }
  function assetsPayload() {
    return Array.from(state.assets.values()).map((a) => ({
      id: a.id, path: a.path, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, base64: a.base64,
    }));
  }
  function sendCurrentDocument() {
    const note = state.notes.get(state.currentId);
    if (!note) return;
    sendEditor(state.editorInited ? "set-document" : "init", {
      html: note.html || "",
      title: note.meta.title || "未命名笔记",
      assets: assetsPayload(),
    });
    state.editorInited = true;
  }
  function requestEditorDocument() {
    return new Promise((resolve) => {
      if (!state.editorInited) { resolve(null); return; }
      state.docWaiter = resolve;
      sendEditor("request-document");
      setTimeout(() => { if (state.docWaiter) { state.docWaiter(null); state.docWaiter = null; } }, 900);
    });
  }
  async function flushEditor() {
    const note = state.notes.get(state.currentId);
    if (!note) return;
    const html = await requestEditorDocument();
    if (typeof html === "string") note.html = html;
  }
  function ensureEditor() {
    const frame = $("editorFrame");
    if (frame.dataset.loaded === "1") return;
    frame.dataset.loaded = "1";
    frame.src = editorUrl();
    frame.addEventListener("load", () => {
      state.editorReady = false;
      state.editorInited = false;
      setTimeout(() => { if (!state.editorInited) sendCurrentDocument(); }, 1200);
    });
  }

  // ---------- 阅读模式 ----------
  function assetDataUrl(path) {
    const clean = String(path || "").replace(/^\.\//, "");
    for (const asset of state.assets.values()) {
      if (asset.path === clean || asset.path === path) {
        if (asset.base64) return "data:" + (asset.mime || "application/octet-stream") + ";base64," + asset.base64;
      }
    }
    return "";
  }
  function replaceAssetSources(html) {
    return String(html || "").replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (match, prefix, quote, url) => {
      const data = assetDataUrl(url);
      return data ? prefix + quote + data + quote : match;
    });
  }
  function renderRead() {
    const note = state.notes.get(state.currentId);
    if (!note) return;
      const html = note.html || "";
      $("readFrame").srcdoc = replaceAssetSources(/<html[\s>]/i.test(html) ? html : ensureFullHtml(html, note.meta.title));
  }
  function updateModeButtons() {
    $("editModeBtn").classList.toggle("active", state.mode === "edit");
    $("readModeBtn").classList.toggle("active", state.mode === "read");
  }
  async function setMode(mode) {
    if (mode === state.mode) return;
    if (mode === "read") {
      await flushEditor();
      if (state.dirty) await saveNow().catch(() => {});
      state.mode = "read";
      $("editorFrame").hidden = true;
      $("readFrame").hidden = false;
      renderRead();
      setStatus("阅读模式");
    } else {
      state.mode = "edit";
      $("readFrame").hidden = true;
      $("editorFrame").hidden = false;
      sendCurrentDocument();
      setStatus("编辑模式");
    }
    updateModeButtons();
  }

  // ---------- 笔记列表 ----------
  function refreshNoteSelect() {
    const select = $("noteSelect");
    const current = state.currentId;
    select.innerHTML = "";
    for (const [id, note] of state.notes.entries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = note.meta.title || "未命名笔记";
      if (id === current) opt.selected = true;
      select.appendChild(opt);
    }
    const note = state.notes.get(current);
    $("noteTitle").value = note ? (note.meta.title || "") : "";
    if (state.manifest) $("notebookTitle").value = state.manifest.title || "未命名笔记本";
  }

  async function switchNote(id) {
    if (!id || id === state.currentId) return;
    await flushEditor();
    if (state.dirty) await saveNow().catch(() => {});
    state.currentId = id;
    refreshNoteSelect();
    if (state.mode === "read") renderRead();
    else sendCurrentDocument();
  }
  async function addNote() {
    await flushEditor();
    if (state.dirty) await saveNow().catch(() => {});
    const note = defaultNote("新笔记");
    state.notes.set(note.meta.id, note);
    state.currentId = note.meta.id;
    refreshNoteSelect();
    if (state.mode === "read") renderRead();
    else sendCurrentDocument();
    markDirty();
  }
  async function deleteNote() {
    if (state.notes.size <= 1) { alert("至少保留一篇笔记"); return; }
    const note = state.notes.get(state.currentId);
    if (!confirm("删除笔记「" + ((note && note.meta.title) || "未命名") + "」？")) return;
    await flushEditor();
    state.notes.delete(state.currentId);
    state.currentId = [...state.notes.keys()][0];
    refreshNoteSelect();
    if (state.mode === "read") renderRead();
    else sendCurrentDocument();
    markDirty();
  }

  function replaceDocTitle(html, title) {
    const safe = escapeHtml(title || "笔记");
    if (/<title>[\s\S]*?<\/title>/i.test(html)) return html.replace(/<title>[\s\S]*?<\/title>/i, "<title>" + safe + "</title>");
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, "<head$1><title>" + safe + "</title>");
    return html;
  }
  async function moveNote(delta) {
    const ids = [...state.notes.keys()];
    const index = ids.indexOf(state.currentId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    await flushEditor();
    const entries = [...state.notes.entries()];
    const tmp = entries[index];
    entries[index] = entries[target];
    entries[target] = tmp;
    state.notes = new Map(entries);
    if (state.manifest) state.manifest.notes = entries.map((e) => e[1].meta);
    refreshNoteSelect();
    markDirty();
  }
  async function duplicateNote() {
    await flushEditor();
    const source = state.notes.get(state.currentId);
    if (!source) return;
    const now = nowIso();
    const title = (source.meta.title || "未命名笔记") + " 副本";
    const meta = Object.assign({}, source.meta, { id: uid("note"), title: title, createdAt: now, updatedAt: now });
    let html = ensureFullHtml(source.html, title);
    html = replaceDocTitle(html, title);
    const copy = { meta: meta, html: html };
    const entries = [...state.notes.entries()];
    const index = entries.findIndex((e) => e[0] === state.currentId);
    entries.splice(index + 1, 0, [meta.id, copy]);
    state.notes = new Map(entries);
    state.currentId = meta.id;
    refreshNoteSelect();
    if (state.mode === "read") renderRead();
    else sendCurrentDocument();
    markDirty();
  }

  // ---------- 启动 ----------
  async function init() {
    $("notebookTitle").addEventListener("input", () => {
      if (!state.manifest) return;
      state.manifest.title = $("notebookTitle").value.trim() || "未命名笔记本";
      markDirty();
    });
    $("noteTitle").addEventListener("input", () => {
      const note = state.notes.get(state.currentId);
      if (!note) return;
      note.meta.title = $("noteTitle").value.trim() || "未命名笔记";
      markDirty();
      refreshNoteSelect();
    });
    $("noteSelect").addEventListener("change", (e) => switchNote(e.target.value).catch(showError));
    $("moveNoteUpBtn").addEventListener("click", () => moveNote(-1).catch(showError));
    $("moveNoteDownBtn").addEventListener("click", () => moveNote(1).catch(showError));
    $("duplicateNoteBtn").addEventListener("click", () => duplicateNote().catch(showError));
    $("newNoteBtn").addEventListener("click", () => addNote().catch(showError));
    $("deleteNoteBtn").addEventListener("click", () => deleteNote().catch(showError));
    $("saveBtn").addEventListener("click", async () => {
      await flushEditor();
      await saveNow().catch(showError);
    });
    $("errorClose").addEventListener("click", () => { $("errorMask").hidden = true; });
    $("editModeBtn").addEventListener("click", () => setMode("edit").catch(showError));
    $("readModeBtn").addEventListener("click", () => setMode("read").catch(showError));
    window.addEventListener("message", (event) => {
      const frame = $("editorFrame");
      if (!frame || event.source !== frame.contentWindow) return;
      const d = event.data || {};
      if (d.channel !== EDIT_CHANNEL) return;
      const note = state.notes.get(state.currentId);
      if (d.type === "ready") {
        state.editorReady = true;
        if (!state.editorInited) sendCurrentDocument();
      } else if (d.type === "loaded") {
        setStatus("编辑中");
      } else if (d.type === "change") {
        if (note) note.html = d.html || "";
        markDirty();
      } else if (d.type === "document") {
        if (state.docWaiter) { const done = state.docWaiter; state.docWaiter = null; done(d.html || ""); }
      } else if (d.type === "assets") {
        state.assets = new Map();
        for (const a of (Array.isArray(d.assets) ? d.assets : [])) if (a && a.id) state.assets.set(a.id, a);
        markDirty();
      }
    });

    try {
      const res = await hostCall("host.workspace.load");
      if (!res || !res.ok) throw new Error((res && res.error) || "读取笔记本失败");
      if (!res.data) {
        const d = defaultManifest();
        state.manifest = d.manifest;
        state.notes = d.notes;
        state.assets = new Map();
        state.currentId = d.manifest.notes[0].id;
      } else {
        await loadPackage(base64ToBytes(res.data));
      }
      refreshNoteSelect();
      ensureEditor();
      updateModeButtons();
      setStatus("已保存");
      if (host) host.postMessage({ type: "host.ready" });
      if (!res.data) await saveNow();
    } catch (e) {
      showError(e);
    }
  }

  init().catch(showError);
})();
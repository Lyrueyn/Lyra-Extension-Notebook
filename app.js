(() => {
  "use strict";

  const FORMAT = "lyra-notebook";
  const FORMAT_VERSION = 1;
  const MIME = "application/vnd.lyra.notebook+zip";
  const $ = (id) => document.getElementById(id);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

  const state = {
    manifest: null,
    contents: new Map(),
    currentId: null,
    dirty: false,
    saveTimer: 0,
    hostSeq: 0,
    pending: new Map(),
    saveInFlight: false,
  };

  // ---------- 宿主桥接 ----------
  function hostCall(type, extra = {}) {
    return new Promise((resolve) => {
      if (!host) { resolve({ ok: false, error: "当前不是扩展宿主环境" }); return; }
      const requestId = "nb-" + (++state.hostSeq) + "-" + Date.now();
      state.pending.set(requestId, resolve);
      host.postMessage(Object.assign({ type, requestId }, extra));
      setTimeout(() => {
        if (state.pending.has(requestId)) {
          state.pending.delete(requestId);
          resolve({ ok: false, error: "宿主响应超时" });
        }
      }, 20000);
    });
  }

  if (host) {
    host.addEventListener("message", (event) => {
      const data = event.data || {};
      const resolve = state.pending.get(data.requestId);
      if (resolve) {
        state.pending.delete(data.requestId);
        resolve(data);
      }
    });
    // 笔记本不是阅读器，不使用 lyra-book-ready；主动解除宿主加载层。
    host.postMessage({ type: "host.ready" });
  }

  // ---------- 工具 ----------
  function uid(prefix) {
    const s = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    return prefix + "-" + s;
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
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch { return ""; }
  }

  // ---------- 默认结构 ----------
  function makeDefaultNote(title) {
    return {
      format: "lyra-note",
      formatVersion: 1,
      id: uid("note"),
      title: title || "未命名笔记",
      blocks: [{ id: uid("b"), type: "paragraph", children: [] }],
    };
  }

  function makeDefaultManifest() {
    const note = makeDefaultNote("第一篇笔记");
    const now = nowIso();
    return {
      manifest: {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        id: uid("book"),
        title: "未命名笔记本",
        createdAt: now,
        updatedAt: now,
        appVersion: "1.3.3",
        notes: [{
          id: note.id, title: note.title, parentId: null, order: 0,
          createdAt: now, updatedAt: now, tags: [], pinned: false,
        }],
        assets: [],
        settings: { theme: "dark", fontScale: 1.0, pageWidth: "normal" },
      },
      notes: new Map([[note.id, note]]),
    };
  }

  // ---------- 文档结构树 -> DOM ----------
  function markElement(mark, el) {
    const t = mark && mark.type;
    if (!t) return el;
    if (t === "bold") { const e = document.createElement("strong"); e.appendChild(el); return e; }
    if (t === "italic") { const e = document.createElement("em"); e.appendChild(el); return e; }
    if (t === "underline") { const e = document.createElement("u"); e.appendChild(el); return e; }
    if (t === "strike") { const e = document.createElement("s"); e.appendChild(el); return e; }
    if (t === "inlineCode") { const e = document.createElement("code"); e.appendChild(el); return e; }
    if (t === "link") {
      const a = document.createElement("a");
      a.href = mark.href || "#";
      a.target = "_blank";
      a.rel = "noreferrer";
      a.appendChild(el);
      return a;
    }
    if (t === "color") { const e = document.createElement("span"); e.style.color = mark.value || "inherit"; e.appendChild(el); return e; }
    if (t === "highlight") { const e = document.createElement("span"); e.style.backgroundColor = mark.value || "rgba(102,204,255,.25)"; e.appendChild(el); return e; }
    return el;
  }

  function inlineToFragment(inline) {
    const frag = document.createDocumentFragment();
    const list = Array.isArray(inline) ? inline : [];
    for (const token of list) {
      if (!token || token.type === "empty") continue;
      if (token.type === "hardBreak") { frag.appendChild(document.createElement("br")); continue; }
      let el = document.createTextNode(token.text || "");
      const marks = Array.isArray(token.marks) ? token.marks : [];
      for (let i = marks.length - 1; i >= 0; i--) el = markElement(marks[i], el);
      frag.appendChild(el);
    }
    return frag;
  }

  function inlineText(inline) {
    return (Array.isArray(inline) ? inline : []).map((t) => {
      if (!t) return "";
      if (t.type === "hardBreak") return "\n";
      return t.text || "";
    }).join("");
  }

  function blockToElement(block) {
    const type = block.type || "paragraph";
    let el;
    if (type === "heading") {
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      el = document.createElement("h" + level);
    } else if (type === "bulletList" || type === "orderedList") {
      el = document.createElement(type === "bulletList" ? "ul" : "ol");
      for (const rawItem of block.items || []) {
        const item = Array.isArray(rawItem) ? { children: rawItem, blocks: [] } : (rawItem || {});
        const li = document.createElement("li");
        li.appendChild(inlineToFragment(item.children || []));
        for (const nested of item.blocks || []) {
          if (nested && (nested.type === "bulletList" || nested.type === "orderedList" || nested.type === "taskList"))
            li.appendChild(blockToElement(nested));
        }
        el.appendChild(li);
      }
      return el;
    } else if (type === "taskList") {
      el = document.createElement("ul");
      el.className = "task-list";
      for (const rawItem of block.items || []) {
        const item = Array.isArray(rawItem) ? { checked: false, children: rawItem, blocks: [] } : (rawItem || {});
        const li = document.createElement("li");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!item.checked;
        li.appendChild(cb);
        li.appendChild(inlineToFragment(item.children || []));
        for (const nested of item.blocks || []) {
          if (nested && (nested.type === "bulletList" || nested.type === "orderedList" || nested.type === "taskList"))
            li.appendChild(blockToElement(nested));
        }
        el.appendChild(li);
      }
      return el;
    } else if (type === "blockquote") {
      el = document.createElement("blockquote");
    } else if (type === "codeBlock") {
      el = document.createElement("pre");
      el.textContent = block.text || inlineText(block.children);
      return el;
    } else if (type === "divider") {
      return document.createElement("hr");
    } else {
      el = document.createElement("p");
    }
    el.appendChild(inlineToFragment(block.children || []));
    return el;
  }

  function renderNote(note) {
    const editor = $("editor");
    editor.innerHTML = "";
    const blocks = Array.isArray(note.blocks) ? note.blocks : [];
    const list = blocks.length ? blocks : [{ id: uid("b"), type: "paragraph", children: [] }];
    for (const block of list) editor.appendChild(blockToElement(block));
    if (!editor.querySelector("p, h1, h2, h3, ul, ol, blockquote, pre, hr")) {
      editor.innerHTML = "<p><br></p>";
    }
  }

  // ---------- DOM -> 文档结构树 ----------
  function parseInline(node, inherited) {
    const out = [];
    if (!node) return out;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || "";
      if (text) out.push({ type: "text", text, marks: inherited.slice() });
      return out;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return out;
    const tag = (node.tagName || "").toUpperCase();
    if (tag === "BR") { out.push({ type: "hardBreak" }); return out; }
    if (tag === "SCRIPT" || tag === "STYLE") return out;
    const marks = inherited.slice();
    if (tag === "STRONG" || tag === "B") marks.push({ type: "bold" });
    else if (tag === "EM" || tag === "I") marks.push({ type: "italic" });
    else if (tag === "U") marks.push({ type: "underline" });
    else if (tag === "S" || tag === "STRIKE" || tag === "DEL") marks.push({ type: "strike" });
    else if (tag === "CODE") marks.push({ type: "inlineCode" });
    else if (tag === "A") marks.push({ type: "link", href: node.getAttribute("href") || "" });
    else if (tag === "SPAN") {
      const color = node.style && node.style.color;
      const bg = node.style && node.style.backgroundColor;
      if (color) marks.push({ type: "color", value: color });
      if (bg) marks.push({ type: "highlight", value: bg });
    }
    for (const child of node.childNodes) {
      for (const token of parseInline(child, marks)) out.push(token);
    }
    return out;
  }

  function parseListItem(li) {
    const children = [];
    const blocks = [];
    for (const child of li.childNodes) {
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child.tagName || "").toUpperCase() : "";
      if (tag === "UL" || tag === "OL") {
        const nested = blockFromElement(child);
        if (nested) blocks.push(nested);
      } else if (tag === "INPUT") {
        continue;
      } else {
        for (const token of parseInline(child, [])) children.push(token);
      }
    }
    return { children, blocks };
  }

  function blockFromElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      if (el && el.nodeType === Node.TEXT_NODE && el.nodeValue.trim()) {
        return { id: uid("b"), type: "paragraph", children: parseInline(el, []) };
      }
      return null;
    }
    if (el.id === "editor") return null;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") {
      return { id: uid("b"), type: "heading", level: Number(tag.slice(1)), children: parseInline(el, []) };
    }
    if (tag === "UL" || tag === "OL") {
      const isTask = el.classList.contains("task-list") || !!el.querySelector("input[type=checkbox]");
      const items = [];
      for (const child of el.childNodes) {
        const ctag = child.nodeType === Node.ELEMENT_NODE ? (child.tagName || "").toUpperCase() : "";
        if (ctag === "LI") {
          const parsed = parseListItem(child);
          if (isTask) {
            const cb = child.querySelector("input[type=checkbox]");
            items.push({ checked: !!(cb && cb.checked), children: parsed.children, blocks: parsed.blocks });
          } else {
            items.push({ children: parsed.children, blocks: parsed.blocks });
          }
        } else if ((ctag === "UL" || ctag === "OL") && items.length) {
          // contenteditable 的 indent 有时会把子列表生成在父 <ul> 的
          // 兄弟位置，而不是塞进上一个 <li> 里；这里统一挂到上一个条目。
          const nested = blockFromElement(child);
          if (nested) items[items.length - 1].blocks.push(nested);
        }
      }
      return { id: uid("b"), type: isTask ? "taskList" : tag === "UL" ? "bulletList" : "orderedList", items };
    }
    if (tag === "BLOCKQUOTE") return { id: uid("b"), type: "blockquote", children: parseInline(el, []) };
    if (tag === "PRE") return { id: uid("b"), type: "codeBlock", text: el.textContent || "" };
    if (tag === "HR") return { id: uid("b"), type: "divider" };
    if (tag === "DIV" && el.querySelector("p,h1,h2,h3,ul,ol,blockquote,pre,hr")) {
      const out = [];
      for (const child of el.childNodes) {
        const b = blockFromElement(child);
        if (b) out.push(b);
      }
      return out;
    }
    return { id: uid("b"), type: "paragraph", children: parseInline(el, []) };
  }

  function blocksFromEditor() {
    const editor = $("editor");
    const blocks = [];
    for (const child of editor.childNodes) {
      const b = blockFromElement(child);
      if (Array.isArray(b)) blocks.push(...b);
      else if (b) blocks.push(b);
    }
    if (!blocks.length) blocks.push({ id: uid("b"), type: "paragraph", children: [] });
    return blocks;
  }

  // ---------- 段落样式：跟随当前段落的左侧按钮 ----------
  let savedRange = null;
  let activeBlock = null;

  function topLevelBlock(node) {
    const editor = $("editor");
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !editor.contains(el)) return null;
    while (el && el !== editor) {
      if (el.parentElement === editor) return el;
      el = el.parentElement;
    }
    return null;
  }

  function blockLabel(el) {
    if (!el) return "";
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "H1") return "标题 1";
    if (tag === "H2") return "标题 2";
    if (tag === "H3") return "标题 3";
    if (tag === "H4" || tag === "H5" || tag === "H6") return "标题";
    if (tag === "BLOCKQUOTE") return "引用";
    if (tag === "PRE") return "代码块";
    if (tag === "UL" || tag === "OL") return "列表";
    return "正文";
  }

  function hideBlockOverlays() {
    $("blockHandle").hidden = true;
    $("blockMenu").hidden = true;
  }

  function updateBlockHandle() {
    const editor = $("editor");
    const handle = $("blockHandle");
    const menu = $("blockMenu");
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor || !editor.contains(sel.anchorNode)) {
      hideBlockOverlays();
      return;
    }
    const block = topLevelBlock(sel.anchorNode);
    if (!block) {
      // 浏览器在空白 contenteditable 里可能把光标放到编辑器根节点，
      // 先把它规整成一个段落，再显示段落样式按钮。
      if (sel.anchorNode === editor && sel.rangeCount) {
        try { document.execCommand("formatBlock", false, "p"); } catch { }
        setTimeout(updateBlockHandle, 0);
        return;
      }
      hideBlockOverlays();
      return;
    }
    const tag = (block.tagName || "").toUpperCase();
    if (tag === "UL" || tag === "OL" || tag === "HR" || tag === "IMG" || tag === "TABLE") {
      hideBlockOverlays();
      return;
    }
    activeBlock = block;
    savedRange = sel.getRangeAt(0).cloneRange();
    const wrap = document.querySelector(".editor-wrap");
    const wr = wrap.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    const label = blockLabel(block);
    handle.textContent = "⋮";
    handle.title = "段落样式：" + label;
    handle.style.left = Math.max(2, Math.round(br.left - wr.left - 26)) + "px";
    handle.style.top = Math.max(0, Math.round(br.top - wr.top + 1)) + "px";
    handle.hidden = false;
    menu.hidden = true;
    document.querySelectorAll("#blockMenu button[data-block]").forEach((btn) => {
      const tag = (block.tagName || "").toLowerCase();
      const active = (tag === "h" + (btn.dataset.block || "").slice(1) && btn.dataset.block.startsWith("h")) ||
        (tag === "p" && btn.dataset.block === "p") ||
        (tag === "blockquote" && btn.dataset.block === "blockquote") ||
        (tag === "pre" && btn.dataset.block === "pre");
      btn.classList.toggle("active", !!active);
    });
  }

  function restoreSelection() {
    const editor = $("editor");
    editor.focus();
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function applyBlockType(tag) {
    try {
      restoreSelection();
      document.execCommand("formatBlock", false, tag);
      markDirty();
      setTimeout(updateBlockHandle, 30);
    } catch { }
  }

  function showBlockMenu() {
    const handle = $("blockHandle");
    const menu = $("blockMenu");
    if (handle.hidden) return;
    const wrap = document.querySelector(".editor-wrap");
    const wr = wrap.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.round(hr.left - wr.left)) + "px";
    menu.style.top = Math.round(hr.bottom - wr.top + 4) + "px";
    menu.hidden = false;
  }

  function insertTaskList() {
    try {
      document.execCommand("insertHTML", false,
        '<ul class="task-list"><li><input type="checkbox"> 待办事项</li></ul>');
      markDirty();
      $("editor").focus();
    } catch { }
  }

  function closestCode(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const editor = $("editor");
    while (el && el !== editor) {
      if (el.nodeType === Node.ELEMENT_NODE && (el.tagName || "").toUpperCase() === "CODE") return el;
      el = el.parentElement;
    }
    return null;
  }

  function toggleInlineCode() {
    try {
      const editor = $("editor");
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      if (range.collapsed) return;

      const startCode = closestCode(range.startContainer);
      const endCode = closestCode(range.endContainer);
      // 选中内容已经在同一个 <code> 里：再次点击是取消，不是套第二层。
      if (startCode && startCode === endCode) {
        const parent = startCode.parentNode;
        while (startCode.firstChild) parent.insertBefore(startCode.firstChild, startCode);
        parent.removeChild(startCode);
        parent.normalize();
        markDirty();
        setTimeout(updateBlockHandle, 0);
        return;
      }
      // 跨段落/跨代码边界时不做复杂拼接，避免生成坏结构。
      if (!topLevelBlock(range.commonAncestorContainer)) return;

      const fragment = range.extractContents();
      for (const oldCode of Array.from(fragment.querySelectorAll("code"))) {
        while (oldCode.firstChild) oldCode.parentNode.insertBefore(oldCode.firstChild, oldCode);
        oldCode.parentNode.removeChild(oldCode);
      }
      const code = document.createElement("code");
      code.appendChild(fragment);
      range.insertNode(code);
      const after = document.createRange();
      after.selectNodeContents(code);
      sel.removeAllRanges();
      sel.addRange(after);
      markDirty();
      setTimeout(updateBlockHandle, 0);
    } catch { }
  }

  function insertLink() {
    try {
      const url = prompt("输入链接地址（https://…）", "https://");
      if (!url || url === "https://") return;
      document.execCommand("createLink", false, url);
      markDirty();
    } catch { }
  }

  function normalizeListDom() {
    const editor = $("editor");
    if (!editor) return;
    // contenteditable 的 indent 常把子列表放在父列表的兄弟位置；
    // 归一到“子列表放进上一个 li”的标准结构，方便再次编辑。
    for (const list of Array.from(editor.querySelectorAll("ul,ol"))) {
      for (const child of Array.from(list.children)) {
        const tag = (child.tagName || "").toUpperCase();
        if ((tag === "UL" || tag === "OL") && child.previousElementSibling &&
            (child.previousElementSibling.tagName || "").toUpperCase() === "LI") {
          child.previousElementSibling.appendChild(child);
        }
      }
    }
  }

  function applyColor(kind, value) {
    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand(kind === "highlight" ? "hiliteColor" : "foreColor", false, value);
      markDirty();
    } catch { }
  }

  // ---------- 笔记/元数据 ----------
  function currentMeta() {
    return state.manifest && state.manifest.notes.find((n) => n.id === state.currentId) || null;
  }

  function setSaveState(text, cls) {
    const el = $("saveState");
    el.textContent = text;
    el.className = "save-state" + (cls ? " " + cls : "");
  }

  function markDirty() {
    state.dirty = true;
    setSaveState("未保存", "saving");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => { saveNow().catch(showError); }, 1000);
  }

  function noteTitleFromEditor() {
    const t = $("noteTitle").value.trim();
    return t || "未命名笔记";
  }

  function syncCurrentNote() {
    const meta = currentMeta();
    if (!meta) return;
    meta.title = noteTitleFromEditor();
    meta.updatedAt = nowIso();
    let content = state.contents.get(meta.id);
    if (!content) { content = makeDefaultNote(meta.title); content.id = meta.id; state.contents.set(meta.id, content); }
    content.title = meta.title;
    content.blocks = blocksFromEditor();
    state.manifest.updatedAt = nowIso();
  }

  // ---------- 保存 ----------
  async function saveNow() {
    if (state.saveInFlight) return;
    if (!state.manifest) return;
    state.saveInFlight = true;
    clearTimeout(state.saveTimer);
    try {
      syncCurrentNote();
      setSaveState("保存中…", "saving");
      const zip = new JSZip();
      zip.file("mimetype", MIME, { compression: "STORE" });
      zip.file("manifest.json", JSON.stringify(state.manifest, null, 2));
      for (const [id, note] of state.contents.entries()) {
        zip.file("notes/" + id + ".json", JSON.stringify(note, null, 2));
      }
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const res = await hostCall("host.workspace.save", { data: bytesToBase64(bytes) });
      if (!res || !res.ok) throw new Error((res && res.error) || "保存失败");
      state.dirty = false;
      setSaveState("已保存 " + new Date().toLocaleTimeString().slice(0, 5), "");
      renderNoteList();
    } catch (e) {
      setSaveState("保存失败", "error");
      throw e;
    } finally {
      state.saveInFlight = false;
    }
  }

  // ---------- 界面 ----------
  function renderNoteList() {
    const list = $("noteList");
    const q = ($("searchNotes").value || "").trim().toLowerCase();
    const notes = (state.manifest ? state.manifest.notes.slice() : [])
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .filter((n) => !q || (n.title || "").toLowerCase().includes(q));
    $("noteCount").textContent = String(state.manifest ? state.manifest.notes.length : 0);
    list.innerHTML = "";
    for (const n of notes) {
      const item = document.createElement("div");
      item.className = "note-item" + (n.id === state.currentId ? " active" : "");
      item.innerHTML = `<div class="n-title">${escapeHtml(n.title || "未命名笔记")}</div><div class="n-date">${escapeHtml(fmtDate(n.updatedAt))}</div>`;
      item.addEventListener("click", () => selectNote(n.id).catch(showError));
      list.appendChild(item);
    }
  }

  function fillEditorFromCurrent() {
    const meta = currentMeta();
    if (!meta) return;
    const content = state.contents.get(meta.id) || makeDefaultNote(meta.title);
    state.contents.set(meta.id, content);
    $("noteTitle").value = meta.title || content.title || "未命名笔记";
    renderNote(content);
  }

  async function selectNote(id) {
    if (id === state.currentId) return;
    if (state.dirty) await saveNow();
    state.currentId = id;
    const meta = currentMeta();
    if (!meta) return;
    $("noteTitle").value = meta.title || "未命名笔记";
    fillEditorFromCurrent();
    renderNoteList();
  }

  async function createNote() {
    try {
      if (state.dirty) await saveNow();
      const note = makeDefaultNote("未命名笔记");
      const now = nowIso();
      const meta = {
        id: note.id, title: note.title, parentId: null,
        order: state.manifest.notes.length,
        createdAt: now, updatedAt: now, tags: [], pinned: false,
      };
      state.manifest.notes.push(meta);
      state.contents.set(note.id, note);
      state.currentId = note.id;
      $("noteTitle").value = note.title;
      fillEditorFromCurrent();
      renderNoteList();
      markDirty();
      $("noteTitle").focus();
      $("noteTitle").select();
    } catch (e) { showError(e); }
  }

  async function deleteNote() {
    const meta = currentMeta();
    if (!meta) return;
    if (state.manifest.notes.length <= 1) { alert("至少保留一篇笔记"); return; }
    if (!confirm("删除笔记“" + (meta.title || "未命名笔记") + "”？")) return;
    state.manifest.notes = state.manifest.notes.filter((n) => n.id !== meta.id);
    state.contents.delete(meta.id);
    const next = state.manifest.notes.slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
    state.currentId = next ? next.id : null;
    if (next) fillEditorFromCurrent();
    renderNoteList();
    markDirty();
  }

  // ---------- 打开/初始化 ----------
  async function loadPackage(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const mf = zip.file("manifest.json");
    if (!mf) throw new Error("缺少 manifest.json");
    const manifest = JSON.parse(await mf.async("string"));
    if (manifest.format !== FORMAT) throw new Error("不是 .lyrnb 笔记本文件");
    if (Number(manifest.formatVersion) > FORMAT_VERSION) throw new Error("这个笔记本由更高版本创建，请升级主程序");
    if (!Array.isArray(manifest.notes) || manifest.notes.length === 0) {
      manifest.notes = [];
    }
    const contents = new Map();
    for (const meta of manifest.notes) {
      const f = zip.file("notes/" + meta.id + ".json");
      if (!f) {
        const n = makeDefaultNote(meta.title);
        n.id = meta.id;
        contents.set(meta.id, n);
      } else {
        contents.set(meta.id, JSON.parse(await f.async("string")));
      }
    }
    state.manifest = manifest;
    state.contents = contents;
    state.currentId = manifest.notes[0].id;
  }

  async function init() {
    if (!host) { showError(new Error("请从璃鸢镜扩展中打开笔记本")); return; }
    const res = await hostCall("host.workspace.load");
    if (!res || !res.ok) throw new Error((res && res.error) || "读取笔记本失败");
    if (!res.data) {
      const d = makeDefaultManifest();
      state.manifest = d.manifest;
      state.contents = d.notes;
      state.currentId = d.manifest.notes[0].id;
      await saveNow();
    } else {
      await loadPackage(base64ToBytes(res.data));
    }
    if (!state.manifest.notes.length) {
      const t = makeDefaultNote("第一篇笔记");
      state.manifest.notes.push({ id: t.id, title: t.title, parentId: null, order: 0, createdAt: nowIso(), updatedAt: nowIso(), tags: [], pinned: false });
      state.contents.set(t.id, t);
      state.currentId = t.id;
    }
    if (!state.currentId) state.currentId = state.manifest.notes[0].id;
    $("notebookTitle").value = state.manifest.title || "未命名笔记本";
    fillEditorFromCurrent();
    renderNoteList();
    setSaveState("已保存");
  }

  function showError(e) {
    $("errorText").textContent = String(e && e.message ? e.message : e);
    $("errorMask").hidden = false;
  }

  // ---------- 事件 ----------
  function bind() {
    $("newNoteBtn").addEventListener("click", createNote);
    $("deleteNoteBtn").addEventListener("click", deleteNote);
    $("searchNotes").addEventListener("input", renderNoteList);
    $("noteTitle").addEventListener("input", markDirty);
    $("notebookTitle").addEventListener("input", () => {
      if (!state.manifest) return;
      state.manifest.title = $("notebookTitle").value.trim() || "未命名笔记本";
      state.manifest.updatedAt = nowIso();
      markDirty();
    });
    $("editor").addEventListener("input", () => {
      markDirty();
      requestAnimationFrame(updateBlockHandle);
    });
    $("editor").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNow().catch(showError); return; }
      if (e.key === "Tab") {
        const sel = window.getSelection();
        const block = sel && sel.rangeCount ? topLevelBlock(sel.anchorNode) : null;
        const tag = block ? (block.tagName || "").toUpperCase() : "";
        if (tag === "UL" || tag === "OL") {
          e.preventDefault();
          document.execCommand(e.shiftKey ? "outdent" : "indent", false, null);
          setTimeout(normalizeListDom, 0);
          markDirty();
          setTimeout(updateBlockHandle, 0);
        }
      }
    });
    document.querySelectorAll(".toolbar button[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        document.execCommand(cmd, false, null);
        if (cmd === "indent" || cmd === "outdent") setTimeout(normalizeListDom, 0);
        markDirty();
        $("editor").focus();
      });
    });
    document.querySelectorAll(".toolbar button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "inlineCode") toggleInlineCode();
        else if (action === "link") insertLink();
        else if (action === "taskList") insertTaskList();
        $("editor").focus();
      });
    });
    $("blockHandle").addEventListener("mousedown", (e) => e.preventDefault());
    $("blockHandle").addEventListener("click", (e) => {
      e.preventDefault();
      showBlockMenu();
    });
    $("blockMenu").addEventListener("mousedown", (e) => e.preventDefault());
    document.querySelectorAll("#blockMenu button[data-block]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        applyBlockType(btn.dataset.block);
        $("blockMenu").hidden = true;
      });
    });
    document.addEventListener("selectionchange", () => updateBlockHandle());
    document.addEventListener("mousedown", (e) => {
      const wrap = document.querySelector(".editor-wrap");
      if (wrap && !wrap.contains(e.target)) hideBlockOverlays();
    });
    $("editor").addEventListener("scroll", updateBlockHandle);
    window.addEventListener("resize", updateBlockHandle);
    $("editor").addEventListener("change", (e) => {
      if (e.target && e.target.type === "checkbox") markDirty();
    });
    $("textColor").addEventListener("input", (e) => applyColor("text", e.target.value));
    $("highlightColor").addEventListener("input", (e) => applyColor("highlight", e.target.value));
    $("editor").addEventListener("paste", (e) => {
      // 粘贴内容最终仍会被序列化成结构树，避免把外部 HTML 原样存进文件。
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      if (text) { e.preventDefault(); document.execCommand("insertText", false, text); }
    });
    window.addEventListener("beforeunload", () => {
      if (!state.dirty) return;
      try { saveNow(); } catch { }
    });
  }

  bind();
  init().catch(showError);
})();

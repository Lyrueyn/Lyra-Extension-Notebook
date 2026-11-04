(() => {
  "use strict";

  const FORMAT = "lyra-notebook";
  const FORMAT_VERSION = 2;
  const MIME = "application/vnd.lyra.notebook+zip";
  const PREVIEW_SOURCE = "lyra-html-notebook";
  const $ = (id) => document.getElementById(id);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

  const state = {
    manifest: null,
    notes: new Map(),
    assets: new Map(),
    currentId: null,
    sourceMap: {},
    selectedSrcId: null,
    selectedSelector: "",
    selectedLine: 0,
    inspectMode: false,
    dirty: false,
    saveTimer: 0,
    previewTimer: 0,
    saveInFlight: false,
    hostSeq: 0,
    pending: new Map(),
    syncingControls: false,
    mirror: null,
    suppressMirror: false,
    highlightedLine: 0,
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
      }, 30000);
    });
  }
  if (host) {
    host.addEventListener("message", (event) => {
      const data = event.data || {};
      const resolve = state.pending.get(data.requestId);
      if (resolve) { state.pending.delete(data.requestId); resolve(data); }
    });
    host.postMessage({ type: "host.ready" });
  }

  // ---------- 基础工具 ----------
  function uid(prefix) {
    const s = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    return prefix + "-" + s;
  }
  function nowIso() { return new Date().toISOString(); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, "&#96;"); }
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
  function assetDataUrl(asset) {
    return asset ? "data:" + (asset.mime || "application/octet-stream") + ";base64," + asset.base64 : "";
  }

  // ---------- Dev Tool 样式字段 ----------
  const STYLE_GROUPS = [
    {
      title: "Layout",
      fields: [
        { p: "display", t: "select", o: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "none"] },
        { p: "position", t: "select", o: ["static", "relative", "absolute", "fixed", "sticky"] },
        { p: "top", t: "text", ph: "auto" },
        { p: "right", t: "text", ph: "auto" },
        { p: "bottom", t: "text", ph: "auto" },
        { p: "left", t: "text", ph: "auto" },
        { p: "zIndex", t: "text", ph: "auto" },
        { p: "float", t: "select", o: ["none", "left", "right"] },
        { p: "clear", t: "select", o: ["none", "both", "left", "right"] },
        { p: "boxSizing", t: "select", o: ["content-box", "border-box"] },
        { p: "overflow", t: "select", o: ["visible", "hidden", "scroll", "auto", "clip"] },
        { p: "overflowX", t: "select", o: ["visible", "hidden", "scroll", "auto", "clip"] },
        { p: "overflowY", t: "select", o: ["visible", "hidden", "scroll", "auto", "clip"] },
        { p: "visibility", t: "select", o: ["visible", "hidden", "collapse"] },
      ],
    },
    {
      title: "Flex / Grid",
      fields: [
        { p: "flexDirection", t: "select", o: ["row", "row-reverse", "column", "column-reverse"] },
        { p: "flexWrap", t: "select", o: ["nowrap", "wrap", "wrap-reverse"] },
        { p: "justifyContent", t: "select", o: ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end", "normal"] },
        { p: "alignItems", t: "select", o: ["stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"] },
        { p: "alignContent", t: "select", o: ["stretch", "flex-start", "flex-end", "center", "space-between", "space-around", "start", "end"] },
        { p: "alignSelf", t: "select", o: ["auto", "stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"] },
        { p: "gap", t: "text", ph: "0px" },
        { p: "rowGap", t: "text", ph: "0px" },
        { p: "columnGap", t: "text", ph: "0px" },
        { p: "flexGrow", t: "text", ph: "0" },
        { p: "flexShrink", t: "text", ph: "1" },
        { p: "flexBasis", t: "text", ph: "auto" },
        { p: "order", t: "text", ph: "0" },
        { p: "gridTemplateColumns", t: "text", ph: "1fr 1fr" },
        { p: "gridTemplateRows", t: "text", ph: "auto" },
        { p: "gridAutoFlow", t: "select", o: ["row", "column", "dense", "row dense", "column dense"] },
        { p: "gridColumn", t: "text", ph: "auto" },
        { p: "gridRow", t: "text", ph: "auto" },
      ],
    },
    {
      title: "Size",
      fields: [
        { p: "width", t: "text", ph: "auto" },
        { p: "minWidth", t: "text", ph: "auto" },
        { p: "maxWidth", t: "text", ph: "none" },
        { p: "height", t: "text", ph: "auto" },
        { p: "minHeight", t: "text", ph: "auto" },
        { p: "maxHeight", t: "text", ph: "none" },
        { p: "aspectRatio", t: "text", ph: "auto" },
      ],
    },
    {
      title: "Spacing",
      fields: [
        { p: "paddingTop", t: "text", ph: "0px" },
        { p: "paddingRight", t: "text", ph: "0px" },
        { p: "paddingBottom", t: "text", ph: "0px" },
        { p: "paddingLeft", t: "text", ph: "0px" },
        { p: "marginTop", t: "text", ph: "0px" },
        { p: "marginRight", t: "text", ph: "0px" },
        { p: "marginBottom", t: "text", ph: "0px" },
        { p: "marginLeft", t: "text", ph: "0px" },
      ],
    },
    {
      title: "Typography",
      fields: [
        { p: "fontFamily", t: "text", ph: "inherit" },
        { p: "fontSize", t: "text", ph: "16px" },
        { p: "fontWeight", t: "select", o: ["100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold"] },
        { p: "fontStyle", t: "select", o: ["normal", "italic", "oblique"] },
        { p: "lineHeight", t: "text", ph: "normal" },
        { p: "letterSpacing", t: "text", ph: "normal" },
        { p: "wordSpacing", t: "text", ph: "normal" },
        { p: "textAlign", t: "select", o: ["left", "center", "right", "justify", "start", "end"] },
        { p: "textIndent", t: "text", ph: "0px" },
        { p: "textTransform", t: "select", o: ["none", "uppercase", "lowercase", "capitalize"] },
        { p: "textDecoration", t: "select", o: ["none", "underline", "overline", "line-through"] },
        { p: "whiteSpace", t: "select", o: ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"] },
        { p: "wordBreak", t: "select", o: ["normal", "break-all", "keep-all", "break-word"] },
        { p: "overflowWrap", t: "select", o: ["normal", "break-word", "anywhere"] },
        { p: "color", t: "color" },
      ],
    },
    {
      title: "Background / Border",
      fields: [
        { p: "backgroundColor", t: "color" },
        { p: "backgroundImage", t: "text", ph: "none" },
        { p: "backgroundSize", t: "text", ph: "auto" },
        { p: "backgroundPosition", t: "text", ph: "0% 0%" },
        { p: "backgroundRepeat", t: "select", o: ["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"] },
        { p: "borderWidth", t: "text", ph: "0px" },
        { p: "borderStyle", t: "select", o: ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"] },
        { p: "borderColor", t: "color" },
        { p: "borderRadius", t: "text", ph: "0px" },
        { p: "outline", t: "text", ph: "none" },
        { p: "boxShadow", t: "text", ph: "none" },
      ],
    },
    {
      title: "Effects / Misc",
      fields: [
        { p: "opacity", t: "text", ph: "1" },
        { p: "transform", t: "text", ph: "none" },
        { p: "transformOrigin", t: "text", ph: "center" },
        { p: "transition", t: "text", ph: "none" },
        { p: "filter", t: "text", ph: "none" },
        { p: "backdropFilter", t: "text", ph: "none" },
        { p: "cursor", t: "select", o: ["auto", "default", "pointer", "text", "move", "grab", "not-allowed"] },
        { p: "listStyleType", t: "select", o: ["disc", "circle", "square", "decimal", "lower-alpha", "upper-alpha", "none"] },
        { p: "tableLayout", t: "select", o: ["auto", "fixed"] },
        { p: "borderCollapse", t: "select", o: ["separate", "collapse"] },
        { p: "verticalAlign", t: "select", o: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom"] },
      ],
    },
  ];

  function renderStyleControls() {
    const hostEl = $("styleControls");
    hostEl.innerHTML = "";
    for (const group of STYLE_GROUPS) {
      const section = document.createElement("section");
      section.className = "inspector-group";
      const title = document.createElement("h3");
      title.textContent = group.title;
      section.appendChild(title);
      for (const field of group.fields) {
        const row = document.createElement("div");
        row.className = "style-field";
        const label = document.createElement("span");
        label.textContent = field.p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        row.appendChild(label);
        let input;
        if (field.t === "select") {
          input = document.createElement("select");
          for (const opt of field.o) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            input.appendChild(o);
          }
        } else if (field.t === "color") {
          input = document.createElement("input");
          input.type = "color";
          input.value = "#ffffff";
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.placeholder = field.ph || "";
          input.spellcheck = false;
        }
        input.dataset.style = field.p;
        input.disabled = true;
        row.appendChild(input);
        section.appendChild(row);
      }
      hostEl.appendChild(section);
    }
  }

  // ---------- CodeMirror 源码编辑器 ----------
  function getSource() {
    return state.mirror ? state.mirror.getValue() : "";
  }
  function setSourceValue(text, resetHistory) {
    if (!state.mirror) return;
    state.suppressMirror = true;
    try {
      state.mirror.setValue(text || "");
      if (resetHistory) {
        state.mirror.clearHistory();
        state.mirror.setCursor({ line: 0, ch: 0 });
      }
    } finally {
      state.suppressMirror = false;
    }
  }
  function showCmHint(cm) {
    if (!cm || !cm.showHint) return;
    const pos = cm.getCursor();
    const mode = cm.getModeAt(pos);
    const helper = mode && mode.helperType ? mode.helperType : (mode && mode.name) || "";
    let hint = null;
    if (helper === "html" || helper === "xml" || /html|xml/i.test(helper)) {
      hint = CodeMirror.hint.html || CodeMirror.hint.xml;
    } else if (helper === "css" || /css/i.test(helper)) {
      hint = CodeMirror.hint.css;
    } else if (helper === "javascript" || /javascript/i.test(helper)) {
      hint = CodeMirror.hint.javascript;
    }
    if (!hint) hint = CodeMirror.hint.html || CodeMirror.hint.xml;
    cm.showHint({ hint: hint, completeSingle: false });
  }
  function initSourceEditor() {
    if (state.mirror || !window.CodeMirror) return;
    const cm = CodeMirror($("sourceEditor"), {
      value: "",
      mode: "htmlmixed",
      theme: "lyra",
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      autoCloseTags: true,
      styleActiveLine: true,
      foldGutter: true,
      gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
      hintOptions: { completeSingle: false, closeOnUnfocus: true },
      extraKeys: {
        "Ctrl-Space": (editor) => showCmHint(editor),
        "Shift-Ctrl-Space": (editor) => showCmHint(editor),
      },
    });
    state.mirror = cm;
    cm.on("change", () => {
      if (state.suppressMirror) return;
      const note = currentNote();
      if (note) note.html = cm.getValue();
      clearSelection();
      markDirty();
      schedulePreview(false);
      scheduleSave();
    });
    cm.on("inputRead", (editor, change) => {
      if (state.suppressMirror) return;
      const text = change.text.join("");
      // 输入 <、属性空格、=、引号时给出基础补全提示；Ctrl+Space 随时可手动打开。
      if (text === "<" || text === " " || text === "=" || text === '"' || text === "'") {
        clearTimeout(editor._lyraHintTimer);
        editor._lyraHintTimer = setTimeout(() => {
          if (!editor.state.completionActive) showCmHint(editor);
        }, 120);
      }
    });
    cm.on("cursorActivity", () => {
      const line = cm.getCursor().line + 1;
      $("sourcePos").textContent = "Ln " + line;
    });
  }

  // ---------- 默认内容 ----------
  function defaultHtml() {
    return `<h1>新笔记</h1>
<p>左边写 HTML，中间实时预览，右边检查元素并调整样式。</p>
`;
  }
  function defaultNote(title) {
    const id = uid("note");
    const now = nowIso();
    return {
      meta: {
        id, title: title || "未命名笔记", type: "html", parentId: null, order: 0,
        createdAt: now, updatedAt: now, tags: [], pinned: false,
      },
      html: defaultHtml(),
    };
  }
  function defaultManifest() {
    const n = defaultNote("新笔记");
    const now = nowIso();
    return {
      manifest: {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        id: uid("book"),
        title: "未命名笔记本",
        createdAt: now,
        updatedAt: now,
        appVersion: "1.0.0",
        notes: [n.meta],
        assets: [],
        settings: { theme: "dark" },
      },
      notes: new Map([[n.meta.id, n]]),
    };
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

  // ---------- 源码标注：给源标签打上 srcId，映射回源码偏移/行号 ----------
  function findTagEnd(source, start) {
    let quote = "";
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === ">") return i;
    }
    return -1;
  }
  function annotateHtml(source) {
    let out = "", i = 0, id = 0, line = 1;
    const map = {};
    const countLines = (s) => (s.match(/\n/g) || []).length;
    while (i < source.length) {
      if (source.startsWith("<!--", i)) {
        let end = source.indexOf("-->", i + 4);
        end = end < 0 ? source.length : end + 3;
        const chunk = source.slice(i, end);
        out += chunk; line += countLines(chunk); i = end; continue;
      }
      if (source[i] === "<") {
        if (source[i + 1] === "/" || source[i + 1] === "!" || source[i + 1] === "?") {
          const end = findTagEnd(source, i);
          if (end < 0) { out += source.slice(i); break; }
          const chunk = source.slice(i, end + 1);
          out += chunk; line += countLines(chunk); i = end + 1; continue;
        }
        const end = findTagEnd(source, i);
        if (end < 0) { out += source.slice(i); break; }
        const raw = source.slice(i, end + 1);
        const m = raw.match(/^<\s*([a-zA-Z][\w:-]*)/);
        if (!m) { out += raw; line += countLines(raw); i = end + 1; continue; }
        const tag = m[1].toLowerCase();
        id++;
        const injected = /\/\s*>$/.test(raw)
          ? raw.replace(/\/\s*>$/, ' data-lyra-src="' + id + '"/>')
          : raw.replace(/>$/, ' data-lyra-src="' + id + '">');
        out += injected;
        map[id] = { start: i, end: end + 1, line: line, tag: tag };
        line += countLines(raw);
        i = end + 1;
        if (tag === "script" || tag === "style" || tag === "textarea") {
          try {
            const re = new RegExp("</" + tag + "\\s*>", "i");
            const cm = re.exec(source.slice(i));
            if (cm) {
              const closeStart = i + cm.index;
              const closeEnd = closeStart + cm[0].length;
              const chunk = source.slice(i, closeEnd);
              out += chunk; line += countLines(chunk); i = closeEnd;
            }
          } catch { }
        }
        continue;
      }
      const next = source.indexOf("<", i);
      const end = next < 0 ? source.length : next;
      const chunk = source.slice(i, end);
      out += chunk; line += countLines(chunk); i = end;
    }
    return { html: out, map };
  }

  // ---------- 注入预览的检查器 ----------
  function inspectorScript() {
    return `
(function(){
  var SOURCE = ${JSON.stringify(PREVIEW_SOURCE)};
  var inspect = false, hovered = null, hoverOldOutline = "", hoverOldOffset = "";
  function send(type, data) {
    var msg = Object.assign({ source: SOURCE, type: type }, data || {});
    try { parent.postMessage(msg, "*"); } catch(e) {}
  }
  function annotated(el) {
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1 && el.hasAttribute && el.hasAttribute("data-lyra-src")) return el;
      el = el.parentElement;
    }
    return null;
  }
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var part = el.tagName.toLowerCase();
      if (el.classList && el.classList.length) part += "." + Array.prototype.map.call(el.classList, cssEscape).join(".");
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function(c){ return c.tagName === el.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(part);
      if (el.id) { parts[0] = "#" + cssEscape(el.id); break; }
      el = parent;
    }
    return parts.join(" > ");
  }
  var COMPUTED = ["display","position","top","right","bottom","left","zIndex","float","clear","boxSizing","overflow","overflowX","overflowY","visibility","flexDirection","flexWrap","justifyContent","alignItems","alignContent","alignSelf","gap","rowGap","columnGap","flexGrow","flexShrink","flexBasis","order","gridTemplateColumns","gridTemplateRows","gridAutoFlow","gridColumn","gridRow","width","minWidth","maxWidth","height","minHeight","maxHeight","aspectRatio","paddingTop","paddingRight","paddingBottom","paddingLeft","marginTop","marginRight","marginBottom","marginLeft","fontFamily","fontSize","fontWeight","fontStyle","lineHeight","letterSpacing","wordSpacing","textAlign","textIndent","textTransform","textDecoration","whiteSpace","wordBreak","overflowWrap","color","backgroundColor","backgroundImage","backgroundSize","backgroundPosition","backgroundRepeat","borderWidth","borderStyle","borderColor","borderRadius","outline","boxShadow","opacity","transform","transformOrigin","transition","filter","backdropFilter","cursor","listStyleType","tableLayout","borderCollapse","verticalAlign"];
  function pick(el) {
    var cs = getComputedStyle(el);
    var computed = {};
    COMPUTED.forEach(function(p){ computed[p] = cs[p]; });
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
    return {
      srcId: el.getAttribute("data-lyra-src") || "",
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      inlineStyle: el.getAttribute("style") || "",
      computed: computed,
      text: text
    };
  }
  function clearHover() {
    if (hovered) {
      try { hovered.style.outline = hoverOldOutline; hovered.style.outlineOffset = hoverOldOffset; } catch(e) {}
    }
    hovered = null;
  }
  function setHover(el) {
    if (hovered === el) return;
    clearHover();
    if (!el) return;
    hovered = el;
    hoverOldOutline = el.style.outline || "";
    hoverOldOffset = el.style.outlineOffset || "";
    el.style.outline = "2px solid #66ccff";
    el.style.outlineOffset = "1px";
  }
  document.addEventListener("mouseover", function(e){
    if (!inspect) return;
    var el = annotated(e.target);
    setHover(el);
  }, true);
  document.addEventListener("mouseout", function(e){
    if (!inspect) return;
    if (!e.relatedTarget) clearHover();
  }, true);
  document.addEventListener("click", function(e){
    if (!inspect) return;
    var el = annotated(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    setHover(el);
    send("select", pick(el));
  }, true);
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === "inspect") { inspect = !!d.value; if (!inspect) clearHover(); }
    else if (d.type === "reselect") {
      try {
        var el = d.selector ? document.querySelector(d.selector) : null;
        if (el) { setHover(el); var d = pick(el); d.reselect = true; send("select", d); }
      } catch(err) {}
    }
  });
  send("ready");
})();
`.replace(/<\/script>/gi, "<\\/script>");
  }

  const BASE_CSS = `
html, body { min-height: 100%; }
body {
  margin: 0; padding: 24px; background: #ffffff; color: #1f2937;
  font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
td, th { border: 1px solid #d8dee8; padding: 6px 8px; }
a { color: #1d8fc0; }
blockquote { margin: 12px 0; padding: 4px 14px; border-left: 3px solid #66ccff; background: #f4f9fc; color: #53657a; }
pre { background: #f4f6f9; border: 1px solid #e4e9f0; border-radius: 6px; padding: 12px; overflow: auto; }
code { font-family: Consolas, "Cascadia Mono", monospace; background: #f1f4f8; padding: 1px 4px; border-radius: 4px; }
`;

  function injectPreview(sourceAnnotated, isDoc) {
    const css = "<style>" + BASE_CSS + "</style>";
    const script = "<script>" + inspectorScript() + "<\/script>";
    let html = sourceAnnotated;
    if (isDoc) {
      if (/<head[\s>]/i.test(html)) html = html.replace(/<head([^>]*)>/i, "<head$1>" + css);
      else html = css + html;
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, script + "</body>");
      else html += script;
    } else {
      html = "<!doctype html><html><head><meta charset=\"utf-8\">" + css + "</head><body>" + html + script + "</body></html>";
    }
    return html;
  }

  // ---------- 预览 ----------
  function schedulePreview(reselect = false) {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(() => renderPreview(reselect), 140);
  }
  function renderPreview(reselect = false) {
    try {
      const source = getSource();
      const annotated = annotateHtml(source);
      state.sourceMap = annotated.map;
      let html = annotated.html;
      // 包里保存的 assets/ 图片在预览中换成 data URL；源码里仍保留原路径。
      for (const asset of state.assets.values()) {
        if (!asset.path || !asset.base64) continue;
        html = html.split(asset.path).join(assetDataUrl(asset));
      }
      const isDoc = /<html[\s>]|<!doctype/i.test(html);
      const doc = injectPreview(html, isDoc);
      state.pendingReselect = reselect ? state.selectedSelector : "";
      const frame = $("previewFrame");
      frame.onload = () => {
        postToPreview("inspect", { value: state.inspectMode });
        if (state.pendingReselect) {
          postToPreview("reselect", { selector: state.pendingReselect });
        }
      };
      frame.srcdoc = doc;
    } catch (e) {
      console.error(e);
    }
  }
  function postToPreview(type, data) {
    try {
      const frame = $("previewFrame");
      if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ source: PREVIEW_SOURCE, type }, data || {}), "*");
    } catch { }
  }

  window.addEventListener("message", (event) => {
    const frame = $("previewFrame");
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.source !== PREVIEW_SOURCE) return;
    if (data.type === "ready") {
      postToPreview("inspect", { value: state.inspectMode });
      if (state.pendingReselect) postToPreview("reselect", { selector: state.pendingReselect });
    } else if (data.type === "select") {
      applySelection(data, !!data.reselect);
    }
  });

  // ---------- 检查器面板 ----------
  function setInspectorEnabled(enabled) {
    document.querySelectorAll("[data-style]").forEach((el) => { el.disabled = !enabled; });
    $("jumpSourceBtn").disabled = !enabled;
    $("clearStyleBtn").disabled = !enabled;
    $("customStyleName").disabled = !enabled;
    $("customStyleValue").disabled = !enabled;
    $("applyCustomStyleBtn").disabled = !enabled;
  }
  function clearSelection() {
    state.selectedSrcId = null;
    state.selectedSelector = "";
    state.selectedLine = 0;
    $("inspectorLine").textContent = "No selection";
    $("selInfo").textContent = "Click an element in the preview. Turn on Inspect to intercept clicks.";
    $("sourcePos").textContent = "Ln 1";
    setInspectorEnabled(false);
  }
  function infoHtml(data) {
    return '<b>' + escapeHtml(data.tag || "") + "</b> · " +
      escapeHtml(data.selector || "") +
      (data.text ? '<br><span style="color:#6f8193">' + escapeHtml(data.text) + "</span>" : "");
  }
  function applySelection(data, isReselect) {
    const entry = state.sourceMap[data.srcId];
    if (!entry) return;
    state.selectedSrcId = data.srcId;
    state.selectedSelector = data.selector || "";
    state.selectedLine = entry.line;
    $("inspectorLine").textContent = "Ln " + entry.line;
    $("selInfo").innerHTML = infoHtml(data);
    $("sourcePos").textContent = "Ln " + entry.line;
    syncInspector(data.computed || {});
    setInspectorEnabled(true);
    highlightLine(entry.line, !isReselect);
  }
  function toHexColor(value) {
    if (!value) return "#ffffff";
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return "#" + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    }
    const m = String(value).match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) {
      const h = (n) => Number(n).toString(16).padStart(2, "0");
      return "#" + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return "#ffffff";
  }
  function syncInspector(computed) {
    state.syncingControls = true;
    try {
      document.querySelectorAll("[data-style]").forEach((el) => {
        const prop = el.dataset.style;
        let value = computed[prop];
        if (value == null || value === "") value = el.type === "color" ? "#ffffff" : "";
        if (el.type === "range") {
          const n = parseFloat(value);
          el.value = Number.isFinite(n) ? String(Math.max(Number(el.min || 0), Math.min(Number(el.max || 100), n))) : "0";
        } else if (el.type === "color") {
          el.value = toHexColor(value);
        } else if (el.tagName === "SELECT") {
          const has = Array.from(el.options).some((o) => o.value === value || o.text === value);
          if (!has) {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = value;
            el.appendChild(opt);
          }
          el.value = value;
        } else {
          el.value = value;
        }
      });
    } finally { state.syncingControls = false; }
  }
  function cssProp(prop) {
    return String(prop).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }
  function parseStyleText(text) {
    const out = {};
    for (const part of String(text || "").split(";")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }
  function styleText(decls) {
    return Object.keys(decls).map((k) => k + ": " + decls[k]).join("; ");
  }
  function setTagStyle(raw, declarations) {
    const text = styleText(declarations);
    if (!text) {
      return raw.replace(/\sstyle\s*=\s*(["'])[\s\S]*?\1/i, "");
    }
    const attrValue = escapeAttr(text);
    const existing = raw.match(/\sstyle\s*=\s*(["'])[\s\S]*?\1/i);
    if (existing) return raw.replace(existing[0], ' style="' + attrValue + '"');
    if (/\/\s*>$/.test(raw)) return raw.replace(/\/\s*>$/, ' style="' + attrValue + '"/>');
    return raw.replace(/>$/, ' style="' + attrValue + '">');
  }
  function applyStyleObject(changes) {
    if (!state.selectedSrcId) return;
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry) return;
    const source = getSource();
    let tag = source.slice(entry.start, entry.end);
    const styleMatch = tag.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    const decls = parseStyleText(styleMatch ? styleMatch[2] : "");
    for (const [prop, value] of Object.entries(changes)) {
      const key = cssProp(prop);
      if (value === "" || value == null) delete decls[key];
      else decls[key] = String(value);
    }
    tag = setTagStyle(tag, decls);
    const next = source.slice(0, entry.start) + tag + source.slice(entry.end);
    setSourceValue(next, false);
    const note = state.notes.get(state.currentId);
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    markDirty();
    schedulePreview(true);
    scheduleSave();
  }
  function clearInlineStyle() {
    if (!state.selectedSrcId) return;
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry) return;
    const source = getSource();
    const tag = source.slice(entry.start, entry.end);
    const stripped = tag.replace(/\sstyle\s*=\s*(["'])[\s\S]*?\1/i, "");
    const next = source.slice(0, entry.start) + stripped + source.slice(entry.end);
    setSourceValue(next, false);
    const note = state.notes.get(state.currentId);
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    markDirty();
    schedulePreview(true);
    scheduleSave();
  }

  // ---------- 源码位置高亮 ----------
  function updateLineNumbers() {
    // CodeMirror 自带行号；保留空函数兼容旧调用点。
  }
  function highlightLine(line, focus) {
    const cm = state.mirror;
    if (!cm) return;
    try {
      if (state.highlightedLine) {
        cm.removeLineClass(state.highlightedLine - 1, "background", "cm-active-source-line");
      }
      state.highlightedLine = line;
      cm.addLineClass(line - 1, "background", "cm-active-source-line");
      cm.scrollIntoView({ line: line - 1, ch: 0 }, 100);
      if (focus) {
        cm.focus();
        cm.setCursor({ line: line - 1, ch: 0 });
      }
    } catch { }
    $("sourcePos").textContent = "Ln " + line;
  }

  // ---------- 源码编辑 / 热重载 ----------
  function markDirty() {
    state.dirty = true;
    $("saveState").textContent = "未保存";
    $("saveState").className = "save-state saving";
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow().catch(showError), 1000);
  }
  function currentNote() { return state.notes.get(state.currentId); }
  function syncCurrent() {
    const note = currentNote();
    if (!note) return;
    note.html = getSource();
    note.meta.title = ($("noteTitle").value || "").trim() || "未命名笔记";
    note.meta.updatedAt = nowIso();
    state.manifest.notes = Array.from(state.notes.values()).map((n) => n.meta);
    state.manifest.updatedAt = nowIso();
  }

  // ---------- 保存 ----------
  async function saveNow() {
    if (state.saveInFlight || !state.manifest) return;
    state.saveInFlight = true;
    clearTimeout(state.saveTimer);
    try {
      syncCurrent();
      $("saveState").textContent = "保存中…";
      $("saveState").className = "save-state saving";
      state.manifest.assets = Array.from(state.assets.values()).map((a) => ({
        id: a.id, path: a.path, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256,
      }));
      const zip = new JSZip();
      zip.file("mimetype", MIME, { compression: "STORE" });
      zip.file("manifest.json", JSON.stringify(state.manifest, null, 2));
      for (const [id, note] of state.notes.entries()) {
        zip.file("notes/" + id + ".html", note.html || "");
      }
      for (const asset of state.assets.values()) {
        zip.file(asset.path, base64ToBytes(asset.base64), { binary: true });
      }
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const res = await hostCall("host.workspace.save", { data: bytesToBase64(bytes) });
      if (!res || !res.ok) throw new Error((res && res.error) || "保存失败");
      state.dirty = false;
      $("saveState").textContent = "已保存 " + new Date().toLocaleTimeString().slice(0, 5);
      $("saveState").className = "save-state";
      refreshNoteSelect();
    } catch (e) {
      $("saveState").textContent = "保存失败";
      $("saveState").className = "save-state error";
      throw e;
    } finally {
      state.saveInFlight = false;
    }
  }

  // ---------- 笔记本 / 笔记管理 ----------
  function refreshNoteSelect() {
    const sel = $("noteSelect");
    const current = state.currentId;
    sel.innerHTML = "";
    for (const [id, note] of state.notes.entries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = note.meta.title || "未命名笔记";
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
  }
  function showCurrentNote() {
    const note = currentNote();
    if (!note) return;
    $("noteTitle").value = note.meta.title || "未命名笔记";
    setSourceValue(note.html || "", true);
    clearSelection();
    renderPreview(false);
    refreshNoteSelect();
  }
  function selectNote(id) {
    if (!state.notes.has(id)) return;
    if (state.dirty) syncCurrent();
    state.currentId = id;
    showCurrentNote();
  }
  function createNote() {
    syncCurrent();
    const n = defaultNote("新笔记");
    n.meta.order = state.notes.size;
    state.notes.set(n.meta.id, n);
    state.manifest.notes = Array.from(state.notes.values()).map((x) => x.meta);
    state.currentId = n.meta.id;
    showCurrentNote();
    markDirty();
    scheduleSave();
    $("noteTitle").focus();
    $("noteTitle").select();
  }
  function deleteNote() {
    if (state.notes.size <= 1) { alert("至少保留一篇笔记"); return; }
    const note = currentNote();
    if (!note) return;
    if (!confirm("删除笔记“" + (note.meta.title || "未命名笔记") + "”？")) return;
    state.notes.delete(state.currentId);
    state.manifest.notes = Array.from(state.notes.values()).map((n) => n.meta);
    const next = Array.from(state.notes.keys())[0];
    state.currentId = next;
    showCurrentNote();
    markDirty();
    scheduleSave();
  }

  // ---------- 加载 .lyrnb ----------
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
    state.assets = assets;
    const notes = new Map();
    for (const meta of (Array.isArray(manifest.notes) ? manifest.notes : [])) {
      let html = "";
      const htmlFile = zip.file("notes/" + meta.id + ".html");
      const jsonFile = zip.file("notes/" + meta.id + ".json");
      if (htmlFile) {
        html = await htmlFile.async("string");
      } else if (jsonFile) {
        try {
          const legacy = JSON.parse(await jsonFile.async("string"));
          html = legacyBlocksToHtml(legacy.blocks);
        } catch { html = defaultHtml(); }
      } else {
        html = defaultHtml();
      }
      meta.type = "html";
      notes.set(meta.id, { meta, html });
    }
    if (!notes.size) {
      const n = defaultNote("新笔记");
      notes.set(n.meta.id, n);
      manifest.notes = [n.meta];
    }
    state.manifest = manifest;
    state.notes = notes;
    state.manifest.notes = Array.from(notes.values()).map((n) => n.meta);
    state.currentId = Array.from(notes.keys())[0];
  }

  async function init() {
    if (!host) { showError(new Error("请从璃鸢镜扩展中打开笔记本")); return; }
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
    $("notebookTitle").value = state.manifest.title || "未命名笔记本";
    showCurrentNote();
    setInspectorEnabled(false);
    $("saveState").textContent = "已保存";
    $("saveState").className = "save-state";
    if (!res.data) await saveNow();
  }

  function showError(e) {
    $("errorText").textContent = String(e && e.message ? e.message : e);
    $("errorMask").hidden = false;
  }

  // ---------- 事件 ----------
  function bind() {
    renderStyleControls();
    initSourceEditor();
    $("notebookTitle").addEventListener("input", () => {
      if (!state.manifest) return;
      state.manifest.title = $("notebookTitle").value.trim() || "未命名笔记本";
      markDirty();
      scheduleSave();
    });
    $("noteTitle").addEventListener("input", () => {
      const note = currentNote();
      if (!note) return;
      note.meta.title = $("noteTitle").value.trim() || "未命名笔记";
      refreshNoteSelect();
      markDirty();
      scheduleSave();
    });
    $("noteSelect").addEventListener("change", (e) => selectNote(e.target.value));
    $("newNoteBtn").addEventListener("click", createNote);
    $("deleteNoteBtn").addEventListener("click", deleteNote);
    $("reloadBtn").addEventListener("click", () => renderPreview(false));
    $("inspectBtn").addEventListener("click", () => {
      state.inspectMode = !state.inspectMode;
      $("inspectBtn").classList.toggle("active", state.inspectMode);
      postToPreview("inspect", { value: state.inspectMode });
    });
    $("jumpSourceBtn").addEventListener("click", () => {
      if (state.selectedLine) highlightLine(state.selectedLine, true);
    });
    $("clearStyleBtn").addEventListener("click", clearInlineStyle);
    document.querySelectorAll("[data-style]").forEach((el) => {
      el.addEventListener("change", () => {
        if (state.syncingControls || !state.selectedSrcId) return;
        const prop = el.dataset.style;
        applyStyleObject({ [prop]: el.value });
      });
    });
    $("applyCustomStyleBtn").addEventListener("click", () => {
      if (!state.selectedSrcId) return;
      const name = $("customStyleName").value.trim();
      const value = $("customStyleValue").value.trim();
      if (!name) return;
      applyStyleObject({ [name]: value });
    });
    document.querySelectorAll("[data-flex]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.flex;
        const [dir, align] = mode.split("-");
        const obj = {
          display: "flex",
          flexDirection: dir,
          justifyContent: align === "between" ? "space-between" : align === "center" ? "center" : "flex-start",
          alignItems: "center",
          gap: "12px",
        };
        applyStyleObject(obj);
      });
    });
    window.addEventListener("beforeunload", () => { try { saveNow(); } catch { } });
  }

  bind();
  window.__lyraDebug = { state, applyStyleObject, applySelection, renderPreview };
  init().catch(showError);
})();

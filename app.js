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
    selectedData: null,
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
    domTree: null,
    collapsedDom: new Set(),
    pendingReplaceAssetId: null,
    activeTab: "style",
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

  // ---------- 图片资源 ----------
  async function sha256Hex(bytes) {
    try {
      if (crypto && crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch { }
    let h1 = 2166136261, h2 = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
      h1 ^= bytes[i]; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ bytes[i], 0x85ebca6b) + i) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4);
  }
  function assetExt(mime, name) {
    const map = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
    if (map[mime]) return map[mime];
    const m = String(name || "").match(/\.[a-z0-9]+$/i);
    return m ? m[0].toLowerCase() : ".bin";
  }
  async function addAsset(bytes, name, mime) {
    const sha = await sha256Hex(bytes);
    const id = "asset-" + sha.slice(0, 24);
    if (state.assets.has(id)) return state.assets.get(id);
    const ext = assetExt(mime, name);
    const asset = {
      id,
      path: "assets/" + sha + ext,
      name: name || ("image" + ext),
      mime: mime || "application/octet-stream",
      size: bytes.length,
      sha256: sha,
      base64: bytesToBase64(bytes),
    };
    state.assets.set(id, asset);
    return asset;
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
        { p: "textShadow", t: "text", ph: "none" },
        { p: "clipPath", t: "text", ph: "none" },
        { p: "objectFit", t: "select", o: ["fill", "contain", "cover", "none", "scale-down"] },
        { p: "objectPosition", t: "text", ph: "50% 50%" },
        { p: "mixBlendMode", t: "select", o: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "difference", "exclusion", "hue", "saturation", "color", "luminosity"] },
        { p: "pointerEvents", t: "select", o: ["auto", "none"] },
        { p: "userSelect", t: "select", o: ["auto", "none", "text", "all"] },
        { p: "isolation", t: "select", o: ["auto", "isolate"] },
        { p: "willChange", t: "text", ph: "auto" },
        { p: "appearance", t: "select", o: ["none", "auto"] },
        { p: "resize", t: "select", o: ["none", "both", "horizontal", "vertical"] },
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

  // ---------- 全量 CSS 属性补全 ----------
  let cachedCssProperties = null;
  function getCssProperties() {
    if (cachedCssProperties) return cachedCssProperties;
    const style = document.createElement("div").style;
    const set = new Set();
    for (const key in style) {
      if (!/^[a-zA-Z]/.test(key)) continue;
      const prop = cssProp(key);
      try {
        if (!window.CSS || CSS.supports(prop, "inherit")) set.add(prop);
      } catch { }
    }
    ["float", "clear", "content", "cursor", "filter", "backdrop-filter", "appearance"].forEach((p) => {
      try { if (!window.CSS || CSS.supports(p, "inherit")) set.add(p); } catch { }
    });
    cachedCssProperties = Array.from(set).sort();
    return cachedCssProperties;
  }

  const VALUE_SUGGESTIONS = {
    display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "none"],
    position: ["static", "relative", "absolute", "fixed", "sticky"],
    "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
    "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
    "justify-content": ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly", "start", "end"],
    "align-items": ["stretch", "flex-start", "center", "flex-end", "baseline", "start", "end"],
    "align-content": ["stretch", "flex-start", "center", "flex-end", "space-between", "space-around", "start", "end"],
    "text-align": ["left", "center", "right", "justify", "start", "end"],
    "font-weight": ["100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold"],
    "font-style": ["normal", "italic", "oblique"],
    "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
    "text-decoration": ["none", "underline", "overline", "line-through"],
    "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
    "word-break": ["normal", "break-all", "keep-all", "break-word"],
    "overflow-wrap": ["normal", "break-word", "anywhere"],
    "background-repeat": ["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"],
    "background-size": ["auto", "cover", "contain"],
    "border-style": ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"],
    "border-collapse": ["separate", "collapse"],
    "table-layout": ["auto", "fixed"],
    "vertical-align": ["baseline", "top", "middle", "bottom", "text-top", "text-bottom"],
    "list-style-type": ["disc", "circle", "square", "decimal", "lower-alpha", "upper-alpha", "none"],
    "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
    "mix-blend-mode": ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "difference", "exclusion", "hue", "saturation", "color", "luminosity"],
    "pointer-events": ["auto", "none"],
    "user-select": ["auto", "none", "text", "all"],
    "isolation": ["auto", "isolate"],
    "appearance": ["none", "auto"],
    "resize": ["none", "both", "horizontal", "vertical"],
    "cursor": ["auto", "default", "pointer", "text", "move", "grab", "not-allowed"],
  };
  function getValueSuggestions(prop) {
    const key = String(prop || "").toLowerCase();
    const out = [];
    const add = (v) => { if (v && !out.includes(v)) out.push(v); };
    (VALUE_SUGGESTIONS[key] || []).forEach(add);
    ["initial", "inherit", "unset", "revert", "revert-layer", "auto", "none", "normal", "0", "1px", "2px", "4px", "8px", "12px", "16px", "1rem", "1em", "50%", "100%"].forEach(add);
    if (/color|background|border|outline|fill|stroke/.test(key)) {
      ["#000000", "#ffffff", "transparent", "currentColor"].forEach(add);
    }
    if (/family/.test(key)) ["system-ui", "sans-serif", "serif", "monospace"].forEach(add);
    return out;
  }

  let autocompletePopup = null;
  let autocompleteHideTimer = 0;
  function hideAutocomplete() {
    if (autocompletePopup) autocompletePopup.hidden = true;
  }
  function autocompleteItemsFor(input, getItems) {
    const items = getItems(input.value || "");
    return items.slice(0, 80);
  }
  function attachAutocomplete(input, getItems, onPick, options) {
    let active = -1;
    let items = [];
    const popup = $("autocompletePopup");
    const hide = () => { popup.hidden = true; active = -1; };
    const choose = (i) => {
      if (i < 0 || i >= items.length) return;
      const value = items[i];
      onPick(value);
      hide();
    };
    const show = (reset) => {
      items = autocompleteItemsFor(input, getItems);
      if (!items.length) { hide(); return; }
      if (reset !== false) active = 0;
      popup.innerHTML = "";
      items.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "autocomplete-item" + (i === active ? " active" : "");
        el.textContent = item;
        el.addEventListener("mousedown", (e) => e.preventDefault());
        el.addEventListener("click", () => choose(i));
        popup.appendChild(el);
      });
      const rect = input.getBoundingClientRect();
      popup.style.left = Math.round(rect.left) + "px";
      popup.style.top = Math.round(rect.bottom + 2) + "px";
      popup.style.width = Math.max(180, Math.round(rect.width)) + "px";
      popup.hidden = false;
      const current = popup.children[active];
      if (current) current.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => show(true));
    input.addEventListener("focus", () => show(true));
    const enterAcceptsFirst = !options || options.enterAcceptsFirst !== false;
    input.addEventListener("keydown", (e) => {
      if (popup.hidden) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          show(true);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (!enterAcceptsFirst) { hide(); input.blur(); return; }
          show(true);
          if (items.length) { active = 0; choose(0); }
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        active = active < 0 ? 0 : Math.min(items.length - 1, active + 1);
        show(false);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = active <= 0 ? items.length - 1 : active - 1;
        show(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (active >= 0) choose(active);
        else if (enterAcceptsFirst) { active = 0; choose(0); }
        else { hide(); input.blur(); }
      } else if (e.key === "Escape") {
        hide();
      }
    });
    input.addEventListener("blur", () => { clearTimeout(autocompleteHideTimer); autocompleteHideTimer = setTimeout(hide, 120); });
    return { show, hide };
  }
  function createInlineStyleRow(prop, value) {
    const row = document.createElement("div");
    row.className = "inline-style-row";
    row.dataset.prop = prop;
    const label = document.createElement("span");
    label.className = "prop";
    label.textContent = prop;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.spellcheck = false;
    input.dataset.prop = prop;
    attachAutocomplete(input, (typed) => {
      const q = String(typed || "").trim().toLowerCase();
      const all = getValueSuggestions(prop);
      return q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
    }, (picked) => {
      input.value = picked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { enterAcceptsFirst: false });
    input.addEventListener("change", () => {
      applyStyleObject({ [prop]: input.value.trim() });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.title = "Remove " + prop;
    remove.textContent = "×";
    remove.addEventListener("click", () => applyStyleObject({ [prop]: "" }));
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(remove);
    return row;
  }
  function renderInlineStyles(inlineStyle) {
    const host = $("inlineStyleRows");
    if (!host) return;
    host.innerHTML = "";
    const decls = parseStyleText(inlineStyle || "");
    const props = Object.keys(decls).filter((p) => p && p !== "style");
    if (!props.length) {
      const empty = document.createElement("div");
      empty.className = "inline-style-empty";
      empty.textContent = "No inline styles. Search a property above to add one.";
      host.appendChild(empty);
      return;
    }
    for (const prop of props) host.appendChild(createInlineStyleRow(prop, decls[prop]));
  }
  function addInlineProperty(prop) {
    if (!state.selectedSrcId) { alert("Select an element first."); return; }
    const host = $("inlineStyleRows");
    const current = Array.from(host.querySelectorAll(".inline-style-row")).find((row) => row.dataset.prop === prop);
    if (current) {
      const input = current.querySelector("input");
      input.focus();
      input.select();
      return;
    }
    const empty = host.querySelector(".inline-style-empty");
    if (empty) empty.remove();
    const row = createInlineStyleRow(prop, "");
    host.appendChild(row);
    const input = row.querySelector("input");
    input.focus();
    input.select();
  }

  // ---------- CodeMirror 源码编辑器 ----------
  function getSource() {
    return state.mirror ? state.mirror.getValue() : "";
  }
  function setSourceValue(text, resetHistory) {
    if (!state.mirror) return;
    const cm = state.mirror;
    const cursor = cm.getCursor();
    const scroll = cm.getScrollInfo();
    state.suppressMirror = true;
    try {
      cm.setValue(text || "");
      if (resetHistory) {
        cm.clearHistory();
        cm.setCursor({ line: 0, ch: 0 });
      } else {
        cm.setCursor(cursor);
        cm.scrollTo(scroll.left, scroll.top);
      }
    } finally {
      state.suppressMirror = false;
    }
  }
  function replaceSourceRange(start, end, text) {
    const cm = state.mirror;
    if (!cm) return;
    state.suppressMirror = true;
    try {
      cm.replaceRange(text, cm.posFromIndex(start), cm.posFromIndex(end));
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
      lineWrapping: true,
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
        "Shift-Alt-F": () => formatSource(),
      },
    });
    state.mirror = cm;
    cm.on("change", () => {
      if (state.suppressMirror) return;
      const note = currentNote();
      if (note) note.html = cm.getValue();
      state.sourceMap = annotateHtml(cm.getValue()).map;
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
      selectFromSourceCursor();
    });
  }

  function insertTextAtCursor(text) {
    const cm = state.mirror;
    if (!cm) return;
    cm.replaceRange(text, cm.getCursor());
    cm.focus();
  }
  async function handleImageFile(file) {
    if (!file || !/^image\//.test(file.type || "")) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await addAsset(bytes, file.name || "image", file.type || "image/png");
    const alt = escapeAttr(file.name || asset.name || "image");
    insertTextAtCursor('\n<img src="' + asset.path + '" alt="' + alt + '">\n');
    renderAssets();
    $("saveState").textContent = "未保存";
    $("saveState").className = "save-state saving";
  }
  function splitCssDeclarations(text) {
    const out = [];
    let current = "", quote = "", depth = 0;
    for (let i = 0; i < String(text).length; i++) {
      const c = text[i];
      if (quote) {
        current += c;
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") { quote = c; current += c; continue; }
      if (c === "(") { depth++; current += c; continue; }
      if (c === ")") { depth = Math.max(0, depth - 1); current += c; continue; }
      if (c === ";" && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += c;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  }
  function formatStyleAttributes(html) {
    return html.replace(/\bstyle="([^"]*)"/g, (match, css, offset) => {
      const decls = splitCssDeclarations(css);
      if (decls.length < 2) return match;
      const lineStart = html.lastIndexOf("\n", offset) + 1;
      const linePrefix = html.slice(lineStart, offset);
      const indent = (linePrefix.match(/^[ \t]*/) || [""])[0];
      return 'style="' + decls.join(";\n" + indent + "  ") + ';"';
    });
  }
  function formatStyleTags(html) {
    if (typeof window.css_beautify !== "function") return html;
    return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
      try {
        const formatted = window.css_beautify(css, { indent_size: 2, end_with_newline: false });
        return open + "\n" + formatted + "\n" + close;
      } catch { return match; }
    });
  }
  function fixOpeningTagIndent(html) {
    const lines = html.split("\n");
    let state = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!state) {
        const trimmed = line.trim();
        if (/<[a-zA-Z][\w:-]*$/.test(trimmed)) {
          const base = (line.match(/^[ \t]*/) || [""])[0];
          state = { base: base, style: false };
        }
        continue;
      }
      const t = line.trim();
      if (t === ">" || t === "/>" || t.startsWith(">")) {
        lines[i] = state.base + t;
        state = null;
        continue;
      }
      if (state.style) {
        lines[i] = state.base + "    " + t;
        if (t.endsWith(">")) state = null;
        continue;
      }
      const attr = t.match(/^([^\s=]+)\s*=/);
      if (attr) {
        lines[i] = state.base + "  " + t;
        if (attr[1] === "style" && !t.endsWith('"')) state.style = true;
        continue;
      }
      lines[i] = state.base + "  " + t;
    }
    return lines.join("\n");
  }
  function formatSource() {
    if (typeof window.html_beautify !== "function") return;
    const source = getSource();
    if (!source.trim()) return;
    let formatted = window.html_beautify(source, {
      indent_size: 2,
      preserve_newlines: true,
      max_preserve_newlines: 2,
      wrap_line_length: 0,
      wrap_attributes: "force-expand-multiline",
      wrap_attributes_indent_size: 2,
      wrap_attributes_min_attrs: 2,
      end_with_newline: true,
    });
    formatted = formatStyleAttributes(formatted);
    formatted = formatStyleTags(formatted);
    formatted = fixOpeningTagIndent(formatted);
    setSourceValue(formatted, false);
    const note = currentNote();
    if (note) note.html = formatted;
    state.sourceMap = annotateHtml(formatted).map;
    clearSelection();
    markDirty();
    schedulePreview(false);
    scheduleSave();
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
    const stack = [];
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
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
          const raw = source.slice(i, end + 1);
          const close = raw.match(/^<\s*\/\s*([a-zA-Z][\w:-]*)/);
          if (close) {
            const closeTag = close[1].toLowerCase();
            for (let k = stack.length - 1; k >= 0; k--) {
              if (stack[k].tag === closeTag) {
                map[stack[k].id].fullEnd = end + 1;
                stack.splice(k, 1);
                break;
              }
            }
          }
          out += raw; line += countLines(raw); i = end + 1; continue;
        }
        const end = findTagEnd(source, i);
        if (end < 0) { out += source.slice(i); break; }
        const raw = source.slice(i, end + 1);
        const m = raw.match(/^<\s*([a-zA-Z][\w:-]*)/);
        if (!m) { out += raw; line += countLines(raw); i = end + 1; continue; }
        const tag = m[1].toLowerCase();
        const selfClosing = /\/\s*>$/.test(raw);
        id++;
        const injected = selfClosing
          ? raw.replace(/\/\s*>$/, ' data-lyra-src="' + id + '"/>')
          : raw.replace(/>$/, ' data-lyra-src="' + id + '">');
        out += injected;
        map[id] = { start: i, end: end + 1, line: line, tag: tag, fullEnd: null };
        if (selfClosing || voidTags.has(tag)) map[id].fullEnd = end + 1;
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
              map[id].fullEnd = closeEnd;
            }
          } catch { }
        } else if (!selfClosing && !voidTags.has(tag)) {
          stack.push({ tag: tag, id: id });
        }
        continue;
      }
      const next = source.indexOf("<", i);
      const end = next < 0 ? source.length : next;
      const chunk = source.slice(i, end);
      out += chunk; line += countLines(chunk); i = end;
    }
    // 可选闭合标签或未闭合结构：用后续闭合标签兜底补全。
    for (const entry of stack) {
      if (map[entry.id].fullEnd == null) {
        const re = new RegExp("</" + entry.tag + "\\s*>", "i");
        const cm = re.exec(source.slice(map[entry.id].end));
        if (cm) map[entry.id].fullEnd = map[entry.id].end + cm.index + cm[0].length;
      }
    }
    return { html: out, map };
  }

  // ---------- 注入预览的检查器 ----------
  function inspectorScript() {
    return `
(function(){
  var SOURCE = ${JSON.stringify(PREVIEW_SOURCE)};
    var inspect = false, hovered = null, selectedEl = null, highlightBox = null;
  function cleanClass(el) {
    return (el.getAttribute("class") || "").split(/\s+/).filter(function(c){ return c && c !== "lyra-inspect-hover"; }).join(" ");
  }
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
      var cleanCls = cleanClass(el);
      if (cleanCls) part += "." + cleanCls.split(/\s+/).map(cssEscape).join(".");
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
  var COMPUTED = ["display","position","top","right","bottom","left","zIndex","float","clear","boxSizing","overflow","overflowX","overflowY","visibility","flexDirection","flexWrap","justifyContent","alignItems","alignContent","alignSelf","gap","rowGap","columnGap","flexGrow","flexShrink","flexBasis","order","gridTemplateColumns","gridTemplateRows","gridAutoFlow","gridColumn","gridRow","width","minWidth","maxWidth","height","minHeight","maxHeight","aspectRatio","paddingTop","paddingRight","paddingBottom","paddingLeft","marginTop","marginRight","marginBottom","marginLeft","fontFamily","fontSize","fontWeight","fontStyle","lineHeight","letterSpacing","wordSpacing","textAlign","textIndent","textTransform","textDecoration","whiteSpace","wordBreak","overflowWrap","color","backgroundColor","backgroundImage","backgroundSize","backgroundPosition","backgroundRepeat","borderWidth","borderStyle","borderColor","borderRadius","outline","boxShadow","opacity","transform","transformOrigin","transition","filter","backdropFilter","textShadow","clipPath","objectFit","objectPosition","mixBlendMode","pointerEvents","userSelect","isolation","willChange","appearance","resize","cursor","listStyleType","tableLayout","borderCollapse","verticalAlign"];
  function pick(el) {
    var cs = getComputedStyle(el);
    var computed = {};
    COMPUTED.forEach(function(p){ computed[p] = cs[p]; });
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
    return {
      srcId: el.getAttribute("data-lyra-src") || "",
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      id: el.id || "",
      className: cleanClass(el),
      inlineStyle: el.getAttribute("style") || "",
      computed: computed,
      text: text
    };
  }
  function nearestAnnotatedParent(el) {
    var p = el && el.parentElement;
    while (p) {
      if (p.hasAttribute && p.hasAttribute("data-lyra-src")) return p;
      p = p.parentElement;
    }
    return null;
  }
  function ensureHighlightBox() {
    if (highlightBox) return highlightBox;
    highlightBox = document.createElement("div");
    highlightBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #66ccff;box-shadow:0 0 0 1px rgba(102,204,255,.35);border-radius:2px;display:none;box-sizing:border-box;";
    document.body.appendChild(highlightBox);
    return highlightBox;
  }
  function updateHighlightBox() {
    if (!hovered) return;
    var box = ensureHighlightBox();
    var r = hovered.getBoundingClientRect();
    box.style.left = Math.round(r.left) + "px";
    box.style.top = Math.round(r.top) + "px";
    box.style.width = Math.max(2, Math.round(r.width)) + "px";
    box.style.height = Math.max(2, Math.round(r.height)) + "px";
    box.style.display = "block";
  }
  function clearHover() {
    hovered = null;
    if (highlightBox) highlightBox.style.display = "none";
  }
  function setHover(el) {
    if (hovered === el) { updateHighlightBox(); return; }
    hovered = el;
    if (!el) { clearHover(); return; }
    updateHighlightBox();
  }
  window.addEventListener("scroll", updateHighlightBox, true);
  window.addEventListener("resize", updateHighlightBox);
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
    if (e.altKey) {
      var parent = nearestAnnotatedParent(el);
      if (parent) el = parent;
    }
    clearHover();
    var payload = pick(el);
    selectedEl = el;
    setHover(el);
    send("select", payload);
  }, true);
  function buildTree(el, depth) {
    if (!el || depth > 12) return null;
    var tagName = el.tagName ? el.tagName.toLowerCase() : "";
    if (tagName === "script" || tagName === "style") return null;
    var sid = el.getAttribute ? el.getAttribute("data-lyra-src") : "";
    if (!sid && el !== document.body) return null;
    var children = [];
    for (var i = 0; i < el.children.length; i++) {
      var child = buildTree(el.children[i], depth + 1);
      if (child) children.push(child);
    }
    var ownText = "";
    for (var j = 0; j < el.childNodes.length; j++) {
      if (el.childNodes[j].nodeType === 3) ownText += el.childNodes[j].nodeValue;
    }
    return {
      srcId: sid,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: cleanClass(el),
      text: ownText.replace(/\\s+/g, " ").trim().slice(0, 60),
      children: children
    };
  }
  function sendTree() {
    send("tree", { tree: buildTree(document.body, 0) });
  }
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === "inspect") { inspect = !!d.value; if (!inspect) clearHover(); }
    else if (d.type === "clearHighlight") { clearHover(); }
    else if (d.type === "getTree") { sendTree(); }
    else if (d.type === "selectParent") {
      var parent = selectedEl ? nearestAnnotatedParent(selectedEl) : null;
      if (parent) { var payload = pick(parent); selectedEl = parent; setHover(parent); send("select", payload); }
    }
    else if (d.type === "selectById") {
      try {
        var target = document.querySelector("[data-lyra-src=\\"" + String(d.srcId).replace(/"/g, "") + "\\"]");
        if (target) { clearHover(); var payload = pick(target); selectedEl = target; setHover(target); send("select", payload); }
      } catch(err) {}
    }
    else if (d.type === "reselect") {
      try {
        var el = d.selector ? document.querySelector(d.selector) : null;
        if (el) { clearHover(); var payload = pick(el); payload.reselect = true; selectedEl = el; setHover(el); send("select", payload); }
      } catch(err) {}
    }
  });
  setTimeout(sendTree, 80);
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
img { max-width: 100%; min-width: 0; height: auto; }
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
      if (state.activeTab === "css") renderCssRules();
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
      postToPreview("getTree", {});
      if (state.pendingReselect) postToPreview("reselect", { selector: state.pendingReselect });
    } else if (data.type === "tree") {
      state.domTree = data.tree || null;
      if (state.activeTab === "dom") renderDomTree();
    } else if (data.type === "select") {
      applySelection(data, !!data.reselect);
      if (state.activeTab === "dom") markDomSelection();
    }
  });

  // ---------- 检查器面板 ----------
  function setInspectorEnabled(enabled) {
    document.querySelectorAll("[data-style]").forEach((el) => { el.disabled = !enabled; });
    $("jumpSourceBtn").disabled = !enabled;
    $("selectParentBtn").disabled = !enabled;
    $("clearStyleBtn").disabled = !enabled;
    $("attrId").disabled = !enabled;
    $("attrClass").disabled = !enabled;
    $("applyAttrsBtn").disabled = !enabled;
  }
  function clearSelection() {
    state.selectedSrcId = null;
    state.selectedSelector = "";
    state.selectedLine = 0;
    state.selectedData = null;
    $("inspectorLine").textContent = "No selection";
    $("selInfo").textContent = "Click an element in the preview. Turn on Inspect to intercept clicks. Alt+Click selects parent.";
    $("sourcePos").textContent = "Ln 1";
    $("attrId").value = "";
    $("attrClass").value = "";
    renderInlineStyles("");
    setInspectorEnabled(false);
  }
  // ---------- DOM tree / assets / tabs ----------
  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll(".dev-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-content").forEach((el) => { el.hidden = el.id !== "tab" + name.charAt(0).toUpperCase() + name.slice(1); });
    if (name === "dom") {
      renderDomTree();
      if (!state.domTree) postToPreview("getTree", {});
    } else if (name === "assets") {
      renderAssets();
    } else if (name === "css") {
      renderCssRules();
    }
  }
  function markDomSelection() {
    document.querySelectorAll(".dom-row").forEach((el) => el.classList.toggle("active", el.dataset.srcId === state.selectedSrcId));
  }
  function renderDomTree() {
    const host = $("domTree");
    if (!host) return;
    host.innerHTML = "";
    if (!state.domTree) {
      host.textContent = "Loading DOM…";
      return;
    }
    const q = ($("domSearch").value || "").trim().toLowerCase();
    const matches = (node) => {
      if (!q) return true;
      const own = [node.tag, node.id, node.className, node.text].join(" ").toLowerCase();
      if (own.includes(q)) return true;
      return (node.children || []).some(matches);
    };
    const walk = (node, depth) => {
      if (!matches(node)) return;
      const row = document.createElement("div");
      row.className = "dom-row";
      row.dataset.srcId = node.srcId || "";
      row.style.paddingLeft = (4 + depth * 12) + "px";
      const children = node.children || [];
      const key = node.srcId || "__root";
      const collapsed = !q && state.collapsedDom.has(key);
      const toggle = document.createElement("span");
      toggle.className = "dom-toggle" + (children.length ? "" : " leaf");
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!children.length) return;
        if (state.collapsedDom.has(key)) state.collapsedDom.delete(key);
        else state.collapsedDom.add(key);
        renderDomTree();
      });
      row.appendChild(toggle);
      const tag = document.createElement("span");
      tag.className = "dom-tag";
      tag.textContent = "<" + node.tag + ">";
      row.appendChild(tag);
      if (node.id) {
        const id = document.createElement("span");
        id.className = "dom-id";
        id.textContent = "#" + node.id;
        row.appendChild(id);
      }
      if (node.className) {
        const cls = document.createElement("span");
        cls.className = "dom-class";
        cls.textContent = "." + node.className.split(/\s+/).join(".");
        row.appendChild(cls);
      }
      if (!children.length && node.text) {
        const txt = document.createElement("span");
        txt.className = "dom-text";
        txt.textContent = node.text;
        row.appendChild(txt);
      }
      row.addEventListener("click", () => {
        if (node.srcId) postToPreview("selectById", { srcId: node.srcId });
      });
      host.appendChild(row);
      if (!collapsed) for (const child of children) walk(child, depth + 1);
    };
    walk(state.domTree, 0);
    markDomSelection();
  }  function assetUsage(path) {
    let count = 0;
    for (const note of state.notes.values()) {
      const text = note.html || "";
      let idx = 0;
      while ((idx = text.indexOf(path, idx)) >= 0) { count++; idx += path.length; }
    }
    return count;
  }
  function collectAssetReferences() {
    const refs = new Set();
    for (const note of state.notes.values()) {
      const text = note.html || "";
      const matches = text.match(/assets\/[A-Za-z0-9._-]+/g) || [];
      for (const m of matches) refs.add(m);
    }
    return refs;
  }
  function updateAssetRefs() {
    const host = $("assetRefs");
    if (!host) return;
    const refs = collectAssetReferences();
    const existing = new Set(Array.from(state.assets.values()).map((a) => a.path));
    const missing = Array.from(refs).filter((r) => !existing.has(r));
    const unused = Array.from(state.assets.values()).filter((a) => !refs.has(a.path));
    if (!missing.length && !unused.length) {
      host.innerHTML = '<span style="color:#77d69c">All asset references OK.</span>';
      return;
    }
    const parts = [];
    if (missing.length) parts.push('<span class="bad">Missing: ' + missing.map(escapeHtml).join(", ") + "</span>");
    if (unused.length) parts.push('<span class="warn">Unused: ' + unused.map((a) => escapeHtml(a.name || a.path)).join(", ") + "</span>");
    host.innerHTML = parts.join("<br>");
  }
  function checkAssetReferences() {
    syncCurrent();
    updateAssetRefs();
  }
  async function replaceAssetFile(file) {
    const id = state.pendingReplaceAssetId;
    state.pendingReplaceAssetId = null;
    if (!id || !file || !/^image\//.test(file.type || "")) return;
    const old = state.assets.get(id);
    if (!old) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fresh = await addAsset(bytes, file.name || old.name, file.type || old.mime);
    if (fresh.id === old.id) return;
    syncCurrent();
    for (const note of state.notes.values()) {
      note.html = (note.html || "").split(old.path).join(fresh.path);
    }
    const note = currentNote();
    if (note) {
      setSourceValue(note.html || "", false);
      state.sourceMap = annotateHtml(note.html || "").map;
    }
    if (assetUsage(old.path) === 0) state.assets.delete(old.id);
    markDirty();
    renderAssets();
    schedulePreview(false);
    scheduleSave();
  }
  function applySourceEdit(next) {
    setSourceValue(next, false);
    const note = currentNote();
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    clearSelection();
    markDirty();
    schedulePreview(false);
    scheduleSave();
    renderDomTree();
  }
  function renameSelectedTag() {
    if (!state.selectedSrcId) { alert("Select an element first."); return; }
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry) return;
    const newTag = ($("domNewTag").value || "").trim().toLowerCase();
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(newTag)) { alert("Invalid tag name."); return; }
    if (["html", "head", "body"].includes(entry.tag)) { alert("Cannot rename structural tag <" + entry.tag + ">."); return; }
    if (entry.fullEnd == null) { alert("Cannot determine source range for this element."); return; }
    const source = getSource();
    if (entry.fullEnd <= entry.end) {
      const open = source.slice(entry.start, entry.end).replace(/^<\s*[a-zA-Z][\w:-]*/, "<" + newTag);
      applySourceEdit(source.slice(0, entry.start) + open + source.slice(entry.end));
      return;
    }
    const element = source.slice(entry.start, entry.fullEnd);
    const close = element.match(/<\s*\/\s*([a-zA-Z][\w:-]*)\s*>\s*$/);
    if (!close || close[1].toLowerCase() !== entry.tag) { alert("Cannot find matching closing tag."); return; }
    if (["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(newTag)) {
      alert("Cannot rename a container to a void tag."); return;
    }
    const closeIndex = entry.start + close.index;
    const openNew = source.slice(entry.start, closeIndex).replace(/^<\s*[a-zA-Z][\w:-]*/, "<" + newTag);
    applySourceEdit(openNew + "</" + newTag + ">" + source.slice(entry.fullEnd));
  }
  function deleteSelectedElement() {
    if (!state.selectedSrcId) { alert("Select an element first."); return; }
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry) return;
    if (entry.fullEnd == null) { alert("Cannot determine source range for this element."); return; }
    if (["html", "head", "body"].includes(entry.tag)) { alert("Cannot delete structural tag <" + entry.tag + ">."); return; }
    if (!confirm("Delete <" + entry.tag + "> from the source?")) return;
    const source = getSource();
    applySourceEdit(source.slice(0, entry.start) + source.slice(entry.fullEnd));
  }
  function findDomNodeInfo(id) {
    if (!state.domTree) return null;
    let found = null;
    const walk = (node, parent, index) => {
      if (found) return;
      if (node.srcId === id) { found = { node: node, parent: parent, index: index }; return; }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) walk(children[i], node, i);
    };
    walk(state.domTree, null, 0);
    return found;
  }
  function selectedElementSource() {
    if (!state.selectedSrcId) { alert("Select an element first."); return null; }
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry || entry.fullEnd == null) { alert("Cannot determine source range for this element."); return null; }
    if (["html", "head", "body"].includes(entry.tag)) { alert("Cannot modify structural tag <" + entry.tag + ">."); return null; }
    return { entry: entry, source: getSource() };
  }
  function duplicateSelectedElement() {
    const data = selectedElementSource();
    if (!data) return;
    const text = data.source.slice(data.entry.start, data.entry.fullEnd);
    const lineStart = data.source.lastIndexOf("\n", data.entry.start) + 1;
    const prefix = data.source.slice(lineStart, data.entry.start);
    const indent = /^[ \t]*$/.test(prefix) ? prefix : "";
    const separator = indent ? "\n" + indent : "";
    applySourceEdit(data.source.slice(0, data.entry.fullEnd) + separator + text + data.source.slice(data.entry.fullEnd));
  }
  function moveSelectedElement(delta) {
    const data = selectedElementSource();
    if (!data) return;
    const info = findDomNodeInfo(state.selectedSrcId);
    if (!info || !info.parent) { alert("Cannot find the parent element; refresh the DOM tree."); return; }
    const siblings = info.parent.children || [];
    const target = siblings[info.index + delta];
    if (!target) return;
    const targetEntry = state.sourceMap[target.srcId];
    if (!targetEntry || targetEntry.fullEnd == null) return;
    const source = data.source;
    const cur = data.entry;
    const other = targetEntry;
    let next;
    if (delta < 0) {
      next = source.slice(0, other.start) +
        source.slice(cur.start, cur.fullEnd) +
        source.slice(other.fullEnd, cur.start) +
        source.slice(other.start, other.fullEnd) +
        source.slice(cur.fullEnd);
    } else {
      next = source.slice(0, cur.start) +
        source.slice(other.start, other.fullEnd) +
        source.slice(cur.fullEnd, other.start) +
        source.slice(cur.start, cur.fullEnd) +
        source.slice(other.fullEnd);
    }
    applySourceEdit(next);
  }
  function copySelectedHtml() {
    const data = selectedElementSource();
    if (!data) return;
    const text = data.source.slice(data.entry.start, data.entry.fullEnd);
    const done = () => {
      $("saveState").textContent = "Copied HTML";
      setTimeout(() => { if (!$("saveState").textContent.startsWith("保存")) $("saveState").textContent = "Copied HTML"; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { }
      ta.remove();
      done();
    }
  }

  function renderAssets() {
    const host = $("assetList");
    if (!host) return;
    host.innerHTML = "";
    updateAssetRefs();
    const assets = Array.from(state.assets.values());
    if (!assets.length) {
      const empty = document.createElement("div");
      empty.className = "tab-hint";
      empty.textContent = "No assets in this notebook yet. Use the Image button to add one.";
      host.appendChild(empty);
      return;
    }
    for (const asset of assets) {
      const card = document.createElement("div");
      card.className = "asset-card";
      const img = document.createElement("img");
      img.src = assetDataUrl(asset);
      img.alt = asset.name || "";
      card.appendChild(img);
      const meta = document.createElement("div");
      meta.className = "asset-meta";
      const uses = assetUsage(asset.path);
      meta.innerHTML = '<b>' + escapeHtml(asset.name || "image") + "</b><br>" +
        '<span class="asset-path">' + escapeHtml(asset.path) + "</span><br>" +
        Math.max(1, Math.round((asset.size || 0) / 1024)) + " KB · " +
        '<span class="asset-usage' + (uses ? "" : " unused") + '">' + (uses ? "Used " + uses + "×" : "Unused") + "</span>";
      card.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "asset-actions";
      const insert = document.createElement("button");
      insert.type = "button"; insert.className = "ghost"; insert.textContent = "Insert";
      insert.addEventListener("click", () => {
        insertTextAtCursor('\n<img src="' + asset.path + '" alt="' + escapeAttr(asset.name || "image") + '">\n');
      });
      const replace = document.createElement("button");
      replace.type = "button"; replace.className = "ghost"; replace.textContent = "Replace";
      replace.addEventListener("click", () => {
        state.pendingReplaceAssetId = asset.id;
        $("replaceImageInput").click();
      });
      const copy = document.createElement("button");
      copy.type = "button"; copy.className = "ghost"; copy.textContent = "Copy path";
      copy.addEventListener("click", () => {
        const path = asset.path;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path).catch(() => {});
        else {
          const ta = document.createElement("textarea");
          ta.value = path; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch { }
          ta.remove();
        }
      });
      const del = document.createElement("button");
      del.type = "button"; del.className = "ghost danger-text"; del.textContent = "Delete";
      del.addEventListener("click", () => {
        if (!confirm("Remove asset " + (asset.name || asset.path) + " from this notebook?")) return;
        state.assets.delete(asset.id);
        markDirty();
        schedulePreview(false);
        scheduleSave();
        renderAssets();
      });
      actions.appendChild(insert); actions.appendChild(replace); actions.appendChild(copy); actions.appendChild(del);
      card.appendChild(actions);
      host.appendChild(card);
    }
  }

  // ---------- 托管 CSS 规则 ----------
  function findManagedStyle(source) {
    const re = /<style\b[^>]*data-lyra-devtool[^>]*>([\s\S]*?)<\/style>/i;
    const m = re.exec(source);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length, content: m[1] };
  }
  function parseCssRules(text) {
    const rules = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      const selector = m[1].trim();
      const declarations = m[2].trim();
      if (selector && !selector.startsWith("@")) rules.push({ selector, declarations });
    }
    return rules;
  }
  function tidyDeclarations(text) {
    return String(text || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.endsWith(";") ? s : s + ";"))
      .join("\n");
  }
  function serializeCssRules(rules) {
    return rules.map((r) => r.selector + " {\n" + tidyDeclarations(r.declarations).replace(/^/gm, "  ") + "\n}").join("\n\n");
  }
  function defaultSelectorForData(data) {
    if (!data) return "";
    if (data.id) return "#" + data.id;
    const cls = String(data.className || "").trim().split(/\s+/)[0];
    if (cls) return "." + cls;
    return data.tag || "";
  }
  function cssRuleKey(selector, stateSuffix) {
    return selector + (stateSuffix || "");
  }
  function currentCssDraft() {
    return {
      selector: $("cssSelector").value.trim(),
      state: $("cssState").value || "",
      declarations: $("cssDeclarations").value,
    };
  }
  function renderCssRules() {
    const host = $("cssRuleList");
    if (!host) return;
    const block = findManagedStyle(getSource());
    const rules = block ? parseCssRules(block.content) : [];
    host.innerHTML = "";
    if (!rules.length) {
      const empty = document.createElement("div");
      empty.className = "tab-hint";
      empty.textContent = "No managed rules yet. Fill selector + declarations and click Apply rule.";
      host.appendChild(empty);
      return;
    }
    for (const rule of rules) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "css-rule-item";
      const head = document.createElement("span");
      head.textContent = rule.selector;
      item.appendChild(head);
      item.appendChild(document.createTextNode(rule.declarations));
      item.addEventListener("click", () => {
        const m = rule.selector.match(/^(.*?)(?:::[a-z-]+|:[a-z-]+)$/i);
        $("cssSelector").value = m ? m[1].trim() : rule.selector;
        $("cssState").value = m ? m[2] : "";
        $("cssDeclarations").value = rule.declarations;
        document.querySelectorAll(".css-rule-item").forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
      });
      host.appendChild(item);
    }
  }
  function loadCssRuleForDraft() {
    const draft = currentCssDraft();
    if (!draft.selector) return;
    const block = findManagedStyle(getSource());
    if (!block) return;
    const key = cssRuleKey(draft.selector, draft.state);
    const rule = parseCssRules(block.content).find((r) => r.selector === key);
    if (rule) $("cssDeclarations").value = rule.declarations;
  }
  function writeManagedCss(rules) {
    const source = getSource();
    const block = findManagedStyle(source);
    const css = serializeCssRules(rules);
    let next;
    if (block) {
      if (!rules.length) next = source.slice(0, block.start) + source.slice(block.end);
      else next = source.slice(0, block.start) + '<style data-lyra-devtool>\n' + css + '\n</style>' + source.slice(block.end);
    } else if (rules.length) {
      const tag = '<style data-lyra-devtool>\n' + css + '\n</style>\n';
      if (/<\/body>/i.test(source)) next = source.replace(/<\/body>/i, tag + "</body>");
      else next = source + (source.endsWith("\n") ? "" : "\n") + tag;
    } else {
      next = source;
    }
    setSourceValue(next, false);
    const note = currentNote();
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    markDirty();
    schedulePreview(!!state.selectedSelector);
    scheduleSave();
    renderCssRules();
  }
  function applyCssRule() {
    const draft = currentCssDraft();
    const selector = draft.selector || defaultSelectorForData(state.selectedData);
    if (!selector) return;
    $("cssSelector").value = selector;
    const key = cssRuleKey(selector, draft.state);
    const block = findManagedStyle(getSource());
    const rules = block ? parseCssRules(block.content) : [];
    const existing = rules.find((r) => r.selector === key);
    if (existing) existing.declarations = draft.declarations;
    else rules.push({ selector: key, declarations: draft.declarations });
    writeManagedCss(rules);
  }
  function deleteCssRule() {
    const draft = currentCssDraft();
    const selector = draft.selector || defaultSelectorForData(state.selectedData);
    if (!selector) return;
    const block = findManagedStyle(getSource());
    if (!block) return;
    const key = cssRuleKey(selector, draft.state);
    const rules = parseCssRules(block.content).filter((r) => r.selector !== key);
    writeManagedCss(rules);
    $("cssDeclarations").value = "";
  }
  function syncCssFieldsForSelection() {
    if (!state.selectedData) return;
    const selector = defaultSelectorForData(state.selectedData);
    if (selector) {
      $("cssSelector").value = selector;
      $("cssDeclarations").value = "";
      loadCssRuleForDraft();
    }
  }

  function infoHtml(data) {
    return '<b>' + escapeHtml(data.tag || "") + "</b> · " +
      escapeHtml(data.selector || "") +
      (data.text ? '<br><span style="color:#6f8193">' + escapeHtml(data.text) + "</span>" : "");
  }
  function findSourceElementAtCursor() {
    const cm = state.mirror;
    if (!cm || !state.sourceMap) return null;
    const pos = cm.indexFromPos(cm.getCursor());
    let best = null, bestSpan = Infinity;
    const skip = new Set(["style", "script", "head", "meta", "link", "title", "html"]);
    for (const [id, entry] of Object.entries(state.sourceMap)) {
      if (!entry || skip.has(entry.tag)) continue;
      const end = entry.fullEnd == null ? entry.end : entry.fullEnd;
      if (pos < entry.start || pos >= end) continue;
      const span = end - entry.start;
      if (span < bestSpan && span > 0) { best = id; bestSpan = span; }
    }
    return best;
  }
  function selectFromSourceCursor() {
    if (!state.mirror || state.suppressMirror) return;
    const id = findSourceElementAtCursor();
    if (id) {
      if (String(id) === String(state.selectedSrcId)) return;
      state.sourceDrivenSelection = true;
      postToPreview("selectById", { srcId: id });
      setTimeout(() => { state.sourceDrivenSelection = false; }, 900);
    } else if (state.selectedSrcId) {
      state.sourceDrivenSelection = true;
      clearSelection();
      postToPreview("clearHighlight", {});
      setTimeout(() => { state.sourceDrivenSelection = false; }, 900);
    }
  }
  function applySelection(data, isReselect) {
    const entry = state.sourceMap[data.srcId];
    if (!entry) return;
    const fromSource = state.sourceDrivenSelection;
    state.sourceDrivenSelection = false;
    state.selectedSrcId = data.srcId;
    state.selectedSelector = data.selector || "";
    state.selectedLine = entry.line;
    state.selectedData = data;
    $("inspectorLine").textContent = "Ln " + entry.line;
    $("selInfo").innerHTML = infoHtml(data);
    $("sourcePos").textContent = "Ln " + entry.line;
    $("attrId").value = data.id || "";
    $("attrClass").value = data.className || "";
    $("domNewTag").value = entry.tag;
    syncInspector(data.computed || {});
    renderInlineStyles(data.inlineStyle || "");
    syncCssFieldsForSelection();
    setInspectorEnabled(true);
    highlightLine(entry.line, !isReselect && !fromSource, !isReselect && !fromSource, entry.start);
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
  function setTagAttribute(raw, name, value) {
    const esc = escapeAttr(String(value == null ? "" : value));
    const re = new RegExp("\\s" + name + "\\s*=\\s*([\"'])[\\s\\S]*?\\1", "i");
    if (value == null || String(value) === "") return raw.replace(re, "");
    if (re.test(raw)) return raw.replace(re, ' ' + name + '="' + esc + '"');
    if (/\/\s*>$/.test(raw)) return raw.replace(/\/\s*>$/, ' ' + name + '="' + esc + '"/>');
    return raw.replace(/>$/, ' ' + name + '="' + esc + '">');
  }
  function applyAttributes() {
    if (!state.selectedSrcId) return;
    const entry = state.sourceMap[state.selectedSrcId];
    if (!entry) return;
    const source = getSource();
    let tag = source.slice(entry.start, entry.end);
    tag = setTagAttribute(tag, "id", $("attrId").value.trim());
    tag = setTagAttribute(tag, "class", $("attrClass").value.trim());
    const next = source.slice(0, entry.start) + tag + source.slice(entry.end);
    setSourceValue(next, false);
    const note = state.notes.get(state.currentId);
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    clearSelection();
    markDirty();
    schedulePreview(false);
    scheduleSave();
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
    replaceSourceRange(entry.start, entry.end, tag);
    const next = getSource();
    const note = state.notes.get(state.currentId);
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    const newEntry = state.sourceMap[state.selectedSrcId];
    if (newEntry) {
      const raw = next.slice(newEntry.start, newEntry.end);
      const sm = raw.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
      renderInlineStyles(sm ? sm[2] : "");
    }
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
    replaceSourceRange(entry.start, entry.end, stripped);
    const next = getSource();
    const note = state.notes.get(state.currentId);
    if (note) note.html = next;
    state.sourceMap = annotateHtml(next).map;
    renderInlineStyles("");
    markDirty();
    schedulePreview(true);
    scheduleSave();
  }

  // ---------- 源码位置高亮 ----------
  function updateLineNumbers() {
    // CodeMirror 自带行号；保留空函数兼容旧调用点。
  }
  function highlightLine(line, focus, scroll, cursorIndex) {
    const cm = state.mirror;
    if (!cm) return;
    try {
      if (state.highlightedLine) {
        cm.removeLineClass(state.highlightedLine - 1, "background", "cm-active-source-line");
      }
      state.highlightedLine = line;
      cm.addLineClass(line - 1, "background", "cm-active-source-line");
      if (scroll !== false) cm.scrollIntoView({ line: line - 1, ch: 0 }, 100);
      if (focus) {
        cm.focus();
        if (cursorIndex != null) {
          try { cm.setCursor(cm.posFromIndex(cursorIndex)); } catch { cm.setCursor({ line: line - 1, ch: 0 }); }
        } else {
          cm.setCursor({ line: line - 1, ch: 0 });
        }
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
    renderAssets();
    if (!res.data) await saveNow();
  }

  function showError(e) {
    $("errorText").textContent = String(e && e.message ? e.message : e);
    $("errorMask").hidden = false;
  }

  // ---------- 事件 ----------
  function bind() {
    initSourceEditor();
    $("formatBtn").addEventListener("click", formatSource);
    $("imageBtn").addEventListener("click", () => $("imageInput").click());
    $("imageInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) await handleImageFile(file).catch(showError);
    });
    $("replaceImageInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) await replaceAssetFile(file).catch(showError);
    });
    $("refreshAssetsBtn").addEventListener("click", checkAssetReferences);
    $("viewportSelect").addEventListener("change", () => {
      const value = $("viewportSelect").value || "100%";
      $("previewFrame").style.width = value;
    });
    $("applyAttrsBtn").addEventListener("click", applyAttributes);
    attachAutocomplete($("cssPropSearch"), (value) => {
      const q = String(value || "").trim().toLowerCase();
      let list = getCssProperties();
      if (q) list = list.filter((p) => p.toLowerCase().includes(q));
      return list.sort((a, b) => {
        const as = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || a.localeCompare(b);
      });
    }, (prop) => {
      $("cssPropSearch").value = "";
      addInlineProperty(prop);
    });
    $("applyCssRuleBtn").addEventListener("click", applyCssRule);
    $("deleteCssRuleBtn").addEventListener("click", deleteCssRule);
    $("cssSelector").addEventListener("change", loadCssRuleForDraft);
    $("cssState").addEventListener("change", loadCssRuleForDraft);
    $("domSearch").addEventListener("input", () => renderDomTree());
    $("domRenameBtn").addEventListener("click", renameSelectedTag);
    $("domDeleteBtn").addEventListener("click", deleteSelectedElement);
    $("domDuplicateBtn").addEventListener("click", duplicateSelectedElement);
    $("domUpBtn").addEventListener("click", () => moveSelectedElement(-1));
    $("domDownBtn").addEventListener("click", () => moveSelectedElement(1));
    $("domCopyBtn").addEventListener("click", copySelectedHtml);
    document.querySelectorAll(".dev-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
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
      const entry = state.selectedSrcId ? state.sourceMap[state.selectedSrcId] : null;
      if (state.selectedLine) highlightLine(state.selectedLine, true, true, entry ? entry.start : null);
    });
    $("selectParentBtn").addEventListener("click", () => {
      postToPreview("selectParent", {});
    });
    $("clearStyleBtn").addEventListener("click", clearInlineStyle);
    document.querySelectorAll("[data-style]").forEach((el) => {
      el.addEventListener("change", () => {
        if (state.syncingControls || !state.selectedSrcId) return;
        const prop = el.dataset.style;
        applyStyleObject({ [prop]: el.value });
      });
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
  window.__lyraDebug = { state, applyStyleObject, applySelection, renderPreview, getCssProperties, getValueSuggestions };
  init().catch(showError);
})();
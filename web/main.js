// gitwiki frontend — bundled with esbuild. TipTap/ProseMirror WYSIWYG editor;
// inline-comment anchors are ProseMirror decorations that map through every edit.
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import { MARK_RE, parseMarker, buildMarker, newId, locate } from "./anchors.js";
import { makeClientApi } from "./clientApi.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const render = (text) => DOMPurify.sanitize(md.render(text || "")); // for comment bodies
const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Default: talk to the Express server (/api/*). Client OAuth mode reassigns this
// to a browser-side shim (see bootstrap at the bottom).
let api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
};

const $ = (id) => document.getElementById(id);
const state = { baseBranch: "main", branch: "main", path: null, sha: null, mode: "view" };

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  setTimeout(() => (t.className = ""), 2600);
}

// --- ProseMirror anchor decorations --------------------------------------
const anchorKey = new PluginKey("gitwiki-anchors");
const AnchorExtension = Extension.create({
  name: "gitwikiAnchors",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: anchorKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc); // regime B: move anchors through the edit
            const rebuilt = tr.getMeta(anchorKey);
            return rebuilt || set;             // full rebuild on load / reload
          },
        },
        props: { decorations(s) { return anchorKey.getState(s); } },
      }),
    ];
  },
});

// --- Mermaid code blocks -------------------------------------------------
// Render a `mermaid` code block as a live diagram; other code blocks render
// normally. Source stays a fenced ```mermaid block (clean Markdown round-trip).
let mermaidSeq = 0;
function renderMermaid(el, src) {
  if (!window.mermaid) { el.innerHTML = '<div class="mermaid-error">mermaid not loaded</div>'; return; }
  if (!src.trim()) { el.innerHTML = '<div class="mermaid-empty">Empty diagram - type Mermaid syntax below.</div>'; return; }
  const id = "mmd-" + mermaidSeq++;
  window.mermaid
    .render(id, src)
    .then(({ svg }) => { if (el.dataset.src === src) el.innerHTML = svg; })
    .catch((e) => { if (el.dataset.src === src) el.innerHTML = `<div class="mermaid-error">${esc(e?.message || String(e))}</div>`; });
  el.dataset.src = src;
}

function codeBlockNodeView({ node }) {
  const isMermaid = (node.attrs.language || "") === "mermaid";
  const dom = document.createElement("div");
  dom.className = "cb" + (isMermaid ? " cb-mermaid" : "");
  let preview = null, timer = null;
  if (isMermaid) {
    preview = document.createElement("div");
    preview.className = "mermaid-preview";
    preview.setAttribute("contenteditable", "false");
    dom.appendChild(preview);
    renderMermaid(preview, node.textContent);
  }
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.appendChild(code);
  dom.appendChild(pre);
  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false;
      if (((next.attrs.language || "") === "mermaid") !== isMermaid) return false; // re-create on toggle
      node = next;
      if (isMermaid) { clearTimeout(timer); timer = setTimeout(() => renderMermaid(preview, node.textContent), 250); }
      return true;
    },
    ignoreMutation: (m) => !!preview && preview.contains(m.target),
  };
}

const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() { return (props) => codeBlockNodeView(props); },
});

// Re-render all visible diagrams (e.g. after a theme change re-inits mermaid).
function rerenderAllMermaid() {
  document.querySelectorAll(".cb-mermaid").forEach((div) => {
    const src = div.querySelector("pre code")?.textContent || "";
    const prev = div.querySelector(".mermaid-preview");
    if (prev) { delete prev.dataset.src; renderMermaid(prev, src); }
  });
}

let editor = null;
let anchors = [];      // [{ id, meta, root, replies:[], outdated }]
let pageComments = []; // comments with no marker

function ensureEditor() {
  if (editor) return editor;
  editor = new Editor({
    element: $("editor-host"),
    extensions: [
      StarterKit.configure({ codeBlock: false }), // replaced by MermaidCodeBlock below
      MermaidCodeBlock,
      Link.configure({ openOnClick: false, autolink: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false, linkify: true, breaks: true }),
      AnchorExtension,
    ],
    editable: false,
    content: "",
  });
  editor.on("selectionUpdate", updateToolbar);
  editor.on("transaction", updateToolbar);
  $("editor-host").addEventListener("contextmenu", onContextComment);
  $("editor-host").addEventListener("click", (e) => {
    const m = e.target.closest(".pm-anchor");
    if (m) selectAnchor(m.getAttribute("data-id"));
  });
  buildToolbar();
  return editor;
}

// --- Formatting toolbar (TipTap is headless, so we build the UI) ---------
const TOOLBAR = [
  { icon: "B", title: "Bold", css: "font-weight:700", run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
  { icon: "I", title: "Italic", css: "font-style:italic", run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
  { icon: "S", title: "Strikethrough", css: "text-decoration:line-through", run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive("strike") },
  { icon: "</>", title: "Inline code", run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive("code") },
  { sep: true },
  { icon: "H1", title: "Heading 1", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive("heading", { level: 1 }) },
  { icon: "H2", title: "Heading 2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
  { icon: "H3", title: "Heading 3", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive("heading", { level: 3 }) },
  { sep: true },
  { icon: "• List", title: "Bullet list", run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
  { icon: "1. List", title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
  { icon: "❝", title: "Quote", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
  { icon: "{ }", title: "Code block", run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive("codeBlock") },
  { icon: "📊 Mermaid", title: "Insert Mermaid diagram", run: insertMermaid },
  { sep: true },
  { icon: "🔗", title: "Link", run: setLink, active: (e) => e.isActive("link") },
  { icon: "―", title: "Divider", run: (e) => e.chain().focus().setHorizontalRule().run() },
  { sep: true },
  { icon: "⊞ Table", title: "Insert 3×3 table", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), enabled: (e) => !e.isActive("table") },
  { icon: "+Col", title: "Add column", run: (e) => e.chain().focus().addColumnAfter().run(), enabled: (e) => e.isActive("table") },
  { icon: "+Row", title: "Add row", run: (e) => e.chain().focus().addRowAfter().run(), enabled: (e) => e.isActive("table") },
  { icon: "−Col", title: "Delete column", run: (e) => e.chain().focus().deleteColumn().run(), enabled: (e) => e.isActive("table") },
  { icon: "−Row", title: "Delete row", run: (e) => e.chain().focus().deleteRow().run(), enabled: (e) => e.isActive("table") },
  { icon: "⌫ Table", title: "Delete table", run: (e) => e.chain().focus().deleteTable().run(), enabled: (e) => e.isActive("table") },
  { sep: true },
  { icon: "↶", title: "Undo", run: (e) => e.chain().focus().undo().run() },
  { icon: "↷", title: "Redo", run: (e) => e.chain().focus().redo().run() },
];

function insertMermaid(e) {
  e.chain().focus().insertContent({
    type: "codeBlock",
    attrs: { language: "mermaid" },
    content: [{ type: "text", text: "graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Stop]" }],
  }).run();
}

function setLink(e) {
  const current = e.getAttributes("link").href || "https://";
  const url = prompt("Link URL (empty to remove):", current);
  if (url === null) return;
  if (url === "") e.chain().focus().unsetLink().run();
  else e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

function buildToolbar() {
  const bar = $("format-bar");
  bar.innerHTML = "";
  for (const item of TOOLBAR) {
    if (item.sep) {
      const s = document.createElement("span");
      s.className = "fmt-sep";
      bar.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.textContent = item.icon;
    b.title = item.title;
    if (item.css) b.style.cssText = item.css;
    b.onmousedown = (e) => e.preventDefault(); // keep the editor selection on click
    b.onclick = () => { item.run(editor); updateToolbar(); };
    item._el = b;
    bar.appendChild(b);
  }
}

function updateToolbar() {
  if (!editor) return;
  for (const item of TOOLBAR) {
    if (!item._el) continue;
    if (item.active) item._el.classList.toggle("active", !!item.active(editor));
    if (item.enabled) item._el.disabled = !item.enabled(editor);
  }
}

// Flatten the doc's visible text with a parallel map[char] -> ProseMirror pos.
function buildIndex(doc) {
  let text = "";
  const map = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (let k = 0; k < node.text.length; k++) map.push(pos + k);
      text += node.text;
    }
    return true;
  });
  return { text, map };
}

// Resolve an anchor's quote/context to current ProseMirror positions.
function findRange(doc, meta) {
  const { text, map } = buildIndex(doc);
  const loc = locate(text, meta);
  if (!loc) return null;
  const from = map[loc.from];
  const to = (map[loc.to - 1] ?? map[loc.from]) + 1;
  return from == null ? null : { from, to };
}

// Capture quote + surrounding context for a selection (used when creating/saving).
function captureContext(from, to) {
  const { text, map } = buildIndex(editor.state.doc);
  const quote = editor.state.doc.textBetween(from, to, "");
  let ci = map.indexOf(from);
  if (ci === -1) ci = Math.max(0, text.indexOf(quote));
  return {
    quote,
    prefix: text.slice(Math.max(0, ci - 32), ci),
    suffix: text.slice(ci + quote.length, ci + quote.length + 32),
  };
}

// Rebuild the decoration set from anchors[] located in the current doc.
function placeAnchors() {
  if (!editor) return;
  const doc = editor.state.doc;
  const decos = [];
  for (const a of anchors) {
    a.outdated = a.meta.status === "outdated";
    a.resolved = a.meta.status === "resolved";
    if (a.resolved || a.outdated) continue; // resolved/outdated threads get no highlight
    const r = findRange(doc, a.meta);
    if (!r) { a.outdated = true; continue; }
    decos.push(Decoration.inline(r.from, r.to, { class: "pm-anchor", "data-id": a.id }, { id: a.id }));
  }
  editor.view.dispatch(editor.state.tr.setMeta(anchorKey, DecorationSet.create(doc, decos)));
}

// --- Theme ---------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-btn").textContent = theme === "dark" ? "☀️" : "🌙";
  try { localStorage.setItem("gitwiki-theme", theme); } catch { /* ignore */ }
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
    rerenderAllMermaid();
  }
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

// --- Boot ----------------------------------------------------------------
async function boot() {
  let saved = "light";
  try { saved = localStorage.getItem("gitwiki-theme") || "light"; } catch { /* ignore */ }
  applyTheme(saved);
  try {
    const cfg = await api.get("/api/config");
    state.baseBranch = cfg.baseBranch;
    state.branch = cfg.baseBranch;
    $("repo-label").textContent = `${cfg.owner}/${cfg.repo}`;
    api.get("/api/me").then((me) => ($("user-label").textContent = `@${me.login}`)).catch(() => {});
    await loadBranches();
    await loadPages();
  } catch (err) {
    toast("Startup failed: " + err.message, true);
    $("empty-state").textContent = "Could not reach GitHub. Check your .env config. (" + err.message + ")";
  }
}

async function loadBranches() {
  const branches = await api.get("/api/branches");
  const sel = $("branch-select");
  sel.innerHTML = "";
  for (const b of branches) {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name + (b.name === state.baseBranch ? " (base)" : "");
    if (b.name === state.branch) opt.selected = true;
    sel.appendChild(opt);
  }
  toggleReviewBtn();
}

let currentPages = [];            // last fetched page list
const expandedDirs = new Set();   // folders the user has expanded
const pendingFolders = new Set(); // folders created in-UI but not yet saved (git has no empty dirs)

const basename = (p) => p.split("/").pop();
const dirname = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const attr = (s) => s.replace(/"/g, '\\"');

async function loadPages() {
  currentPages = await api.get(`/api/pages?branch=${encodeURIComponent(state.branch)}`);
  renderTree();
}

// On the base branch, edits should go to a draft. Returns a writable branch
// name (creating/switching to a draft if needed), or null if the user cancels.
async function ensureWritableBranch() {
  if (state.branch !== state.baseBranch) return state.branch;
  const draft = prompt("You're on the base branch. Save changes to which draft branch?", "draft/edits");
  if (!draft) return null;
  try {
    await api.send("POST", "/api/branches", { name: draft, from: state.baseBranch });
  } catch (err) {
    if (!/exists/i.test(err.message)) { toast(err.message, true); return null; }
  }
  state.branch = draft;
  await loadBranches();
  return draft;
}

function buildTree(paths) {
  const root = { dirs: {}, files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
      node = node.dirs[parts[i]];
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}
function injectPending(root) {
  for (const p of pendingFolders) {
    let node = root;
    for (const d of p.split("/")) { node.dirs[d] = node.dirs[d] || { dirs: {}, files: [] }; node = node.dirs[d]; }
  }
}

function renderTree() {
  const list = $("page-list");
  list.innerHTML = "";
  // Drop pending folders now backed by a real file.
  for (const p of [...pendingFolders]) if (currentPages.some((f) => f.path.startsWith(p + "/"))) pendingFolders.delete(p);
  if (state.path) {
    const parts = state.path.split("/");
    let pre = "";
    for (let i = 0; i < parts.length - 1; i++) { pre = pre ? pre + "/" + parts[i] : parts[i]; expandedDirs.add(pre); }
  }
  const tree = buildTree(currentPages.map((p) => p.path));
  injectPending(tree);
  if (!Object.keys(tree.dirs).length && !tree.files.length) {
    list.innerHTML = '<li class="muted" style="cursor:default;padding:6px 10px">No pages yet — use the ＋ buttons above.</li>';
    return;
  }
  renderTreeNode(tree, list, "");
}

function renderTreeNode(node, ul, prefix) {
  for (const name of Object.keys(node.dirs).sort()) {
    const path = prefix ? prefix + "/" + name : name;
    const open = expandedDirs.has(path);
    const li = document.createElement("li");
    li.className = "tree-dir" + (pendingFolders.has(path) ? " pending" : "");
    li.dataset.path = path;
    const row = document.createElement("div");
    row.className = "tree-row";
    row.innerHTML = `<span class="tw">${open ? "▾" : "▸"}</span><span class="ti">📁</span><span class="tn">${esc(name)}</span>`;
    row.onclick = () => { open ? expandedDirs.delete(path) : expandedDirs.add(path); renderTree(); };
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      showCtx(e.pageX, e.pageY, [
        { label: "New page", fn: () => beginCreate(path, "page") },
        { label: "New folder", fn: () => beginCreate(path, "folder") },
      ]);
    };
    makeDropTarget(row, path);
    li.appendChild(row);
    if (open) {
      const sub = document.createElement("ul");
      sub.className = "tree-sub";
      sub.dataset.parent = path;
      renderTreeNode(node.dirs[name], sub, path);
      li.appendChild(sub);
    }
    ul.appendChild(li);
  }
  for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement("li");
    li.className = "tree-file" + (f.path === state.path ? " active" : "");
    li.dataset.path = f.path;
    const row = document.createElement("div");
    row.className = "tree-row";
    row.draggable = true;
    row.innerHTML = `<span class="tw"></span><span class="ti">📄</span><span class="tn">${esc(f.name)}</span>`;
    row.onclick = () => openPage(f.path);
    row.ondragstart = (e) => { e.dataTransfer.setData("text/plain", f.path); e.dataTransfer.effectAllowed = "move"; };
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      showCtx(e.pageX, e.pageY, [
        { label: "Rename", fn: () => beginRename(f.path) },
        { label: "Move to…", fn: () => moveViaPrompt(f.path) },
        { sep: true },
        { label: "Delete", danger: true, fn: () => deletePageUI(f.path) },
      ]);
    };
    li.appendChild(row);
    ul.appendChild(li);
  }
}

// Make a folder row (or the root list) accept dropped files to move them in.
function makeDropTarget(el, folderPath) {
  el.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; el.classList.add("drop-target"); };
  el.ondragleave = () => el.classList.remove("drop-target");
  el.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove("drop-target");
    const from = e.dataTransfer.getData("text/plain");
    if (!from) return;
    const to = (folderPath ? folderPath + "/" : "") + basename(from);
    if (dirname(from) === folderPath) return; // already there
    movePageUI(from, to);
  };
}

// --- Tree actions: create / rename / move / delete -----------------------
function beginCreate(parentPath, kind) {
  if (parentPath) { expandedDirs.add(parentPath); renderTree(); }
  const container = parentPath
    ? document.querySelector(`ul.tree-sub[data-parent="${attr(parentPath)}"]`)
    : $("page-list");
  if (!container) return;
  container.querySelector(":scope > .tree-input")?.remove();
  const li = document.createElement("li");
  li.className = "tree-input";
  const row = document.createElement("div");
  row.className = "tree-row";
  row.innerHTML = `<span class="tw"></span><span class="ti">${kind === "folder" ? "📁" : "📄"}</span>`;
  const input = document.createElement("input");
  input.placeholder = kind === "folder" ? "new-folder" : "new-page";
  row.appendChild(input);
  li.appendChild(row);
  container.insertBefore(li, container.firstChild);
  input.focus();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    li.remove();
    if (commit && name) (kind === "folder" ? createFolder : createPage)(parentPath, name);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

function createFolder(parent, name) {
  const path = parent ? parent + "/" + name : name;
  pendingFolders.add(path);
  expandedDirs.add(path);
  renderTree();
  toast("Folder added — create a page inside to save it to git.");
}

async function createPage(parent, name) {
  const branch = await ensureWritableBranch();
  if (!branch) return;
  let n = /\.md$/i.test(name) ? name : name + ".md";
  const full = parent ? parent + "/" + n : n;
  try {
    await api.send("PUT", "/api/page", {
      path: full, branch, message: `Create ${full}`,
      content: `# ${n.replace(/\.md$/i, "")}\n\nStart writing…\n`,
    });
    if (parent) pendingFolders.delete(parent);
    await loadPages();
    await openPage(full);
    toast(`Created ${full}`);
  } catch (err) {
    toast("Create failed: " + err.message, true);
  }
}

function beginRename(path) {
  const li = document.querySelector(`li.tree-file[data-path="${attr(path)}"]`);
  if (!li) return;
  const row = li.querySelector(".tree-row");
  const tn = row.querySelector(".tn");
  const input = document.createElement("input");
  input.value = basename(path);
  tn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== basename(path)) {
      const n = /\.md$/i.test(name) ? name : name + ".md";
      const dir = dirname(path);
      await movePageUI(path, dir ? dir + "/" + n : n);
    } else renderTree();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

function moveViaPrompt(from) {
  const to = prompt("Move/rename to (full path):", from);
  if (to && to !== from) movePageUI(from, /\.md$/i.test(to) ? to : to + ".md");
}

async function movePageUI(from, to) {
  const branch = await ensureWritableBranch();
  if (!branch) return;
  try {
    await api.send("POST", "/api/move", { from, to, branch });
    const wasOpen = state.path === from;
    await loadPages();
    if (wasOpen) await openPage(to);
    toast(`Moved to ${to}`);
  } catch (err) {
    toast("Move failed: " + err.message, true);
    renderTree();
  }
}

async function deletePageUI(path) {
  if (!confirm(`Delete ${path}? This commits a deletion to the branch.`)) return;
  const branch = await ensureWritableBranch();
  if (!branch) return;
  try {
    await api.send("DELETE", "/api/page", { path, branch });
    if (state.path === path) {
      state.path = null;
      $("page-toolbar").classList.add("hidden");
      $("editor-host").classList.add("hidden");
      $("empty-state").classList.remove("hidden");
    }
    await loadPages();
    toast(`Deleted ${path}`);
  } catch (err) {
    toast("Delete failed: " + err.message, true);
  }
}

// --- Tree context menu ---------------------------------------------------
function showCtx(x, y, items) {
  const m = $("ctx-menu");
  m.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    if (it.sep) { li.className = "ctx-sep"; }
    else {
      li.textContent = it.label;
      if (it.danger) li.className = "danger";
      li.onclick = () => { hideCtx(); it.fn(); };
    }
    m.appendChild(li);
  }
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.classList.remove("hidden");
}
function hideCtx() { $("ctx-menu").classList.add("hidden"); }

// --- Page open + modes ---------------------------------------------------
async function openPage(path) {
  try {
    const page = await api.get(
      `/api/page?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(state.branch)}`
    );
    state.path = path;
    state.sha = page.sha;
    $("empty-state").classList.add("hidden");
    $("editor-host").classList.remove("hidden");
    $("page-toolbar").classList.remove("hidden");
    $("page-path").textContent = path;
    ensureEditor();
    editor.commands.setContent(page.content); // tiptap-markdown parses Markdown
    renderTree(); // refresh active-file highlight
    await loadComments(path); // builds anchors[] + places decorations
    setMode("view");
  } catch (err) {
    toast(err.message, true);
  }
}

function setMode(mode) {
  state.mode = mode; // "view" | "edit"
  const editing = mode === "edit";
  editor.setEditable(editing);
  $("editor-host").classList.toggle("editing", editing);
  $("format-bar").classList.toggle("hidden", !editing);
  $("edit-btn").classList.toggle("hidden", editing);
  $("save-btn").classList.toggle("hidden", !editing);
  $("cancel-btn").classList.toggle("hidden", !editing);
  $("mode-tag").textContent = editing ? "· editing" : "· reading";
  if (editing) updateToolbar();
  hideBubble();
}

async function savePage() {
  const content = editor.storage.markdown.getMarkdown();
  let branch = state.branch;
  if (branch === state.baseBranch) {
    const draft = prompt(
      "You're on the base branch. Enter a draft branch name to save your edit to (Cancel to commit directly to base):",
      `draft/${(state.path || "page").replace(/[^a-z0-9]+/gi, "-")}`
    );
    if (draft) {
      try {
        await api.send("POST", "/api/branches", { name: draft, from: state.baseBranch });
      } catch (err) {
        if (!/exists/i.test(err.message)) return toast(err.message, true);
      }
      branch = draft;
    }
  }
  try {
    const res = await api.send("PUT", "/api/page", {
      path: state.path, content, branch, sha: state.sha, message: `Update ${state.path}`,
    });
    await persistAnchors(res.sha); // re-anchor from live decoration positions (no commit)
    state.sha = res.sha;
    toast(`Saved to ${branch}`);
    if (branch !== state.branch) {
      state.branch = branch;
      await loadBranches();
      await loadPages();
    }
    await loadComments(state.path);
    setMode("view");
  } catch (err) {
    toast("Save failed: " + err.message, true);
  }
}

// Persist each anchor's new position from the mapped decoration set. A decoration
// that's gone (its text was deleted) flips the thread to "outdated".
async function persistAnchors(newSha) {
  const set = anchorKey.getState(editor.state);
  const writes = [];
  for (const a of anchors) {
    if (a.meta.status === "outdated" || a.meta.status === "resolved") continue; // no decoration to track
    const { text } = parseMarker(a.root.body);
    const found = set.find().filter((d) => d.spec && d.spec.id === a.id);
    let meta;
    if (!found.length) {
      meta = { ...a.meta, status: "outdated" };
    } else {
      const ctx = captureContext(found[0].from, found[0].to);
      meta = { ...a.meta, quote: ctx.quote, prefix: ctx.prefix, suffix: ctx.suffix, contentSha: newSha };
    }
    writes.push(api.send("PATCH", `/api/comments/${a.root.id}`, { body: `${buildMarker(meta)}\n\n${text}` }));
  }
  await Promise.all(writes);
}

// --- Comments ------------------------------------------------------------
async function loadComments(path) {
  $("comment-box").classList.remove("hidden");
  $("inline-list").innerHTML = '<li class="muted" style="list-style:none;padding:6px">Loading…</li>';
  $("page-comment-list").innerHTML = "";
  try {
    const { issue, comments } = await api.get(`/api/comments?path=${encodeURIComponent(path)}`);
    $("comment-issue").innerHTML = issue
      ? `<a href="${issue.url}" target="_blank">#${issue.number}</a>` : "(no thread yet)";
    anchors = [];
    pageComments = [];
    const byId = {};
    for (const c of comments) {
      const { meta } = parseMarker(c.body);
      if (meta && meta.kind === "anchor") {
        const a = { id: meta.id, meta, root: c, replies: [], outdated: false };
        anchors.push(a);
        byId[meta.id] = a;
      } else if (!meta) pageComments.push(c);
    }
    for (const c of comments) {
      const { meta } = parseMarker(c.body);
      if (meta && meta.kind === "reply" && byId[meta.id]) byId[meta.id].replies.push(c);
    }
    placeAnchors();   // sets a.outdated for anchors whose quote can't be found
    renderComments();
  } catch (err) {
    $("inline-list").innerHTML = `<li class="muted" style="list-style:none;padding:6px">${err.message}</li>`;
  }
}

const commentHtml = (c) => {
  const { text } = parseMarker(c.body);
  return `<div class="comment">
    <div class="meta">${c.avatar ? `<img src="${c.avatar}" alt="">` : ""}
      <strong>${c.author || "?"}</strong><span>· ${new Date(c.createdAt).toLocaleString()}</span></div>
    <div class="body">${render(text)}</div></div>`;
};

function renderComments() {
  const il = $("inline-list");
  il.innerHTML = "";
  if (!anchors.length) il.innerHTML = '<li class="muted" style="list-style:none;padding:6px">No inline comments.</li>';
  // Open threads first, then resolved/outdated.
  const ordered = [...anchors].sort((a, b) => (a.resolved || a.outdated ? 1 : 0) - (b.resolved || b.outdated ? 1 : 0));
  for (const a of ordered) {
    const li = document.createElement("li");
    li.className = "thread" + (a.outdated ? " outdated" : "") + (a.resolved ? " resolved" : "");
    li.dataset.id = a.id;
    const quote = (a.meta.quote || "").replace(/\s+/g, " ").trim();
    const badge = a.resolved
      ? '<span class="thread-badge resolved">resolved</span>'
      : a.outdated ? '<span class="thread-badge outdated">outdated</span>' : "";
    li.innerHTML = `
      <div class="thread-quote" title="Jump to this anchor">
        <span class="q">${esc(quote) || "(empty)"}</span>
        ${badge}
        <button class="thread-resolve" title="${a.resolved ? "Reopen thread" : "Resolve thread"}">${a.resolved ? "↺" : "✓"}</button>
      </div>
      <div class="thread-body">${commentHtml(a.root)}${a.replies.map(commentHtml).join("")}</div>
      ${a.resolved ? "" : '<div class="reply-row"><input type="text" placeholder="Reply…" /><button>Reply</button></div>'}`;
    li.querySelector(".thread-quote").onclick = () => selectAnchor(a.id);
    const resolveBtn = li.querySelector(".thread-resolve");
    resolveBtn.onclick = (e) => { e.stopPropagation(); resolveThread(a, !a.resolved); };
    const replyRow = li.querySelector(".reply-row");
    if (replyRow) {
      const input = replyRow.querySelector("input");
      const send = () => replyToAnchor(a.id, input.value).then(() => (input.value = ""));
      replyRow.querySelector("button").onclick = send;
      input.onkeydown = (e) => { if (e.key === "Enter") send(); };
    }
    il.appendChild(li);
  }
  $("page-comment-list").innerHTML = pageComments.length
    ? pageComments.map((c) => `<li>${commentHtml(c)}</li>`).join("")
    : '<li class="muted" style="list-style:none;padding:6px">No page comments.</li>';
}

function highlightThread(id) {
  [...$("inline-list").children].forEach((li) => li.classList.toggle("focused", li.dataset.id === id));
}

function selectAnchor(id) {
  const a = anchors.find((x) => x.id === id);
  if (!a) return;
  highlightThread(id);
  const card = [...$("inline-list").children].find((li) => li.dataset.id === id);
  card && card.scrollIntoView({ block: "nearest" });
  if (a.outdated) return toast("This anchor is outdated — the text it pointed to is gone.", true);
  const set = anchorKey.getState(editor.state);
  const found = set.find().filter((d) => d.spec && d.spec.id === id);
  if (found.length) {
    editor.commands.setTextSelection({ from: found[0].from, to: found[0].to });
    const dom = editor.view.domAtPos(found[0].from).node;
    const el = dom.nodeType === 3 ? dom.parentElement : dom;
    el && el.scrollIntoView({ block: "center" });
  }
}

// --- Selecting text -> bubble -> modal -----------------------------------
let pendingSel = null;

function getActiveSelection() {
  if (!editor) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const quote = editor.state.doc.textBetween(from, to, "");
  if (!quote.trim()) return null;
  return { from, to, quote };
}

function showBubble(x, y, info) {
  pendingSel = info;
  const b = $("sel-bubble");
  b.style.left = x + "px";
  b.style.top = y + 8 + "px";
  b.classList.remove("hidden");
}
function hideBubble() { $("sel-bubble").classList.add("hidden"); }

function onContextComment(e) {
  const info = getActiveSelection();
  if (info && state.path) { e.preventDefault(); openCommentModal(info); }
}

function openCommentModal(info) {
  if (!info) return;
  pendingSel = info;
  $("cmt-quote").textContent = info.quote.slice(0, 400);
  $("cmt-input").value = "";
  $("comment-modal").classList.remove("hidden");
  $("cmt-input").focus();
  hideBubble();
}
function closeCommentModal() { $("comment-modal").classList.add("hidden"); pendingSel = null; }

async function submitInlineComment() {
  const info = pendingSel;
  const text = $("cmt-input").value.trim();
  if (!info || !text) return;
  const ctx = captureContext(info.from, info.to);
  const meta = {
    v: 1, kind: "anchor", id: newId(),
    quote: ctx.quote, prefix: ctx.prefix, suffix: ctx.suffix,
    contentSha: state.sha, status: "active",
  };
  try {
    await api.send("POST", "/api/comments", { path: state.path, body: `${buildMarker(meta)}\n\n${text}` });
    closeCommentModal();
    await loadComments(state.path);
    toast("Inline comment added (no commit)");
  } catch (err) {
    toast("Comment failed: " + err.message, true);
  }
}

// Resolve / reopen an inline thread by flipping its anchor marker's status.
// Resolving removes its editor highlight; the thread stays (collapsed/dimmed).
async function resolveThread(a, resolve) {
  const { text } = parseMarker(a.root.body);
  const meta = { ...a.meta, status: resolve ? "resolved" : "active" };
  try {
    await api.send("PATCH", `/api/comments/${a.root.id}`, { body: `${buildMarker(meta)}\n\n${text}` });
    await loadComments(state.path);
    toast(resolve ? "Thread resolved" : "Thread reopened");
  } catch (err) {
    toast("Failed: " + err.message, true);
  }
}

async function replyToAnchor(id, text) {
  text = (text || "").trim();
  if (!text) return;
  try {
    await api.send("POST", "/api/comments", { path: state.path, body: `${buildMarker({ v: 1, kind: "reply", id })}\n\n${text}` });
    await loadComments(state.path);
  } catch (err) {
    toast("Reply failed: " + err.message, true);
  }
}

async function sendComment() {
  const input = $("comment-input");
  const body = input.value.trim();
  if (!body || !state.path) return;
  $("comment-send").disabled = true;
  try {
    await api.send("POST", "/api/comments", { path: state.path, body });
    input.value = "";
    await loadComments(state.path);
    toast("Comment posted");
  } catch (err) {
    toast("Comment failed: " + err.message, true);
  } finally {
    $("comment-send").disabled = false;
  }
}

// --- New page / branch / publish ----------------------------------------

async function newBranch() {
  const name = prompt("New draft branch name:", "draft/my-edits");
  if (!name) return;
  try {
    await api.send("POST", "/api/branches", { name, from: state.baseBranch });
    state.branch = name;
    await loadBranches();
    await loadPages();
    toast(`Switched to ${name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function publish() {
  if (state.branch === state.baseBranch) return toast("Already on base branch.", true);
  const draft = state.branch;
  try {
    const r = await api.send("POST", "/api/publish", { branch: draft });
    if (r.merged) {
      toast(`Published: merged #${r.number} into ${state.baseBranch}`);
      state.branch = state.baseBranch;
      await loadBranches();
      await loadPages();
      if (state.path) openPage(state.path).catch(() => {});
    } else {
      toast(`PR #${r.number} can't auto-merge: ${r.reason}`, true);
      window.open(r.url, "_blank");
    }
  } catch (err) {
    toast("Publish failed: " + err.message, true);
  }
}

// --- Draft review / diff -------------------------------------------------
function lineDiff(a, b) {
  const A = a == null ? [] : a.split("\n");
  const B = b == null ? [] : b.split("\n");
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ t: "eq", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: A[i] }); i++; }
    else { out.push({ t: "add", text: B[j] }); j++; }
  }
  while (i < m) out.push({ t: "del", text: A[i++] });
  while (j < n) out.push({ t: "add", text: B[j++] });
  return out;
}

const GUTTER = { eq: " ", add: "+", del: "-" };
const rowHtml = (r) =>
  `<div class="diff-row ${r.t}"><span class="gutter">${GUTTER[r.t]}</span><span class="txt">${esc(r.text)}</span></div>`;

function renderDiffRows(diff) {
  const CTX = 3;
  let html = "";
  for (let k = 0; k < diff.length; k++) {
    const row = diff[k];
    if (row.t === "eq") {
      let end = k;
      while (end < diff.length && diff[end].t === "eq") end++;
      const run = diff.slice(k, end);
      const atStart = k === 0, atEnd = end === diff.length;
      if (run.length > CTX * 2 + 1) {
        const head = atStart ? [] : run.slice(0, CTX);
        const tail = atEnd ? [] : run.slice(-CTX);
        const hidden = run.length - head.length - tail.length;
        html += head.map(rowHtml).join("");
        html += `<div class="diff-collapsed">… ${hidden} unchanged line${hidden === 1 ? "" : "s"}</div>`;
        html += tail.map(rowHtml).join("");
      } else html += run.map(rowHtml).join("");
      k = end - 1;
    } else html += rowHtml(row);
  }
  return html || '<div class="diff-empty">No textual changes.</div>';
}

async function openReview() {
  if (state.branch === state.baseBranch) return toast("Switch to a draft branch first.", true);
  $("diff-title").textContent = `Review: ${state.branch}`;
  $("diff-summary").textContent = " — loading…";
  $("diff-body").innerHTML = '<div class="diff-empty">Comparing against ' + state.baseBranch + "…</div>";
  $("diff-modal").classList.remove("hidden");
  try {
    const drafts = await api.get("/api/drafts");
    const d = drafts.find((x) => x.name === state.branch);
    if (!d) {
      $("diff-summary").textContent = "";
      $("diff-body").innerHTML = '<div class="diff-empty">This branch has no commits ahead of ' + state.baseBranch + ".</div>";
      return;
    }
    $("diff-summary").textContent = ` — ${d.files.length} file(s), ahead ${d.ahead}${d.behind ? `, behind ${d.behind}` : ""}`;
    if (!d.files.length) {
      $("diff-body").innerHTML = '<div class="diff-empty">No Markdown files changed (other file types not shown).</div>';
      return;
    }
    $("diff-body").innerHTML = "";
    for (const f of d.files) {
      const block = document.createElement("div");
      block.className = "diff-file";
      block.innerHTML = `
        <div class="diff-file-head">
          <span class="diff-badge ${f.status}">${f.status}</span>
          <span>${f.filename}</span>
          <span class="diff-stat"><span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></span>
        </div>
        <div class="diff-lines">Loading…</div>`;
      $("diff-body").appendChild(block);
      api.get(`/api/diff?path=${encodeURIComponent(f.filename)}&branch=${encodeURIComponent(state.branch)}`)
        .then((res) => { block.querySelector(".diff-lines").innerHTML = renderDiffRows(lineDiff(res.base, res.head)); })
        .catch((err) => { block.querySelector(".diff-lines").innerHTML = `<div class="diff-empty">${err.message}</div>`; });
    }
  } catch (err) {
    $("diff-body").innerHTML = `<div class="diff-empty">${err.message}</div>`;
  }
}

function toggleReviewBtn() {
  $("review-btn").classList.toggle("hidden", state.branch === state.baseBranch);
}

// --- Page version history ------------------------------------------------
async function openHistory() {
  if (!state.path) return toast("Open a page first.", true);
  $("hist-title").textContent = `History: ${state.path}`;
  $("hist-list").innerHTML = '<li class="muted" style="padding:8px">Loading…</li>';
  $("hist-diff").innerHTML = "";
  $("history-modal").classList.remove("hidden");
  try {
    const commits = await api.get(
      `/api/history?path=${encodeURIComponent(state.path)}&branch=${encodeURIComponent(state.branch)}`
    );
    if (!commits.length) { $("hist-list").innerHTML = '<li class="muted" style="padding:8px">No history on this branch.</li>'; return; }
    const ul = $("hist-list");
    ul.innerHTML = "";
    commits.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = "hist-item" + (i === 0 ? " active" : "");
      li.innerHTML = `
        <div class="hist-msg">${esc(c.message.split("\n")[0])}</div>
        <div class="hist-meta">${c.avatar ? `<img src="${c.avatar}" alt="">` : ""}${esc(c.author)} ·
          ${new Date(c.date).toLocaleString()} ·
          <a href="${c.url}" target="_blank" onclick="event.stopPropagation()">${c.sha.slice(0, 7)}</a></div>`;
      li.onclick = () => { [...ul.children].forEach((x) => x.classList.remove("active")); li.classList.add("active"); selectCommit(c); };
      ul.appendChild(li);
    });
    selectCommit(commits[0]);
  } catch (err) {
    $("hist-list").innerHTML = `<li class="muted" style="padding:8px">${err.message}</li>`;
  }
}

async function selectCommit(c) {
  $("hist-diff").innerHTML = '<div class="diff-empty">Loading…</div>';
  try {
    const cur = await api.get(`/api/page?path=${encodeURIComponent(state.path)}&branch=${encodeURIComponent(c.sha)}`);
    let base = null;
    if (c.parent) {
      const p = await api.get(`/api/page?path=${encodeURIComponent(state.path)}&branch=${encodeURIComponent(c.parent)}`).catch(() => null);
      base = p ? p.content : null; // null = file didn't exist at parent (first version)
    }
    $("hist-diff").innerHTML = `
      <div class="hist-actions">
        <button id="hist-restore" class="primary">Restore this version</button>
        <span class="muted">loads it into the editor — Save to commit the restore</span>
      </div>
      <div class="diff-lines">${renderDiffRows(lineDiff(base, cur.content))}</div>`;
    $("hist-restore").onclick = () => {
      editor.commands.setContent(cur.content);
      $("history-modal").classList.add("hidden");
      setMode("edit");
      toast(`Loaded version ${c.sha.slice(0, 7)} — Save to restore it`);
    };
  } catch (err) {
    $("hist-diff").innerHTML = `<div class="diff-empty">${err.message}</div>`;
  }
}

// --- Wiring --------------------------------------------------------------
$("branch-select").onchange = async (e) => {
  state.branch = e.target.value;
  toggleReviewBtn();
  await loadPages();
  if (state.path) openPage(state.path).catch(() => {});
};
$("review-btn").onclick = openReview;
$("history-btn").onclick = openHistory;
$("hist-close").onclick = () => $("history-modal").classList.add("hidden");
$("history-modal").onclick = (e) => { if (e.target.id === "history-modal") $("history-modal").classList.add("hidden"); };
$("diff-close").onclick = () => $("diff-modal").classList.add("hidden");
$("diff-modal").onclick = (e) => { if (e.target.id === "diff-modal") $("diff-modal").classList.add("hidden"); };
$("diff-publish").onclick = async () => { await publish(); $("diff-modal").classList.add("hidden"); };

$("edit-btn").onclick = () => setMode("edit");
$("cancel-btn").onclick = () => openPage(state.path); // re-fetch original, discard edits
$("save-btn").onclick = savePage;
$("comment-send").onclick = sendComment;
$("new-page-btn").onclick = () => beginCreate("", "page");
$("new-folder-btn").onclick = () => beginCreate("", "folder");
$("new-branch-btn").onclick = newBranch;
$("publish-btn").onclick = publish;
$("theme-btn").onclick = toggleTheme;

// Root of the tree is a drop target (move to top level) + right-click menu.
makeDropTarget($("page-list"), "");
$("page-list").addEventListener("contextmenu", (e) => {
  if (e.target.closest(".tree-row")) return; // row handlers take precedence
  e.preventDefault();
  showCtx(e.pageX, e.pageY, [
    { label: "New page", fn: () => beginCreate("", "page") },
    { label: "New folder", fn: () => beginCreate("", "folder") },
  ]);
});
document.addEventListener("click", hideCtx);
document.addEventListener("scroll", hideCtx, true);

// Sidebar resize handle.
(() => {
  const handle = $("sidebar-resizer");
  if (!handle) return;
  let dragging = false;
  handle.addEventListener("mousedown", (e) => { dragging = true; document.body.classList.add("resizing"); e.preventDefault(); });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(520, Math.max(160, e.clientX));
    document.getElementById("layout").style.setProperty("--sidebar-w", w + "px");
  });
  document.addEventListener("mouseup", () => { dragging = false; document.body.classList.remove("resizing"); });
})();

$("sel-bubble").onclick = () => openCommentModal(pendingSel);
$("cmt-submit").onclick = submitInlineComment;
$("cmt-cancel").onclick = closeCommentModal;
$("cmt-close").onclick = closeCommentModal;
$("comment-modal").onclick = (e) => { if (e.target.id === "comment-modal") closeCommentModal(); };
$("cmt-input").onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitInlineComment(); };

document.addEventListener("mouseup", (e) => {
  if (e.target.id === "sel-bubble" || $("comment-modal").contains(e.target)) return;
  setTimeout(() => {
    const info = getActiveSelection();
    if (info && state.path) showBubble(e.pageX, e.pageY, info);
    else hideBubble();
  }, 0);
});
document.addEventListener("mousedown", (e) => { if (e.target.id !== "sel-bubble") hideBubble(); });

// --- Bootstrap: server mode (default) or client OAuth mode ---------------
function parseRepoFromUrl() {
  const u = new URL(location.href);
  let r = u.searchParams.get("repo");
  const branch = u.searchParams.get("branch") || "";
  if (!r && location.hash) {
    const h = location.hash.replace(/^#\/?/, "");
    if (/^[^/]+\/[^/]+/.test(h)) r = h.split("/").slice(0, 2).join("/");
  }
  if (!r || !r.includes("/")) return null;
  const [owner, repo] = r.split("/");
  return owner && repo ? { owner, repo, branch } : null;
}

let supabaseClient = null; // set in client mode, used by sign-out + re-auth

const isAuthError = (err) => err?.status === 401 || /bad credentials|401/i.test(err?.message || "");

// Drop the cached GitHub token and the Supabase session so the next screen
// forces a fresh "Sign in with GitHub" (re-consent after a revoke).
async function clearAuth() {
  sessionStorage.removeItem("gh_token");
  try { await supabaseClient?.auth.signOut(); } catch { /* ignore */ }
}

// Wrap the client API so a 401 anywhere (e.g. token revoked mid-session)
// kicks the user back to a fresh sign-in instead of spamming "Bad credentials".
function withAuthGuard(inner) {
  const guard = async (fn) => {
    try { return await fn(); }
    catch (err) {
      if (isAuthError(err)) {
        await clearAuth();
        showAuthOverlay(false, parseRepoFromUrl(), "Your GitHub access was revoked or expired. Please sign in again.");
      }
      throw err;
    }
  };
  return { get: (u) => guard(() => inner.get(u)), send: (m, u, b) => guard(() => inner.send(m, u, b)) };
}

async function startClientApp(token, info) {
  // Resolve the base branch (URL override, else the repo's default). This is also
  // the first authenticated call, so a revoked token fails here with 401.
  let baseBranch = info.branch;
  if (!baseBranch) {
    const meta = await new Octokit({ auth: token }).repos.get({ owner: info.owner, repo: info.repo });
    baseBranch = meta.data.default_branch;
  }
  api = withAuthGuard(makeClientApi({ token, owner: info.owner, repo: info.repo, baseBranch }));
  $("auth-overlay").classList.add("hidden");
  $("signout-btn").classList.remove("hidden");
  boot();
}

async function setupClientMode(cfg) {
  supabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  // provider_token (the GitHub token) is only present right after OAuth; cache it.
  supabaseClient.auth.onAuthStateChange((_e, session) => {
    if (session?.provider_token) sessionStorage.setItem("gh_token", session.provider_token);
  });
  $("signout-btn").onclick = async () => { await clearAuth(); location.reload(); };

  const { data: { session } } = await supabaseClient.auth.getSession();
  const token = session?.provider_token || sessionStorage.getItem("gh_token");
  const info = parseRepoFromUrl();

  if (token && info) {
    try { await startClientApp(token, info); return; }
    catch (err) {
      if (isAuthError(err)) {
        await clearAuth(); // revoked/expired token cached -> force a real sign-in
        showAuthOverlay(false, info, "Your GitHub access was revoked or expired. Please sign in again.");
      } else {
        showAuthOverlay(!!token, info, "Couldn't open repo: " + err.message);
      }
      return;
    }
  }
  showAuthOverlay(!!token, info, "");
}

function showAuthOverlay(hasToken, info, note) {
  const overlay = $("auth-overlay");
  overlay.classList.remove("hidden");
  $("signout-btn").classList.add("hidden");
  $("auth-repo").value = info ? `${info.owner}/${info.repo}` : "";
  $("auth-note").textContent = note;
  const btn = $("auth-action");
  btn.textContent = hasToken ? "Open" : "Sign in with GitHub";
  $("auth-sub").textContent = hasToken
    ? "Signed in. Choose a repository to open."
    : "Sign in with your GitHub account to open a repository as a wiki.";
  btn.onclick = async () => {
    const val = $("auth-repo").value.trim();
    if (!/^[^/]+\/[^/]+$/.test(val)) { $("auth-note").textContent = "Enter a repository as owner/repo."; return; }
    const url = new URL(location.href);
    url.searchParams.set("repo", val);
    const token = sessionStorage.getItem("gh_token");
    if (hasToken && token) {
      history.replaceState(null, "", url.toString());
      try {
        await startClientApp(token, parseRepoFromUrl());
      } catch (err) {
        if (isAuthError(err)) { await clearAuth(); showAuthOverlay(false, parseRepoFromUrl(), "That session is no longer valid. Please sign in again."); }
        else $("auth-note").textContent = err.message;
      }
    } else {
      // Carry the repo through the OAuth round-trip via redirectTo.
      await supabaseClient.auth.signInWithOAuth({ provider: "github", options: { scopes: "repo", redirectTo: url.toString() } });
    }
  };
}

(function initApp() {
  const cfg = window.GITWIKI_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) setupClientMode(cfg); // static / OAuth mode
  else boot();                                                      // legacy server mode
})();

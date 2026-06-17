# gitwiki

A **Confluence-like wiki POC** that fronts a GitHub repo of Markdown files.

- **Runs hosted *or* fully static** — a server with a shared token, *or* a static app where
  each user signs in with their own GitHub account (Supabase OAuth) and all calls run in the
  browser. See "Two ways to run".
- **Pages** are `.md` files in a GitHub repo (the source of truth).
- **Drafts / concurrent work** use **git branches** — edit on a branch, review the diff, publish (PR + merge).
- **Comments** are backed by **GitHub Issues** (one issue per page) — both page-level and **inline/anchored**.
- **Editing** is **WYSIWYG** via **TipTap/ProseMirror** with a formatting toolbar
  (bold, italic, strike, code, H1-H3, lists, quote, code block, link, divider,
  **tables** with add/delete row+column, undo/redo). Tables round-trip to GFM Markdown.
- **Mermaid diagrams** render inline: insert one from the toolbar (📊 Mermaid), edit the
  source in the editor with a **live preview**, and read mode shows just the rendered diagram.
  Stored as a fenced ```mermaid block (so MkDocs' mermaid plugin renders it on publish too).
- **UI**: a VSCode-style **file-explorer tree** (resizable, with indent guides) and a
  **dark mode** toggle (persisted in `localStorage`).

## File explorer

The left tree is the place to organize pages — no path modal:

- **New page / New folder** via the ＋ buttons in the header, the right-click menu on any
  folder, or right-click on empty space (creates at root). You type the name **inline** in
  the tree.
- **Rename** a page inline (right-click → Rename); **Move** by **dragging** a page onto a
  folder (or right-click → Move to…). Moves/renames are a copy-to-new-path + delete-old on
  GitHub (no native rename).
- **Delete** via the right-click menu.
- **New folders are "pending"** (shown italic) until you add a page inside — git has no empty
  directories, so the folder is saved only once it contains a file.
- All write operations honor the branch model: on the base branch you're prompted once for a
  draft branch to commit to.
- Inline-comment **anchors are ProseMirror decorations** that map through every edit (they
  follow the text as you type, rather than being re-guessed afterward).

## Inline (anchored) comments

**Select any text — while reading or editing — and a floating "💬 Comment" bubble
appears (or right-click → Comment).** That opens a composer modal; submitting attaches a
threaded comment to that range. **No commit is made.** The anchor (quote + surrounding
context) is stored in a hidden marker *inside the issue comment*, so annotations are a
pure overlay; the `.md` file is never touched by commenting. Anchors render as
highlights in the editor; clicking one (or a thread's quote in the sidebar) jumps to it.

Because the editor is ProseMirror, anchors are **decorations that map through every
edit** — they shift/shrink with your typing in real time. On **Save**, each anchor's new
position (read from the mapped decoration) is written back to its comment via the API
(still no commit). If the highlighted text is deleted, the decoration collapses and the
thread is flagged **outdated**, preserving its original snapshot, rather than orphaning.

Inline threads can be **resolved** (✓ on the thread) — the highlight is removed and the
thread collapses/dims to the bottom; **reopen** (↺) brings it back. Resolution is stored in
the anchor marker (status), so it costs no commit.

There are two modes — **Read** (read-only) and **Edit** — on the same editor; commenting
works in either, so you never enter a dedicated "comment mode."

Anchors stay attached through edits because CodeMirror moves their markers as you type.
On **Save**, each anchor's new position is written back to its comment via the API
(still no commit for the comment). If the highlighted text is rewritten away entirely,
the thread is flagged **outdated** (its original snapshot preserved) rather than silently
lost. On load, an anchor is placed **exactly** when the page's content sha is unchanged,
and **re-located by fuzzy quote/context match** otherwise (orphans → outdated).

## Why not MkDocs?

MkDocs is a *static site generator*: it batch-builds `.md` → an HTML site. That's
great for **publishing** a finished docs site, but a Confluence-like tool needs
**live** editing, branch-as-draft, and comments — all dynamic. So gitwiki renders
Markdown on the fly instead.

The payoff: because the source of truth stays as plain `.md` files in a normal repo
layout, **the repo remains MkDocs-compatible**. Point MkDocs at the same repo whenever
you want a polished public site — gitwiki is the live editing front end, MkDocs is an
optional publish target.

## Setup

```bash
cd gitwiki
npm install
cp .env.example .env   # then fill in your token + repo
npm start              # `prestart` bundles the frontend (esbuild) first, then serves
```

Open http://localhost:4000.

The frontend is bundled from `web/` into `public/bundle.js`. `npm start` rebuilds it
automatically; while iterating on frontend code, run `npm run watch` in another terminal
for incremental rebuilds.

## Two ways to run

gitwiki runs in either mode with the **same bundle** — the difference is purely config:

### 1. Server mode (default)
The Express server holds a `GITHUB_TOKEN` and proxies all GitHub calls. Single shared
identity; simplest for local/solo use. This is what the `.env` above configures.

### 2. Client OAuth mode (static, multi-user)
A fully static app: each user **signs in with their own GitHub account**, and all GitHub
calls happen **in the browser** (Octokit + the user's token). No server token; the Express
process is reduced to a static file host (any static host works — GitHub Pages, Netlify, …).

Why a broker is still involved: GitHub's OAuth token exchange **requires a client secret and
isn't CORS-enabled** (even with PKCE), so a secret-less browser-only exchange isn't possible.
gitwiki uses **Supabase Auth** as that broker — it runs the OAuth handshake and hands the
browser the GitHub token (`session.provider_token`), which then talks to `api.github.com`
directly (that endpoint *is* CORS-enabled).

To enable it:
1. Create a free Supabase project.
2. Supabase → Authentication → Providers → **GitHub**: enable it, paste a GitHub OAuth App's
   Client ID/Secret, and set that OAuth App's callback URL to the one Supabase shows.
3. Put the Supabase project URL + anon key in [`public/config.js`](public/config.js) (the anon
   key is public by design).
4. Open the app with a repo in the URL: `…/?repo=owner/name&branch=main` (or `#/owner/name`).
   You'll get a "Sign in with GitHub" screen; after auth, the repo loads.

**Upsides of client mode:** real per-user authorship (commits/comments are *yours*), per-user
rate limits, and no server holding secrets or repo data. **Caveats:** the GitHub token lives
in the browser (XSS exposure — scope it tightly); Supabase doesn't persist `provider_token`,
so gitwiki caches it in `sessionStorage` for the tab.

#### Per-repository access (GitHub App mode)
By default the OAuth App requests the `repo` scope — all of the user's repos. To limit access
to **only the repo a user opens**, use a **GitHub App** instead:
1. Create a GitHub App with **Repository permissions**: Contents R/W, Issues R/W, Pull requests
   R/W, Metadata R. Set its callback URL to the Supabase callback, enable *"Request user
   authorization (OAuth) during installation,"* and turn **off** *"Expire user authorization
   tokens"* (so the browser token doesn't need refreshing).
2. In Supabase's GitHub provider, use the **GitHub App's** Client ID/Secret (a GitHub App has an
   OAuth-compatible user flow).
3. Set `githubAppSlug` in [`public/config.js`](public/config.js) to the app's slug
   (`github.com/apps/<slug>`).

Now sign-in works as before, but if the app isn't installed on the opened repo, gitwiki shows an
**"Install on this repository"** gate; the user installs it on just that repo, and the resulting
token can't touch anything else. (Org-owned repos require an org owner to approve the install —
the same governance an org's OAuth-app policy would impose, but the grant is per-repo, not all-repos.)

### `.env`

| Var | Meaning |
|---|---|
| `GITHUB_TOKEN` | PAT with `repo` scope (classic) or fine-grained Contents+Issues read/write |
| `GITHUB_OWNER` | repo owner (user or org) |
| `GITHUB_REPO`  | the wiki repo |
| `BASE_BRANCH`  | the "published" branch (default `main`) |
| `PORT`         | server port (default `4000`) |

Any repo with `.md` files works. Try a throwaway repo with a couple of Markdown files.

## How it maps to GitHub

| Wiki action | GitHub mechanism |
|---|---|
| List pages | Git Tree API (recursive), filtered to `*.md` |
| Open page | Contents API (decode base64) |
| Save edit | Contents API create/update on a branch (one commit) |
| Version history | Per-page commit log (`listCommits` for the file) + per-version diff |
| Restore a version | Load an old version's content into the editor; Save commits the restore |
| New draft | Create a branch ref from base |
| Review draft | Compare base...branch; render a line diff of each changed `.md` |
| Publish | Find-or-create a PR for the draft, then **merge it** (squash) into base |
| Comment thread | GitHub Issue titled `[wiki] <path>` |
| Add comment | Issue comment on that issue |
| Inline comment | Issue comment carrying a hidden `<!-- gitwiki:{...} -->` anchor marker |
| Re-anchor on edit | `PATCH` the comment's body with new geometry — **no commit** |

## Endpoints

```
GET  /api/config                 base branch + repo info
GET  /api/me                     authenticated user
GET  /api/branches               list branches
POST /api/branches               { name, from }            create draft branch
GET  /api/history?path=&branch=  per-page commit history (newest first)
GET  /api/drafts                 branches ahead of base + changed .md files
GET  /api/diff?path=&branch=      base vs head content for one page
GET  /api/pages?branch=          list .md pages
GET  /api/page?path=&branch=     get page content + sha
PUT  /api/page                   { path, content, branch, sha?, message? }
POST /api/publish                { branch, title?, body? } PR + merge into base
GET  /api/comments?path=         list comments for a page (page + inline)
POST /api/comments               { path, body }            add comment (marker = inline)
PATCH /api/comments/:id          { body }                  re-anchor / edit a comment
```

## POC limits / next steps

- No file delete / rename / move yet.
- WYSIWYG round-trips Markdown through ProseMirror, so **saving may reformat** the
  Markdown (normalized bullets, emphasis markers, etc.) — expect some cosmetic diff noise.
- Anchors match on visible text within a block; a selection spanning block boundaries
  may not re-locate and can land as outdated.
- Live decoration tracking applies to edits made **in-app**; edits made out-of-band
  (directly on GitHub) fall back to fuzzy re-location by quote on next load.
- No conflict UI beyond the GitHub `sha` optimistic-lock on save.
- Auth is a single server-side token (single-user POC), not per-user OAuth — so all
  comments/commits are attributed to that token's identity.

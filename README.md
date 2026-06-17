# gitwiki

A **fully static, Confluence-like wiki** over a GitHub repo of Markdown files.
There is **no backend** — every user signs in with their own GitHub account and all
GitHub calls happen in the browser. Host it on GitHub Pages (or any static host).

- **Pages** are `.md` files in a GitHub repo (the source of truth).
- **WYSIWYG editing** via **TipTap/ProseMirror** with a formatting toolbar — bold, italic,
  strike, code, H1–H3, lists, quote, code block, link, divider, **tables** (add/del row+col),
  undo/redo. Markdown is the stored format (tables round-trip to GFM).
- **Mermaid diagrams** render inline: insert from the toolbar (📊), edit the source with a
  **live preview**; read mode shows just the diagram. Stored as a fenced ```mermaid block.
- **File-explorer tree** (VSCode-style, resizable): create / rename / **drag-to-move** /
  delete pages and folders, inline — no path modal.
- **Drafts via git branches** — edit on a branch, **review the diff**, **publish** (opens a PR
  and merges it into base).
- **Version history** per page (commit log + per-version diff + one-click restore).
- **Comments** backed by **GitHub Issues** — page-level *and* **inline/anchored** (select text →
  💬), with threads you can **resolve/reopen**. Anchors are ProseMirror decorations that follow
  the text as you edit; commenting never makes a commit.
- **Dark mode** (persisted), **per-repo access** via a GitHub App, read-only browsing of public
  repos without installing.

The source of truth stays plain `.md` in a normal repo layout, so the repo remains
**MkDocs-compatible** — point MkDocs at it anytime for a published static site.

## How it works

```
[ static SPA on a CDN ]   bundled from web/ by esbuild → public/bundle.js
        │  repo comes from the URL:  ?repo=owner/name&branch=main
        ▼
   "Sign in with GitHub"  →  [ Supabase ] runs the OAuth handshake (the broker)
        ▼
   browser gets the user's GitHub token → talks DIRECTLY to api.github.com (Octokit)
```

A broker is required because GitHub's OAuth token exchange needs a client secret and
isn't CORS-enabled (even with PKCE), so a browser can't do it alone. **Supabase Auth**
handles it and hands the browser the GitHub token (`session.provider_token`); everything
else is browser-direct against `api.github.com` (which *is* CORS-enabled).

`web/github.js` is the GitHub layer (Octokit); `web/clientApi.js` is a thin API surface the
app calls; `web/main.js` is the app + editor + auth bootstrap; `web/anchors.js` holds the
pure anchoring helpers.

## Setup

You need a **Supabase project** and a **GitHub App** (one-time).

1. **GitHub App** (Settings → Developer settings → GitHub Apps → New):
   - **Repository permissions**: Contents R/W, Issues R/W, Pull requests R/W, Metadata R.
   - **Account permissions**: Email addresses → Read (Supabase needs it for the profile).
   - **Callback URL**: your Supabase auth callback (`https://<ref>.supabase.co/auth/v1/callback`).
   - Turn **off** "Expire user authorization tokens"; leave "Request user authorization during
     installation" **unchecked** (login and install are separate steps here).
2. **Supabase** → Authentication → Providers → **GitHub**: enable, paste the **GitHub App's**
   Client ID + Secret. Under URL Configuration, add your app URL to **Redirect URLs**
   (e.g. `https://you.github.io/gitwiki/**`).
3. **`public/config.js`**: set `supabaseUrl`, `supabaseAnonKey` (public, safe to commit), and
   `githubAppSlug` (the `github.com/apps/<slug>` name).

## Run & deploy

```bash
npm install
npm run dev      # esbuild's static server (no backend); open the printed localhost URL
                 # then visit  /?repo=owner/name
```

- `npm run build` bundles `web/` → `public/bundle.js`.
- **Deploy**: the included GitHub Actions workflow (`.github/workflows/deploy-pages.yml`)
  builds and publishes `public/` to **GitHub Pages** on every push to `main`
  (enable Pages → Source: GitHub Actions). Any static host works too — just upload `public/`.

## Access model

- **Per-repo, least-privilege**: users install the GitHub App on **only the repo they open**, so
  the token can't touch anything else.
- **Public repos** are browsable **read-only without installing** (a banner offers "Install to
  edit"); editing/commenting requires the install. Private repos require the install to view.
- Per-user **authorship** (commits/comments are the signed-in user) and per-user rate limits.

## How it maps to GitHub

| Wiki action | GitHub mechanism |
|---|---|
| List pages | Git Tree API (recursive), filtered to `*.md` |
| Open page | Contents API (decode base64) |
| Save edit | Contents API create/update on a branch (one commit) |
| New page / rename / move / delete | Contents API create/delete (move = copy + delete) |
| Version history / restore | `listCommits` for the file + Contents at a commit |
| New draft / review / publish | branch ref → compare diff → PR + merge |
| Comment thread | GitHub Issue titled `[wiki] <path>` |
| Inline comment / re-anchor | Issue comment with a hidden `<!-- gitwiki:{...} -->` marker (no commit) |

## Known limits

- WYSIWYG round-trips Markdown through ProseMirror, so **saving may reformat** it (normalized
  bullets, emphasis markers, etc.) — expect some cosmetic diff noise.
- Inline anchors match visible text within a block; selections spanning block boundaries may
  not re-locate. Live tracking covers in-app edits; out-of-band edits (on GitHub) fall back to
  fuzzy quote re-location on next load.
- No conflict UI beyond GitHub's `sha` optimistic-lock on save.
- The GitHub token lives in the browser (XSS exposure) — the GitHub App keeps it scoped to a
  single repo with minimal permissions.
- GitHub Apps allow per-repo access but can't *force* it — a user could pick "All repositories"
  at install time.

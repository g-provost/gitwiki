import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient } from "./lib/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  BASE_BRANCH = "main",
  PORT = 4000,
} = process.env;

// GitHub server mode is optional: with a token, the /api/* routes proxy GitHub.
// Without one, we just serve the static app, which can run in client OAuth mode.
const haveGitHub = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const gh = haveGitHub
  ? makeClient({ token: GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO, baseBranch: BASE_BRANCH })
  : null;
if (!haveGitHub) {
  console.warn("[gitwiki] No server GitHub token set — serving static only. Configure public/config.js (Supabase) for client OAuth mode.");
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Gate the server-side GitHub API on a configured token.
app.use("/api", (req, res, next) =>
  gh ? next() : res.status(503).json({ error: "Server GitHub mode disabled. Use client OAuth mode (set public/config.js)." })
);

// Small helper so every route reports errors as JSON instead of crashing.
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Server error" });
  });

app.get("/api/config", (req, res) =>
  res.json({ owner: GITHUB_OWNER, repo: GITHUB_REPO, baseBranch: BASE_BRANCH })
);

app.get("/api/me", wrap(async (req, res) => res.json(await gh.whoami())));

app.get("/api/branches", wrap(async (req, res) =>
  res.json(await gh.listBranches())
));

app.post("/api/branches", wrap(async (req, res) => {
  const { name, from } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(await gh.createBranch({ name, from }));
}));

app.get("/api/pages", wrap(async (req, res) =>
  res.json(await gh.listPages(req.query.branch))
));

app.get("/api/page", wrap(async (req, res) => {
  const { path: p, branch } = req.query;
  if (!p) return res.status(400).json({ error: "path required" });
  const page = await gh.getPage(p, branch);
  if (!page) return res.status(404).json({ error: "Page not found on this branch" });
  res.json(page);
}));

app.put("/api/page", wrap(async (req, res) => {
  const { path: p, content, branch, message, sha } = req.body;
  if (!p || branch == null) return res.status(400).json({ error: "path and branch required" });
  res.json(await gh.savePage({ path: p, content, branch, message, sha }));
}));

app.get("/api/history", wrap(async (req, res) => {
  const { path: p, branch } = req.query;
  if (!p) return res.status(400).json({ error: "path required" });
  res.json(await gh.pageHistory(p, branch));
}));

app.get("/api/drafts", wrap(async (req, res) =>
  res.json(await gh.listDrafts())
));

app.get("/api/diff", wrap(async (req, res) => {
  const { path: p, branch } = req.query;
  if (!p || !branch) return res.status(400).json({ error: "path and branch required" });
  res.json(await gh.diffPage(p, branch));
}));

app.delete("/api/page", wrap(async (req, res) => {
  const { path: p, branch, sha } = req.body;
  if (!p || !branch) return res.status(400).json({ error: "path and branch required" });
  res.json(await gh.deletePage({ path: p, branch, sha }));
}));

app.post("/api/move", wrap(async (req, res) => {
  const { from, to, branch } = req.body;
  if (!from || !to || !branch) return res.status(400).json({ error: "from, to, branch required" });
  res.json(await gh.movePage({ from, to, branch }));
}));

app.post("/api/publish", wrap(async (req, res) => {
  const { branch, title, body } = req.body;
  if (!branch) return res.status(400).json({ error: "branch required" });
  res.json(await gh.publishBranch({ branch, title, body }));
}));

app.get("/api/comments", wrap(async (req, res) => {
  const { path: p } = req.query;
  if (!p) return res.status(400).json({ error: "path required" });
  res.json(await gh.listComments(p));
}));

app.post("/api/comments", wrap(async (req, res) => {
  const { path: p, body } = req.body;
  if (!p || !body) return res.status(400).json({ error: "path and body required" });
  res.json(await gh.addComment(p, body));
}));

app.patch("/api/comments/:id", wrap(async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: "body required" });
  res.json(await gh.updateComment(req.params.id, body));
}));

app.listen(PORT, () =>
  console.log(`gitwiki POC running at http://localhost:${PORT}  (${haveGitHub ? `server mode: ${GITHUB_OWNER}/${GITHUB_REPO}` : "static only / client OAuth mode"})`)
);

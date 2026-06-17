// Thin wrapper around the GitHub REST API, running in the browser.
// Source of truth = Markdown files in a GitHub repo.
// - Pages   -> .md files (read via Contents API, listed via Git Tree API)
// - Drafts  -> git branches
// - Comments -> one GitHub Issue per page; comments on that issue = page discussion
import { Octokit } from "@octokit/rest";

const TITLE_PREFIX = "[wiki] "; // issue title convention that maps an issue to a page path

// UTF-8-safe base64 (browser). GitHub's contents API returns base64 with embedded
// newlines, so strip whitespace before decoding.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function makeClient({ token, owner, repo, baseBranch }) {
  const octokit = new Octokit({ auth: token });
  const ctx = { owner, repo };

  // --- Pages / tree -------------------------------------------------------
  async function listPages(branch = baseBranch) {
    // Resolve the branch tip, then walk its tree recursively for .md files.
    const ref = await octokit.git.getRef({ ...ctx, ref: `heads/${branch}` });
    const commitSha = ref.data.object.sha;
    const commit = await octokit.git.getCommit({ ...ctx, commit_sha: commitSha });
    const tree = await octokit.git.getTree({
      ...ctx,
      tree_sha: commit.data.tree.sha,
      recursive: "1",
    });
    return tree.data.tree
      .filter((n) => n.type === "blob" && /\.md$/i.test(n.path))
      .map((n) => ({ path: n.path, sha: n.sha }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async function getPage(path, branch = baseBranch) {
    try {
      const res = await octokit.repos.getContent({ ...ctx, path, ref: branch });
      const file = res.data;
      return {
        path,
        branch,
        sha: file.sha,
        content: b64decode(file.content),
      };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // Create or update a file on a branch. Pass the current sha when updating.
  async function savePage({ path, content, branch, message, sha }) {
    const res = await octokit.repos.createOrUpdateFileContents({
      ...ctx,
      path,
      branch,
      message: message || `Update ${path}`,
      content: b64encode(content),
      ...(sha ? { sha } : {}),
    });
    return { commit: res.data.commit.sha, sha: res.data.content.sha };
  }

  // Commit history for a single page on a branch (newest first).
  async function pageHistory(path, branch = baseBranch) {
    const res = await octokit.repos.listCommits({ ...ctx, path, sha: branch, per_page: 50 });
    return res.data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name || c.author?.login || "?",
      avatar: c.author?.avatar_url,
      date: c.commit.author?.date,
      url: c.html_url,
      parent: c.parents?.[0]?.sha || null,
    }));
  }

  // Delete a file on a branch (looks up its sha if not provided).
  async function deletePage({ path, branch, message, sha }) {
    if (!sha) {
      const cur = await getPage(path, branch);
      if (!cur) return { deleted: false };
      sha = cur.sha;
    }
    await octokit.repos.deleteFile({ ...ctx, path, branch, message: message || `Delete ${path}`, sha });
    return { deleted: true };
  }

  // Move/rename a page: copy content to the new path, then delete the old.
  // (GitHub has no native rename; this is two commits on the same branch.)
  async function movePage({ from, to, branch, message }) {
    const src = await getPage(from, branch);
    if (!src) { const err = new Error("Source page not found"); err.status = 404; throw err; }
    const dest = await getPage(to, branch);
    if (dest) { const err = new Error(`A page already exists at ${to}`); err.status = 409; throw err; }
    await savePage({ path: to, content: src.content, branch, message: message || `Move ${from} -> ${to}` });
    await deletePage({ path: from, branch, sha: src.sha, message: message || `Move ${from} -> ${to}` });
    return { from, to };
  }

  // --- Branches (drafts) --------------------------------------------------
  async function listBranches() {
    const res = await octokit.repos.listBranches({ ...ctx, per_page: 100 });
    return res.data.map((b) => ({ name: b.name, protected: b.protected }));
  }

  async function createBranch({ name, from = baseBranch }) {
    const ref = await octokit.git.getRef({ ...ctx, ref: `heads/${from}` });
    await octokit.git.createRef({
      ...ctx,
      ref: `refs/heads/${name}`,
      sha: ref.data.object.sha,
    });
    return { name, from };
  }

  // List branches that are *ahead* of base — i.e. actual drafts with changes —
  // along with ahead/behind counts and the Markdown files each one touches.
  async function listDrafts() {
    const branches = await listBranches();
    const drafts = [];
    for (const b of branches) {
      if (b.name === baseBranch) continue;
      try {
        const cmp = await octokit.repos.compareCommitsWithBasehead({
          ...ctx,
          basehead: `${baseBranch}...${b.name}`,
        });
        if (cmp.data.ahead_by === 0) continue; // nothing new on this branch
        const files = (cmp.data.files || [])
          .filter((f) => /\.md$/i.test(f.filename))
          .map((f) => ({
            filename: f.filename,
            status: f.status, // added | modified | removed | renamed
            additions: f.additions,
            deletions: f.deletions,
          }));
        drafts.push({
          name: b.name,
          ahead: cmp.data.ahead_by,
          behind: cmp.data.behind_by,
          files,
        });
      } catch {
        // Branch may be unrelated history / comparison may fail — skip it.
      }
    }
    return drafts;
  }

  // Return base vs head content for one page so the client can render a diff.
  // Either side is null when the file was added (no base) or removed (no head).
  async function diffPage(path, branch) {
    const [base, head] = await Promise.all([
      getPage(path, baseBranch),
      getPage(path, branch),
    ]);
    return {
      path,
      base: base ? base.content : null,
      head: head ? head.content : null,
    };
  }

  // Find an existing open PR for a draft branch, or open one.
  async function findOrCreatePR({ branch, title, body }) {
    const open = await octokit.pulls.list({
      ...ctx,
      head: `${owner}:${branch}`,
      base: baseBranch,
      state: "open",
    });
    if (open.data.length) return open.data[0];
    const created = await octokit.pulls.create({
      ...ctx,
      head: branch,
      base: baseBranch,
      title: title || `Publish: ${branch}`,
      body: body || "Opened from gitwiki POC.",
    });
    return created.data;
  }

  // "Publish" = ensure a PR exists for the draft, then merge it into base.
  // Returns { merged, number, url } or, when the merge can't proceed
  // (conflicts / required checks), { merged:false, number, url, reason }.
  async function publishBranch({ branch, title, body, mergeMethod = "squash" }) {
    const pr = await findOrCreatePR({ branch, title, body });
    try {
      const merge = await octokit.pulls.merge({
        ...ctx,
        pull_number: pr.number,
        merge_method: mergeMethod,
        commit_title: `Publish ${branch} (#${pr.number})`,
      });
      return { merged: merge.data.merged, number: pr.number, url: pr.html_url, sha: merge.data.sha };
    } catch (err) {
      // 405 = not mergeable (conflicts), 409 = head moved. Surface gracefully.
      if (err.status === 405 || err.status === 409) {
        return {
          merged: false,
          number: pr.number,
          url: pr.html_url,
          reason: err.response?.data?.message || "Branch is not mergeable — resolve conflicts on GitHub.",
        };
      }
      throw err;
    }
  }

  // --- Comments (GitHub Issues) ------------------------------------------
  // Each wiki page maps to a GitHub Issue titled `[wiki] <path>`. New issues get
  // a `wiki-page` label (handy for humans filtering on GitHub), but lookup is by
  // *title across all issues* — labeled or not — so older threads are never lost.
  // listForRepo is immediately consistent (no Search-index lag).
  const PAGE_LABEL = "wiki-page";

  // Every issue whose title matches this page, oldest first. Usually one, but if
  // history left duplicates (e.g. a thread created before the lookup changed), we
  // return them all so no comments get stranded.
  async function findPageIssues(path) {
    const title = `${TITLE_PREFIX}${path}`;
    const issues = await octokit.paginate(octokit.issues.listForRepo, {
      ...ctx,
      state: "all",
      per_page: 100,
    });
    return issues
      .filter((i) => i.title === title && !i.pull_request) // exclude PRs
      .sort((a, b) => a.number - b.number);
  }

  // The canonical thread for a page = the oldest matching issue.
  async function ensurePageIssue(path) {
    const existing = await findPageIssues(path);
    if (existing.length) return existing[0];
    const res = await octokit.issues.create({
      ...ctx,
      title: `${TITLE_PREFIX}${path}`,
      labels: [PAGE_LABEL],
      body: `Discussion thread for wiki page \`${path}\`.\n\n_Auto-created by gitwiki._`,
    });
    return res.data;
  }

  const mapComment = (c) => ({
    id: c.id,
    author: c.user?.login,
    avatar: c.user?.avatar_url,
    body: c.body,
    createdAt: c.created_at,
    url: c.html_url,
  });

  // Aggregate comments from every matching issue, oldest first — so even split
  // threads display as one continuous conversation.
  async function listComments(path) {
    const issues = await findPageIssues(path);
    if (!issues.length) return { issue: null, comments: [] };
    const perIssue = await Promise.all(
      issues.map((i) =>
        octokit.paginate(octokit.issues.listComments, {
          ...ctx,
          issue_number: i.number,
          per_page: 100,
        })
      )
    );
    const comments = perIssue
      .flat()
      .map(mapComment)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const canonical = issues[0];
    return {
      issue: { number: canonical.number, url: canonical.html_url },
      comments,
    };
  }

  async function addComment(path, body) {
    const issue = await ensurePageIssue(path); // posts to the canonical (oldest) thread
    const res = await octokit.issues.createComment({
      ...ctx,
      issue_number: issue.number,
      body,
    });
    return mapComment(res.data);
  }

  // Edit an existing comment's body. Used to persist updated anchor geometry on
  // Save (the anchor metadata lives in a hidden marker inside the comment body),
  // so re-anchoring costs an API write, never a commit.
  async function updateComment(commentId, body) {
    const res = await octokit.issues.updateComment({
      ...ctx,
      comment_id: Number(commentId),
      body,
    });
    return mapComment(res.data);
  }

  async function whoami() {
    const res = await octokit.users.getAuthenticated();
    return { login: res.data.login, name: res.data.name };
  }

  return {
    listPages,
    getPage,
    savePage,
    deletePage,
    movePage,
    pageHistory,
    listBranches,
    createBranch,
    listDrafts,
    diffPage,
    publishBranch,
    listComments,
    addComment,
    updateComment,
    whoami,
  };
}

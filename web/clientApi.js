// Client-side replacement for the Express /api/* layer. It exposes the SAME
// get()/send() interface the app already uses, but dispatches to a browser
// Octokit client instead of a server — so main.js needs no per-call changes.
import { makeClient } from "../lib/github.js";

export function makeClientApi({ token, owner, repo, baseBranch }) {
  const client = makeClient({ token, owner, repo, baseBranch });
  const cfg = { owner, repo, baseBranch };
  const parse = (url) => {
    const u = new URL(url, "http://x");
    return { path: u.pathname, q: Object.fromEntries(u.searchParams) };
  };
  const notFound = (msg) => { const e = new Error(msg); e.status = 404; throw e; };

  async function get(url) {
    const { path, q } = parse(url);
    switch (path) {
      case "/api/config": return { ...cfg };
      case "/api/me": return await client.whoami();
      case "/api/branches": return await client.listBranches();
      case "/api/pages": return await client.listPages(q.branch);
      case "/api/page": {
        const p = await client.getPage(q.path, q.branch);
        return p || notFound("Page not found on this branch");
      }
      case "/api/history": return await client.pageHistory(q.path, q.branch);
      case "/api/drafts": return await client.listDrafts();
      case "/api/diff": return await client.diffPage(q.path, q.branch);
      case "/api/comments": return await client.listComments(q.path);
      default: throw new Error("Unknown GET " + path);
    }
  }

  async function send(method, url, body = {}) {
    const { path } = parse(url);
    if (method === "POST" && path === "/api/branches") return client.createBranch({ name: body.name, from: body.from });
    if (method === "PUT" && path === "/api/page") return client.savePage(body);
    if (method === "DELETE" && path === "/api/page") return client.deletePage(body);
    if (method === "POST" && path === "/api/move") return client.movePage(body);
    if (method === "POST" && path === "/api/publish") return client.publishBranch(body);
    if (method === "POST" && path === "/api/comments") return client.addComment(body.path, body.body);
    if (method === "PATCH" && path.startsWith("/api/comments/")) return client.updateComment(path.split("/").pop(), body.body);
    throw new Error("Unknown " + method + " " + path);
  }

  return { get, send };
}

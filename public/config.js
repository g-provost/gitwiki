// gitwiki client config (loaded before the bundle; safe to commit).
//
// gitwiki is fully static: every user signs in with their own GitHub account via
// Supabase, and all GitHub calls happen in the browser. supabaseUrl + supabaseAnonKey
// are REQUIRED. The anon key is public by design - it is safe to expose here.
//
// Setup:
//   1. Create a Supabase project (free).
//   2. Supabase > Authentication > Providers > GitHub: enable it and paste your
//      GitHub App's Client ID/Secret. Set the App's callback to the Supabase auth
//      callback URL shown there, and give the App: Email addresses (account, read)
//      + Contents/Issues/Pull requests (repository, read & write).
//   3. Put the project URL + anon key below, and the App slug in githubAppSlug.
//   4. Open with a repo in the URL, e.g.  ?repo=owner/name&branch=main
window.GITWIKI_CONFIG = {
  supabaseUrl: "https://ussogahthabugtowzbjl.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzc29nYWh0aGFidWd0b3d6YmpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNTUzNjAsImV4cCI6MjA5NjgzMTM2MH0.QfoBxwX5V32EkOMs91HEkY_62lo3pnckfRajDnS2bb0",

  // Optional: set this to your GitHub *App* slug (the name in its URL,
  // github.com/apps/<slug>) to enable per-repository access. When set, gitwiki
  // shows an "Install on this repository" gate so the token is limited to the
  // single repo the user picks. Leave empty to use the OAuth App (all-repos) flow.
  // For App mode: in Supabase use the GitHub App's Client ID/Secret, and in the
  // App settings turn OFF "Expire user authorization tokens".
  githubAppSlug: "gitwiki-authentication",
};

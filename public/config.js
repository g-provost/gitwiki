// gitwiki client config (loaded before the bundle; safe to commit).
//
// Leave BOTH empty to run in legacy SERVER mode (the Express server uses the
// GITHUB_TOKEN from .env). Fill them in to enable CLIENT mode: a fully static
// app where each user signs in with their own GitHub account via Supabase, and
// all GitHub calls happen in the browser. The Supabase anon key is public by
// design ??? it is safe to expose here.
//
// Setup for client mode:
//   1. Create a Supabase project (free).
//   2. In Supabase: Authentication > Providers > GitHub, enable it and paste a
//      GitHub OAuth App's Client ID/Secret. Set the GitHub OAuth App callback to
//      your Supabase auth callback URL (shown in that screen).
//   3. Put the project URL + anon key below.
//   4. Open the app with a repo in the URL, e.g.  ?repo=owner/name&branch=main
window.GITWIKI_CONFIG = {
  supabaseUrl: "https://ussogahthabugtowzbjl.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzc29nYWh0aGFidWd0b3d6YmpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNTUzNjAsImV4cCI6MjA5NjgzMTM2MH0.QfoBxwX5V32EkOMs91HEkY_62lo3pnckfRajDnS2bb0"
};

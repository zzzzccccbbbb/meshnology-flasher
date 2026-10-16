# Cloudflare Pages Deployment Notes

> Hard-won lessons from wiring up `zzzzccccbbbb/meshnology-flasher`
> to Cloudflare Pages during the v0.3 work. Mostly cautionary tales.

## TL;DR

- **GitHub repo name != CF Pages project name**. The Pages project
  is named whatever you type into the "Project name" box when you
  click "Create application". The default URL is
  `<projectname>.pages.dev` — not the GitHub repo name. If you
  want them aligned, the project name must be exactly
  `meshnology-flasher` (no dash, no `nology`-deletion, no abbreviation).
- **Push to `main` does not auto-deploy** if you created the Pages
  project via the "Direct Upload" route. It does auto-deploy if
  you used "Connect to Git". The current setup uses the latter.
- **`[build]` is not allowed in `wrangler.toml` for Pages projects**.
  Pages reads `name`, `compatibility_date`, `pages_build_output_dir`,
  and the bindings (R2, KV, etc.). Build command, build directory,
  root directory, environment variables — those live in the
  Dashboard's "Builds & deployments" panel, not in `wrangler.toml`.
- **The first build triggered by CF's project creation can hang
  in "Build in progress" indefinitely if the wrangler.toml references
  an R2 binding whose bucket does not exist.** Hit "Cancel build" and
  trigger a new one with a fixed wrangler.toml.
- **Cloudflare Pages auto-deploys on push once the project is set up**,
  so the `git push` you do for v0.2 → v0.3 transitions does trigger
  CF to pull, build, and deploy. The failure modes above are about
  the **first** project creation, not subsequent pushes.

## Recommended project creation flow

1. **Cloudflare Dashboard → Workers & Pages → Create application →
   Pages → Connect to Git**.
2. Pick the GitHub account and the `zzzzccccbbbb/meshnology-flasher`
   repository. **Important**: if a previous Pages project is already
   bound to this repo (e.g. one named `mesh-flasher` created during
   initial experimentation), GitHub will not let you connect the same
   repo twice. Either:
   - delete the previous project first (Dashboard → project →
     Settings → Delete), or
   - use a different repo, or
   - accept that the second project is a sibling (both will run
     the same code, on different `<projectname>.pages.dev` URLs).
3. **Project name**: `meshnology-flasher` (or whatever URL slug you
   want — the project name is permanent, the URL is forever).
4. **Build settings**:
   - Framework preset: **Vite**
   - Build command: **`npm run build`**
   - Build output directory: **`dist`**
   - Root directory: **`/`** (default)
5. **Save and Deploy**. Watch the build log.
6. After the first successful deploy, browse to
   `https://meshnology-flasher.pages.dev/`. You should see the
   current `main` branch.
7. (Optional) **Custom domains → Set up a custom domain**. If you
   have `flasher.mesh.com` available, point it at the project; CF
   adds a CNAME for you.

## If the first build hangs

A `wrangler.toml` that references an R2 binding whose bucket does
not exist will cause CF's build to fail. The error in the build log
looks like:

```
Error: Failed to publish your Function. Got error: R2 bucket
  'your-bucket-name' not found.
```

If you see this:

1. **Cancel build** (button on the deployment detail page).
2. Either create the R2 bucket, or remove the `[[r2_buckets]]`
   block from `wrangler.toml`.
3. Trigger a new build from the Deployments tab.

## Custom domain `flasher.mesh.com`

To bind `flasher.mesh.com`:

- If `mesh.com` is **already on Cloudflare** (as registrar or
  transferred): Dashboard → Pages → `meshnology-flasher` →
  Custom domains → Set up a custom domain → `flasher.mesh.com`.
  CF adds a CNAME automatically.
- If `mesh.com` is on **another registrar**: either transfer it to
  Cloudflare (free), or add the CNAME manually at the existing
  registrar:
  ```
  flasher.mesh.com  CNAME  meshnology-flasher.pages.dev
  ```

DNS propagation is up to 48 h but usually under 5 min.

## Common mistakes

- **Wrong `dist` location**: Dashboard Build output directory must
  match what Vite actually writes. Default is `dist/`, which matches
  our `vite.config.ts` (`outDir: 'dist'`).
- **Missing `npm install` step**: CF Pages auto-runs `npm ci` (or
  `npm install`) before your `build` command. Don't add an explicit
  `npm install` to your build command — it slows down the build.
- **Setting build output dir to `build/`** (CRA default): will
  produce a build but Pages won't find the output. Always `dist/`
  for Vite.
- **Production vs Preview**: Pages has two deploy tracks.
  Production = the latest build from the "production branch"
  (default: `main`). Preview = any other branch or any manually
  triggered build. Only Production deploys to your default
  `<projectname>.pages.dev` URL. Preview deploys get unique
  URLs like `<hash>.meshnology-flasher.pages.dev`. To make a build
  the Production one, go to its row in Deployments and click
  "Promote to production".

## Why this doc exists

The v0.3 deployment hit two non-obvious issues:

1. The first project created was named `mesh-flasher` (no "nology"),
   which produced the URL `mesh-flasher.pages.dev` — fine, but
   visually disconnected from the GitHub repo
   `zzzzccccbbbb/meshnology-flasher`. This is fine in itself but
   confusing for users who try `meshnology-flasher.pages.dev` first
   and get a DNS error.
2. The replacement `meshnology-flasher` project was created, but
   the very first build was triggered with a stale `wrangler.toml`
   referencing an R2 binding whose bucket did not exist. That build
   hung in "Build in progress" for several minutes before being
   manually cancelled. Once the wrangler.toml was committed
   without the R2 block, subsequent deploys succeeded.

Future-you (or future-boss) reading this: the deploy is simple
once you know the right Settings, but the Dashboard's failure
modes are not always obvious. If something hangs, check
"Deployments" → click the hanging row → look for "Cancel build".

Refs:
- [Cloudflare Pages docs](https://developers.cloudflare.com/pages)
- [Wrangler Pages config](https://developers.cloudflare.com/pages/functions/wrangler-configuration)
- `docs/v0.3-plan.md` (the original plan that produced these notes)

# Deployment

GitHub Pages is the production host. Every push to `main` runs
`.github/workflows/deploy-pages.yml`, validates the repository, builds `dist/`, uploads
the Pages artifact, and creates a protected `github-pages` deployment.

## Repository configuration

In GitHub:

1. Open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Keep the `github-pages` environment protection rules enabled if approvals are
   required.

No deployment secret is required. The workflow receives short-lived Pages and OIDC
permissions only in the deployment job.

## Release procedure

1. Merge a reviewed pull request into `main`.
2. Confirm the **CI** workflow succeeds.
3. Confirm the **Deploy GitHub Pages** workflow succeeds.
4. Open the deployment URL and test both products. Confirm the sidebar reads in product,
   mode, results, and selected-item order; each circumference result card focuses its
   city without hiding either network; map clicks work in either city; and moving the
   heatmap to a supported metro activates its local results without recentering.

The Vite `base` is relative, so the same artifact works at the project Pages path and in
local preview.

## Manual validation

Before merging:

```sh
npm ci
npm run check
npm run preview
```

`npm run check` creates the same `dist/` directory uploaded by the deployment workflow.

## Rollback

Revert the faulty commit on `main` through a pull request. The resulting push builds and
deploys the prior source state as a new Pages deployment. GitHub also retains deployment
history in **Actions → Deploy GitHub Pages** for diagnosis.

Do not manually edit generated files in `dist/`; the directory is ignored and replaced
on every build.

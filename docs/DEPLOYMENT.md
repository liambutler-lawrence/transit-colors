# Deployment

Vercel is the production host for
[`maps.liambutlerlawrence.com`](https://maps.liambutlerlawrence.com). GitHub Actions is
the sole deployment path. Pull requests run the same checks and create the same static
artifact, but only a push to `main` or an intentional manual run from `main` can deploy.
Automatic Vercel Git deployments remain disabled.

## Artifact boundary

`npm run check` performs formatting, lint, strict type, test, build, and artifact
checks. The Vite build copies only the reviewed browser-facing files in
`RUNTIME_DATA_FILES`. Raw CDMX GeoJSON, derived scoring tables, GTFS downloads, Overpass
responses, and OSM highway caches never enter `dist/`.

The map archive is too large for the reference landing page's inline deployment payload.
`scripts/deploy.mjs` therefore hashes each checked artifact file, uploads it through
Vercel's file API, and creates a prebuilt Build Output v3 deployment using those exact
digests. The script never rebuilds inside the deploy job.

## Repository configuration

The repository requires three project-specific encrypted Actions secrets:

- `VERCEL_TOKEN`: a time-limited Vercel token restricted to the Transit Colors project;
- `VERCEL_ORG_ID`: the ID of the Vercel account or team that owns the project; and
- `VERCEL_PROJECT_ID`: the Transit Colors project ID.

Do not reuse a token from another site. The deployment script verifies its repository,
branch, event, project, and team before uploading anything. It refuses local execution,
pull-request deployment, and deployment from another repository or branch.

The Vercel project must have `maps.liambutlerlawrence.com` assigned as a production
domain. At the external DNS provider, `maps` must be a CNAME to the exact
project-specific target Vercel reports after domain assignment. Do not substitute a
generic target when Vercel provides a tailored one.

## Release procedure

1. Merge a reviewed pull request into `main`.
2. Confirm the **Deploy to Vercel / check** job succeeds.
3. Confirm the deploy job uploads the checked artifact and reaches `READY`.
4. Open the custom domain and verify HTTPS, PMTiles range requests, and all deep links:
   Transit access, travel time, Circumference Lab, Clock Skew, and Jersey City Land Use.

No production deployment should run from a developer's computer.

## Manual validation

Before merging:

```sh
npm ci
npm run check
npm run preview
```

`npm run check` creates and verifies the same `dist/` directory saved by GitHub Actions.

## Rollback

Revert the faulty commit on `main` through a pull request. The resulting Actions run
builds, checks, and deploys the prior source state as a new immutable Vercel deployment.
Vercel retains deployment history for emergency rollback, but routine releases must
remain traceable to a checked `main` commit.

Do not manually edit generated files in `dist/`; the directory is ignored and replaced
on every build.

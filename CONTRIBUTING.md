# Contributing

Thank you for helping improve Transit Colors.

## Before starting

- Search existing issues and pull requests.
- Open an issue before a large data-model, algorithm, or user-interface change.
- Keep pull requests focused; separate dependency or data refreshes from behavior
  changes when practical.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```sh
git clone https://github.com/liambutler-lawrence/transit-colors.git
cd transit-colors
nvm use
npm ci
npm run dev
```

See [Development](docs/DEVELOPMENT.md) and [Architecture](docs/ARCHITECTURE.md) before
changing core routing, boundary schemas, or data builders.

## Pull requests

1. Create a branch from the latest `main`.
2. Add or update tests for behavior changes.
3. Update documentation when commands, architecture, data, or deployment changes.
4. Run `npm run check`.
5. Complete the pull-request template and describe any data-source or licensing impact.

Pull requests must not introduce TypeScript assertions, unvalidated external data, files
longer than 1,000 lines, committed caches, or unrelated generated changes.

## Commits

Use clear, imperative commit subjects such as `Validate map feature properties`. Keep
format-only work separate when it would obscure a behavioral review.

## Data contributions

Include the authoritative source URL, retrieval date, license or terms, geographic
scope, and rebuild command. Explain material count changes and preserve attribution. Do
not include personal data or private feeds.

## Reporting security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

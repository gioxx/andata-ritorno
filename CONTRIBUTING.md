# Contributing to A/R

Thanks for your interest in contributing. This document covers how to get set up, how to propose a change and the rules every contribution follows.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ideas, problems and questions

- **Bugs:** open an issue with the *Bug report* template.
- **Feature ideas:** open an issue with the *Feature request* template.
- **Not on GitHub?** Write to [hello@ar.gioxx.org](mailto:hello@ar.gioxx.org), in Italian or English.
- **Security vulnerabilities:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

```bash
cd app && npm install && npm run dev       # the app, on its own (no server needed)
cd worker && npm install && npm test       # the Worker and its tests
```

The README covers the Worker, D1, R2 and the secrets needed to run family sharing yourself.

## Branch and pull request workflow

1. Fork the repository and create a topic branch off `main` (for example `fix/import-duplicates`).
2. Keep commits focused: one logical change per pull request.
3. Open a pull request against `main` and fill in the template, including the DCO sign-off.
4. Address review feedback by pushing new commits to the same branch.
5. The maintainer merges; squash is the default.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/). Every commit carries a `Signed-off-by` trailer stating that you have the right to contribute the code under the project's license (AGPL v3):

```bash
git commit -s -m "Fix duplicate items on import"
```

Forgot the flag? `git rebase --signoff main` re-signs your commits.

## Rules

- **Privacy first.** The free app never talks to a server. Family data leaves the phone only encrypted. No analytics, trackers or third-party scripts.
- **Both languages.** Every user-facing string goes in `app/src/i18n/it.js` and `app/src/i18n/en.js`.
- **SQL** is always parameterized.
- **Secrets** are never committed (`worker/.dev.vars` is ignored).
- **Personal data** never ends up in logs, tests or fixtures.
- **Accessibility:** keyboard reachable, labelled controls, 44 px touch targets, enough contrast in light and dark themes.

## Tests

Run both suites before opening a pull request:

```bash
npm --prefix app test
npm --prefix worker test
npm --prefix app run build
```

New behavior comes with tests. Worker changes that cross the database are tested against D1 (the test setup applies `worker/schema.sql`), not mocks.

## Commit messages

English, concise, imperative mood. One short subject line; a body only when the *why* is not obvious. Reference issues by number when there is one.

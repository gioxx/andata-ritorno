# Governance

A/R (Andata e Ritorno) is an open-source project with a single maintainer, listed in [MAINTAINERS.md](MAINTAINERS.md). This document describes how decisions are made and how the project is released.

## Decisions

The maintainer reviews and merges pull requests, triages issues, cuts releases and sets the direction of the project. Discussion happens in public issues and pull requests, and decisions are recorded there.

## Proposing changes

1. **Small change or bug fix:** open a pull request directly, referencing the issue if there is one.
2. **Larger feature:** open an issue first, describing the problem, the proposal and the alternatives considered. Once the direction is agreed, send the pull request.

Contribution mechanics are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

- Versioning follows [Semantic Versioning](https://semver.org/); the version lives in `app/package.json`.
- Releases are cut from `main`. There is no fixed cadence.
- The hosted service at [app.ar.gioxx.org](https://app.ar.gioxx.org) runs the latest `main`.

## The hosted service and commercial use

A/R is licensed under the GNU AGPL v3 (see [LICENSE](LICENSE)). Anyone may self-host it, modify it and run it, including commercially, as long as the AGPL is respected: if you run a modified version as a network service, its source must be available to its users.

The maintainer runs a hosted instance whose optional family sharing is paid. The payment covers the cost of running that instance; it is not a condition for using the software, and self-hosted instances owe nothing to the project.

Use of the **A/R** and **Andata e Ritorno** names and logo is governed separately by [TRADEMARK.md](TRADEMARK.md). The AGPL does not grant trademark rights.

## Changes to this document

Changes to this document, the licensing model or the trademark policy are made through a pull request with a clear description of the motivation.

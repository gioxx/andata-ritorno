# Security Policy

A/R stores families' encrypted wardrobes, handles purchase codes and talks to Stripe and Resend. Security reports are taken seriously.

## Supported versions

Only the latest version on `main`, which is what runs at [app.ar.gioxx.org](https://app.ar.gioxx.org), is supported. There are no long-term branches.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting: on the repository page open **Security → Report a vulnerability**. If that is not available, write to [hello@ar.gioxx.org](mailto:hello@ar.gioxx.org) and ask for a private channel; do not include vulnerability details in that first message.

Include:

- A description of the issue and the impact you observed.
- Steps to reproduce, or a minimal proof of concept.
- The affected commit, or the date you saw it on the hosted service.
- Your assessment of severity, if you have one.

## What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | within **72 hours** |
| Initial assessment | within **7 days** |
| Fix for critical issues | within **30 days** of confirmation |
| Public disclosure | after a fix is deployed, or by mutual agreement |

If the report turns out not to be a security issue, you get an explanation and, where useful, a pointer to the regular issue tracker. Reporters are credited unless they prefer to stay anonymous.

## Scope

In scope:

- The app (`app/`): local storage, backups, the end-to-end encryption of family data and recovery kits.
- The Worker and API (`worker/`): family, device and invite handling, sync, photos, purchase codes, licence recovery, the Stripe webhook and the admin endpoints.
- The landing site (`landing/`) and the security headers of both sites.

Out of scope:

- Attacks that need physical access to an unlocked phone that is already in a family.
- Self-XSS that requires the victim to paste attacker-controlled content into the browser's developer tools.
- Volumetric denial of service against the hosted service.
- Vulnerabilities in third-party dependencies already tracked publicly and waiting for an upstream fix (still welcome, handled as dependency updates), and findings limited to development-only dependencies.

## Safe harbor

Good-faith research that follows this policy will not be pursued legally. Please:

- Test only with families and codes you own: use a self-hosted instance or a family you created, never other people's data.
- Avoid degrading the service for other users.
- Give reasonable time to fix the issue before disclosing it.

# Contributing to BeamDesk

Thanks for helping! Bug reports, translations, docs and code are all welcome.

1. **Discuss bigger changes first** in an issue, so we can agree on the approach.
2. Fork, create a branch, and follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) to get running.
3. Keep changes focused; match the surrounding code style (2 spaces, single quotes, small functions, comments that explain *why*).
4. Run `npm run check` and, for anything touching connections, `npm run test:e2e`.
5. Open a pull request describing what changed and how you tested it.

Principles we care about:

- **Simple for non-technical people.** Fewer steps, plain words, safe defaults.
- **Private by default.** Nothing leaves the device unless it must; no telemetry.
- **Fast.** Measure before and after when touching the media or input path.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

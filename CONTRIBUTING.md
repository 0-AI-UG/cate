# Contributing to Cate

Thanks for your interest in contributing! This guide explains how we work so that your time is well spent and nobody is surprised by the outcome.

Please read the [Contribution Workflow](#contribution-workflow) before writing code. The short version: **talk to us before you build anything non-trivial.** It saves everyone the frustration of a finished PR getting turned down.

## Contribution Workflow

Cate is an opinionated product with a specific direction. To keep that direction coherent, we ask that you follow these steps.

### 1. Open an issue first

For anything beyond a trivial fix, **start with an issue**, not a pull request. Describe:

- The problem you want to solve, or the feature you want to add
- Why it belongs in Cate (the use case, not just the mechanism)
- Roughly how you imagine it working

This lets us agree on the *what* and the *shape* before you spend hours on the *how*.

You can skip the issue for trivial changes: typos, broken links, obvious one-line bug fixes, doc tweaks. When in doubt, open an issue anyway. It is faster than a rejected PR.

### 2. Say if you want to build it yourself

In the issue, tell us if you'd like to implement it. If you do:

- A maintainer will respond with a "go ahead", a "let's adjust the approach first", or a "this isn't a direction we want to take".
- Once a maintainer gives you the go ahead and assigns the issue to you, **it's yours**. You own the implementation and can open a PR when it's ready.
- If you don't want to build it, that's completely fine. File the issue anyway so it's on the radar.

Please wait for the go ahead before starting on larger work. An assigned issue is your signal that a PR will be seriously reviewed and is wanted.

### 3. Open the pull request

Once the issue is approved and assigned to you, build it and open a PR. Link the PR back to the issue (`Closes #123`).

### Why we work this way

We would rather say "not yet" in a one paragraph issue than decline a polished PR you spent a weekend on. The issue-first flow is there to protect your effort, not to gate-keep it. A rejected idea at the issue stage costs you a few minutes; a rejected PR costs you real work. If something still gets declined after discussion, it's about fit and direction, never about the quality of your work.

## Development Setup

1. Fork and clone the repo
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev`

### Prerequisites

- Node.js >= 18
- npm >= 9
- Python 3 + C++ compiler (for `node-pty` native module)

## Making Changes

1. Create a branch from `main`:
   ```bash
   git checkout -b my-feature
   ```
2. Make your changes
3. Run the checks before you push:
   ```bash
   npm run typecheck
   npm run test:unit
   npm run build
   npm run typecheck
   npm run lint
   ```
4. Commit with a clear message following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add panel snapping to grid
   fix: terminal resize not updating PTY dimensions
   ```

## Pull Requests

- **One feature or fix per PR.** Keep it focused and reviewable. If a change is large, split it or check in with us about how to stage it.
- **Link the issue** the PR resolves (`Closes #123`).
- **Describe what changed and why.** The "why" matters more than the "what".
- **Include screenshots or a short clip for any UI change.**
- **Make sure `npm run typecheck`, `npm run test:unit`, `npm run build`, and `npm run lint` all pass.**
- **Add or update tests** when you change behavior.
- **Don't bundle unrelated changes.** No drive-by reformatting, dependency bumps, or refactors mixed into a feature PR.
- Expect review feedback. A few rounds of back and forth is normal and is not a sign anything is wrong.

### What happens after you open a PR

- A maintainer will review it. We try to be timely, but this is a small team, so please be patient.
- We may ask for changes, suggest a different approach, or, occasionally, decide it isn't the right fit even after an approved issue (for example if the implementation reveals a problem we didn't foresee). If that happens we will explain why.
- Once it's approved and green, a maintainer will merge it. We generally squash merge.

## Project Structure

See the [Architecture section](README.md#architecture) in the README and [`CLAUDE.md`](CLAUDE.md) for detailed guidance on the codebase.

## Code Style

- TypeScript with strict mode
- Functional React with hooks
- Zustand for state (no Redux/Context)
- Tailwind CSS for styling
- Match the style of the surrounding code
- No unnecessary abstractions, keep it simple

## Reporting Bugs

Open an [issue](https://github.com/0-AI-UG/cate/issues) with:

- Steps to reproduce
- Expected vs actual behavior
- OS and version
- Screenshots if applicable

A bug report does not need the propose-first flow above. Just file it.

## Questions

If you're unsure whether something fits, or how to approach it, open an issue and ask before writing code. Asking early is always welcome.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

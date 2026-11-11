# Contributing to LAN Collaborative Whiteboard

Welcome! This repository hosts our **CS3004 — Computer Networks Practice** course project: a LAN-based, multi-user, real-time collaborative whiteboard built with raw TCP socket programming (Node.js `net` module), Electron, React, and TypeScript.

To ensure consistency, code quality, and smooth team collaboration, please adhere to the following workflow and engineering guidelines.

---

## 1. Git & Branching Strategy

### Default Branch

The primary and default branch is **`main`**.
Run this once to ensure your local git environment defaults to `main`:

```bash
git config --global init.defaultBranch main
# or locally in this repo:
git config init.defaultBranch main
```

### Branch Rules

- **`main` is protected in spirit**: It must always build, pass tests, and run cleanly across all supported platforms (Windows, Linux, macOS). Never commit broken code to `main`.
- **Phases 0–3**: Foundational setup phases committed directly to `main` only after explicit phase approval.
- **Phases 4+**: Every phase and major feature must be developed on its own dedicated branch:
  - Branch naming format: `feature/<NN>-<name>` (e.g. `feature/04-drawing-sync`, `feature/05-eraser-clear`).
  - Always branch off the latest `main`:
    ```bash
    git checkout main
    git pull origin main
    git checkout -b feature/<NN>-<name>
    ```
- **Never force-push to `main` (`git push --force`)**.
- Keep feature branches updated by rebasing against `main`:
  ```bash
  git checkout feature/<NN>-<name>
  git fetch origin
  git rebase origin/main
  ```

---

## 2. Commit Message Guidelines

All commits must strictly follow the **Conventional Commits** specification:

- `feat: <description>` — New user-facing feature or protocol message.
- `fix: <description>` — Bug fix or error recovery correction.
- `docs: <description>` — Documentation, README, protocol specs, diagrams.
- `test: <description>` — Adding or updating test suites, mocks, harness.
- `chore: <description>` — Build system, dependencies, configs, packaging.
- `refactor: <description>` — Code reorganization without functional change.

Example:

```bash
git commit -m "feat(server): implement room creation and unique 6-char code generation"
```

---

## 3. Pull Request (PR) Checklist

Before submitting or merging any PR into `main`, verify every item below:

- [ ] **Tests pass**: `npm test` runs cleanly across all workspaces.
- [ ] **Lint and formatting**: `npm run lint` and `npm run format:check` pass with zero warnings/errors.
- [ ] **Builds succeed**: `npm run build` succeeds without compilation errors.
- [ ] **TSDoc comments**: All newly exported types, interfaces, functions, and classes have comprehensive TSDoc comments explaining _why_ design decisions were made, not just _what_ they do.
- [ ] **No console errors**: Client renders cleanly without unhandled exceptions or React warnings.
- [ ] **Strict Typing**: No `any` types. Strict TypeScript checks are satisfied.
- [ ] **Documentation updated**: Any protocol changes, CLI flags, or settings are documented in `docs/`.

---

## 4. Coding Standards

- **Language**: TypeScript in strict mode everywhere.
- **Networking**: All essential runtime data and control exchange must use raw TCP socket communication (`net.Socket`, `net.Server`). Never use WebSockets, Socket.IO, HTTP APIs, or cloud backend services.
- **Modularity**: Keep files small, focused, and single-purpose.
- **Comments**: Write meaningful comments explaining _why_ an algorithm, protocol framing, or sequence calculation exists.

---

## 5. Local Development Commands

```bash
# Install all dependencies across all workspace packages
npm install

# Run the TCP server in development mode
npm run server

# Run the Electron client in development mode
npm run client

# Run all tests across workspaces
npm test

# Check code formatting & lint
npm run lint
npm run format:check
```

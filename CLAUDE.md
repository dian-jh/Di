# CLAUDE.md

## Development Principles

### MVP First
- When creating or analyzing a new harness module, start with the **minimum viable implementation** — get the core path working end-to-end first.
- Do not plan for perfection upfront. Build the minimal version, then iterate in later passes.
- Design for today's concrete need; refactor only when a real second use case arrives.

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- **Atomic commits**: one logical change per commit. Never mix unrelated changes.
- Use type prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- **Commit messages in English.**
- Commit at appropriate moments: when a logical unit of work is complete and compiles.

Example:

```
feat: add agent loop skeleton

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

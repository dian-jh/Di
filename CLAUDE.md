# CLAUDE.md

## Development Principles

### MVP First
- When creating or analyzing a new harness module, start with the **minimum viable implementation** — get the core path working end-to-end first.
- Do not plan for perfection upfront. Build the minimal version, then iterate in later passes.
- Design for today's concrete need; refactor only when a real second use case arrives.

### Test-Driven Development (TDD)
- **Write tests first, then the implementation.** Turn the requirement into failing tests, then implement until the tests pass.
- Tests express the business requirement; the code conforms to the tests, the tests conform to the requirement.
- Keep the red/green discipline per unit of work: write the test, watch it fail (red), implement, watch it pass (green).

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- **Atomic commits**: one logical change per commit. Never mix unrelated changes.
- Use type prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- **Commit messages in English.**
- Commit at appropriate moments: when a logical unit of work is complete and compiles.
- **Never include `Co-Authored-By: Claude Code <noreply@anthropic.com>` (or any other `Co-Authored-By`) in commit messages.** Write commit messages without an attribution trailer.

Example:

```
feat: add agent loop skeleton
```

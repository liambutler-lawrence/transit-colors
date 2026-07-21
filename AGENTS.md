# Repository Agent Instructions

## GitHub CLI authentication

- `gh auth status` can report erroneous authentication failures inside the sandbox.
- Before treating GitHub authentication as blocked, retry the relevant `gh` command
  with escalated sandbox permissions and use that result as authoritative.

## Feature delivery

- For every completed feature request, commit the scoped changes, push them to
  GitHub, merge them into `main`, and verify the GitHub Pages deployment unless the
  user explicitly asks to keep the work local.

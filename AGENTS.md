# Repository Agent Instructions

## GitHub CLI authentication

- `gh auth status` can report erroneous authentication failures inside the sandbox.
- Before treating GitHub authentication as blocked, retry the relevant `gh` command
  with escalated sandbox permissions and use that result as authoritative.

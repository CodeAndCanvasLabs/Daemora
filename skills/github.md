---
name: github
description: GitHub operations via gh CLI — issues, PRs, code review, CI, releases, API queries
triggers: github, gh, issue, pull request, PR, code review, CI, actions, workflow, release, gist, repo, label, milestone
---

## Setup
- Requires `gh` CLI authenticated: `gh auth status`
- All commands via `executeCommand("gh ...")`

## Issues
- Create: `gh issue create --title "title" --body "body" --label "bug"`
- List: `gh issue list --state open --label "bug" --limit 20`
- View: `gh issue view 42`
- Close: `gh issue close 42 --reason completed`
- Comment: `gh issue comment 42 --body "Fixed in #55"`
- Assign: `gh issue edit 42 --add-assignee username`
- Search: `gh issue list --search "memory leak is:open"`

## Pull Requests
- Create: `gh pr create --title "feat: X" --body "description" --base main`
- List: `gh pr list --state open --author @me`
- View: `gh pr view 55 --comments`
- Review: `gh pr review 55 --approve --body "LGTM"`
- Merge: `gh pr merge 55 --squash --delete-branch`
- Diff: `gh pr diff 55`
- Checks: `gh pr checks 55`
- Request review: `gh pr edit 55 --add-reviewer user1,user2`

## CI / Actions
- List runs: `gh run list --limit 10`
- View run: `gh run view RUN_ID`
- Watch live: `gh run watch RUN_ID`
- Re-run failed: `gh run rerun RUN_ID --failed`
- View logs: `gh run view RUN_ID --log-failed`
- List workflows: `gh workflow list`
- Trigger: `gh workflow run deploy.yml -f env=staging`

## Releases
- Create: `gh release create v1.0.0 --title "v1.0.0" --notes "changelog"`
- List: `gh release list`
- Download: `gh release download v1.0.0 -D /tmp/release`
- Delete: `gh release delete v1.0.0 --yes`

## API Queries
- REST: `gh api repos/owner/repo/issues --jq '.[].title'`
- GraphQL: `gh api graphql -f query='{ viewer { login } }'`
- Paginate: `gh api repos/owner/repo/stargazers --paginate --jq '.[].login'`

## Repo Operations
- Clone: `gh repo clone owner/repo`
- Fork: `gh repo fork owner/repo --clone`
- Create: `gh repo create name --public --source=. --push`
- View: `gh repo view owner/repo`

## Rules
- Always use `--json` + `--jq` for structured output when parsing results
- Prefer `gh api` over raw curl for authenticated endpoints
- Check `gh auth status` before operations if auth errors occur

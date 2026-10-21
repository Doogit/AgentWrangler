# GitHub read access used by Outcomes

AgentWrangler uses the daemon's `AW_GITHUB_TOKEN` or Windows Generic Credential `AgentWrangler-GithubToken` with `gh api`. It never uses a separately signed-in `gh auth` identity. The explicit connection test checks the first locally mapped repository with `GET /repos/{owner}/{repo}/pulls?per_page=1`. It confirms only that one call at that moment. A successful empty PR list is valid; it does not prove access to checks, commits, or review threads. The test has no arbitrary host or URL input.

| Production read | Used for | GitHub's documented fine-grained repository permission |
| --- | --- | --- |
| [List pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) | Sync and connection test | Pull requests: read |
| [Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) | PR body, head ref, diff representation | Pull requests: read **or** Contents: read, per endpoint documentation |
| [List commits on a pull request](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request) | Session linkage | Pull requests: read |
| [List pull requests associated with a commit](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit) | Reverse SHA linkage | Pull requests: read |
| [List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) | Check conclusion | Checks: read; GitHub says classic tokens need `repo` for private repositories |
| [GraphQL `repository.pullRequest.reviewThreads`](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql) | Finding extraction | GraphQL permission depends on requested resources and token type; no universal minimum is asserted here |

Grant the token access to the specific repositories you map. Organization policies and token approval can also affect access. A 403 can mean permission, policy, or rate limit; a 404 may hide an inaccessible repository. The dashboard reports these as ambiguous categories. GitHub's [fine-grained permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) and `X-Accepted-GitHub-Permissions` response header can help an operator diagnose an endpoint denial. AgentWrangler does not expose response bodies or credentials in status.

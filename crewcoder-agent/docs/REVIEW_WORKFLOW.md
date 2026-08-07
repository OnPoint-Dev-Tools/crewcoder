# Review Workflow Backend Boundary

`crewcoder git review-summary --json` is the backend contract used by the TUI review summary block.

Current summary payload:

```ts
type GitReviewSummary = {
  branch?: string;
  clean: boolean;
  changedFiles: string[];
  issueReferences: GitIssueReference[];
  status: GitStatus;
};
```

## Structured issue provider design

The backend now exposes type-only planning primitives for richer issue provider integrations:

- `GitIssueProviderConfig`
- `GitStructuredIssue`
- `GitReviewIssueProviderPlan`

These are intentionally passive. They do not perform network requests, prompt for auth, read tokens, or fetch remote issue data.

Open boundary decisions before implementation:

- where provider configs live (`config.json`, extension contribution, repo metadata, or all three)
- how auth is granted and scoped per provider
- whether issue fetching is automatic, user-triggered, or extension-provided
- how provider failures should appear in the TUI without blocking local review summaries

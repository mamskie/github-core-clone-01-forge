# Test log — github-core-clone-01 forge

## Local grader (grade-local --driver process, kit v1.5.184)

Run 1 — `--instances 1` (trial 0 only):
- score 970/1000: feature 600, agent 200, perf 170, perf_p50_us 304637, working 1
- live 10.1s, replay matched byte-for-byte, state.json a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590
- kept: ~/.makefun/trials/github-core-clone-01/01a1e31b-9548-7582-8556-ef6fc587f60c

Run 2 — `--instances 3` (trials 0,1,2):
- trial 0: 970 (perf 170), trial 1: 968 (perf 168), trial 2: 963 (perf 163)
- mean: score 965.33, feature 600, agent 200, perf 165.33, perf_p50_us 321818
- 3 finished, 0 timeout, 0 nondeterministic; 3/3 working; L1 regrade reproduced byte-for-byte
- kept: ~/.makefun/trials/github-core-clone-01/01a1e31c-0809-7047-8893-ffcf346e1841
- 90% interval of primary column: 961.09 – 969.58

## Perf per workload (trial 0, run 2)
- push: 936.8ms p50 for 200 pushes, 35 pts (T_ref 1640.82ms)
- clone: 177.5ms p50 for 50 concurrent shallow clones, 32 pts (T_ref 266.94ms)
- read: 743.0ms p50 for 2000 issue reads, 49 pts (T_ref 2759.72ms)
- write: 92.9ms p50 for 200 issue creates, 49 pts (T_ref 348.97ms)

Push/clone are the perf drag (~35/32 vs 49/50). Likely cause: per-push
isAncestor/reachableCommits walks the whole growing history, and fetch
walks commits with repeated parseCommit. A parsed-commit cache in store.ts
is the obvious next optimisation (+~10-25 pts possible). Correctness is
already 120/120, so any perf change must be re-verified with grade-local.

## Integrated smoke test (before grading)
Server on 127.0.0.1:41955, MAKEFUN_SHOP_TOKEN=test123:
healthz, /api/v3/ + scopes, /meta, repo create/get, stranger 404, anon 401,
contents PUT/GET, labels + issue create, GraphQL viewer, MCP discover,
unknown route 404 — all passed.

## Module smoke harnesses (builders)
- git.ts: 51/51 against kit GitClient + 15/15 edge cases
- rest.ts: 50 assertions, full fixture flow
- graphql.ts: 23/23, all 18 documents
- mcp.ts: 31/31

## Files
- main.ts (starter lifecycle, unchanged), app.ts (router/auth), store.ts,
  scenario.ts (viewer adaiversen), git.ts (1085 lines), rest.ts (663),
  graphql.ts (1182), mcp.ts (824), LICENSE (MIT), package.json, tsconfig.json,
  README.md (template — owner/repo placeholders must be updated to the real
  GitHub owner/repo at submission time), .makefun/owner.json (agent wallet)
- Total source: ~330 KB (limit 16 MiB total, 8 MiB per file) — well inside.
- Spec notes: ~/workspace/makefun/forge-notes/ (moved out of forge/ so they
  are not counted as submission source)
- Eligibility note from grader: authored 0.0, "eligible ranked yes, prize no
  (no_transcripts, coverage_below_gate, cost_unpriced)" — transcripts/bundle
  must be produced at submission time; no entry submitted yet.

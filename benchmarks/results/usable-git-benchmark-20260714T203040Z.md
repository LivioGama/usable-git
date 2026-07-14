# usable-git benchmark report

Status: **NOT RELEASE-ELIGIBLE**

Generated: 2026-07-14T20:30:40.770Z
Commit: `9e6d071f6dee80c19ec439512181e76aa77a80db`
Seed: `20260714`
Trials per scenario/client: 40
Raw trial artifact: [usable-git-benchmark-20260714T203040Z.json](./usable-git-benchmark-20260714T203040Z.json)

## Environment

- OS: darwin 24.6.0 (arm64)
- CPU: Apple M1 Max × 10
- Memory: 34359738368 bytes
- Bun: 1.3.14
- Git: git version 2.50.1 (Apple Git-155)

Client versions:

- codex: 0.144.4
- claude-code: 2.1.209
- devin: 3000.1.27 (0d4bf12e)

## Results

| Client | Scenario | Method | Trials | Success | Oracle | Real sessions | Semantic adoption | Median ms (95% CI) | P95 ms (95% CI) | Git subprocesses | Agent operations | Git tokens |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| codex | inspect-dirty | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 21011.40 [95% CI 19442.04–22434.24] | 31823.91 [26349.17–37285.40] | unavailable | 2 | 57999 |
| codex | inspect-dirty | semantic | 40 | 100.0% | 100.0% | 100.0% | 100.0% | 13017.48 [95% CI 12372.75–14256.53] | 21852.78 [18368.06–26323.73] | 6 | 1 | 57650 |
| codex | publish-scoped | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 46903.19 [95% CI 43321.51–48862.67] | 88526.10 [78525.46–120005.85] | unavailable | 4 | unavailable |
| codex | publish-scoped | semantic | 40 | 100.0% | 100.0% | 100.0% | 100.0% | 21524.49 [95% CI 20477.23–22575.09] | 26389.15 [24592.11–30321.88] | 8 | 2 | 85729.50 |
| claude-code | inspect-dirty | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 3786.90 [95% CI 3718.47–3942.45] | 4343.57 [4109.76–7336.23] | unavailable | 0 | 0 |
| claude-code | inspect-dirty | semantic | 40 | 0.0% | 100.0% | 100.0% | 0.0% | 3775.78 [95% CI 3708.74–3865.36] | 4273.20 [4074.14–5601.56] | unavailable | 0 | 0 |
| claude-code | publish-scoped | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 3812.72 [95% CI 3751.64–3889.43] | 4316.95 [4056.78–6793.77] | unavailable | 0 | 0 |
| claude-code | publish-scoped | semantic | 40 | 0.0% | 100.0% | 100.0% | 0.0% | 3800.38 [95% CI 3730.08–3840.50] | 4026.68 [3989.60–4479.67] | unavailable | 0 | 0 |
| devin | inspect-dirty | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 5758.14 [95% CI 5726.42–5813.02] | 6837.84 [5992.68–7066.86] | unavailable | 0 | unavailable |
| devin | inspect-dirty | semantic | 40 | 0.0% | 100.0% | 100.0% | 0.0% | 5751.99 [95% CI 5710.89–5934.09] | 6705.92 [6382.58–7659.66] | unavailable | 0 | unavailable |
| devin | publish-scoped | raw-git | 40 | 0.0% | 100.0% | 100.0% | n/a | 5729.99 [95% CI 5689.59–5773.86] | 6111.30 [5899.66–6786.73] | unavailable | 0 | unavailable |
| devin | publish-scoped | semantic | 40 | 0.0% | 100.0% | 100.0% | 0.0% | 5795.61 [95% CI 5738.77–5867.59] | 6524.65 [6008.96–7027.33] | unavailable | 0 | unavailable |

## Release gate

- repository correctness or success rate below 100%
- Git-related client token measurements unavailable
- Git subprocess measurements unavailable
- semantic-tool adoption below 95%
- codex / inspect-dirty: Git-related token reduction below 30%
- claude-code / inspect-dirty: p95 duration reduction below 30%
- claude-code / publish-scoped: p95 duration reduction below 30%
- devin / inspect-dirty: p95 duration reduction below 30%
- devin / publish-scoped: p95 duration reduction below 30%

Token values marked unavailable were not measured or estimated. No performance claim may use them. Short runs are fixture checks only; v1 requires at least 40 trials per scenario and client.

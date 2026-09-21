# Project facts and task outcomes

```text
/memory remember API calls belong in services/
/memory
/memory forget <fact-id>
/memory outcomes
/memory accept <outcome-id> yes
```

Facts are explicit human-entered guidance, included on the next parent prompt; current repository evidence/rules/policy take precedence. Normal model tasks record bounded local task summaries, selected skills, verification/skip status, and repair counts. Model completion is not a verification pass. Human acceptance stays unknown until explicitly recorded. No raw model/tool/check outputs are copied. These owner-only plaintext files may contain sensitive task/fact text; inspect them under the existing `~/.casper/projects/<project-key>/` directory.

If facts are invalid or unreadable, normal tasks warn and continue without remembered guidance; the facts file is not reset or repaired. Explicit `/memory` reads and changes still fail closed on invalid state. A later prompt rereads repaired facts. Full outcome stores still refuse new records; no automatic pruning or stale-lock removal is performed.

Learning candidate generation and explicit human promotion are available separately below.

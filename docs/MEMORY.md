# Project facts and task outcomes

**What this is:** a short list of facts you type in about a project, plus a log
of past task results. **When you'd use it:** when you want Casper to keep a rule
in mind every time, for example "API calls belong in services/", without saying
it in every request.

## Commands

```text
/memory                          list your saved facts
/memory remember API calls belong in services/
/memory forget <fact-id>         remove one fact
/memory outcomes                 show the latest 20 task results
/memory accept <outcome-id> yes  record that you accepted a result (or no)
```

These are local commands. They do not call a model.

## Facts

- Only you add facts. The model cannot add, change or remove them.
- Saved facts are added to the next request you send. They are guidance, not
  permission. The current code, project rules, your request and safety policy
  come first. Facts can go out of date, so the model is told to check before it
  relies on one.
- Each fact is up to 1024 bytes. You can keep up to 64 facts, and 8 KiB of fact
  text in total. When it is full, `/memory forget` old facts first.
- Saving the same text twice keeps one fact. The ID comes from the text.

## Task outcomes

After a normal model task, Casper saves a short record:

- the request text (up to 4 KiB) and the skills that were used;
- whether the model finished, failed or was cancelled;
- which checks Casper ran and whether they passed, failed or were skipped;
- how many repair rounds ran.

It does not copy model replies, tool output or check output.

The model finishing is not the same as the checks passing. "Accepted" stays
empty (unknown) until you run `/memory accept <id> yes` or `no`. Accepting is
your own record. It is not test evidence.

## Where it is stored

Both files live in the project's state folder:

```text
~/.casper/projects/<project-key>/memory.jsonl     facts
~/.casper/projects/<project-key>/outcomes.jsonl   task outcomes
```

They are plain text, readable only by your user account (file mode `0600` on
macOS and Linux). They are not encrypted and may hold sensitive task or fact
text.

## When something is wrong

- If the facts file is invalid or unreadable, normal tasks show a warning and
  carry on without facts. The file is not reset or repaired. Fix it yourself;
  the next request reads it again.
- `/memory` commands themselves stop with an error on an invalid file, rather
  than overwrite it.
- Each file holds at most 1000 records and 1 MiB. When the outcomes file is
  full, new outcomes are refused. Nothing is pruned for you, and a stale lock is
  not removed for you.

Drafting reusable patterns from a repository is a separate command; see
[LEARNING.md](LEARNING.md).

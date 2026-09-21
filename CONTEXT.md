# Casper

Casper is a coding companion that distinguishes a model's work from host-recorded
verification and human acceptance.

## Language

**Startup default**:
The globally remembered model and reasoning preference for new parent conversations.
An existing conversation's recorded selection takes precedence.
_Avoid_: Login, account, active model

**Conversation selection**:
The model chosen for one conversation, retained when that conversation is resumed.
It need not be the startup default.
_Avoid_: Temporary login, provider connection

**Effort**:
The reasoning level supported by the selected model. It is not a guarantee of
answer quality, elapsed time or billed cost.
_Avoid_: Permission mode, agent mode

**Context usage**:
The runtime's estimate of the current model context occupancy, which may be unknown.
It is distinct from cumulative session tokens.
_Avoid_: Exact memory consumption

**Named workspace**:
A named conversation/workspace relationship managed by Casper. Changing the
conversation does not inherently change or restore workspace files.
_Avoid_: Checkpoint, undo

**Verification evidence**:
Host-recorded results for explicitly scoped checks, with their freshness limits.
Model claims, successful tool displays and human acceptance are distinct evidence.
_Avoid_: Done, guaranteed correct

**Process ownership**:
Casper's bounded, non-atomic record of the OS processes a spawned adapter, browser,
development server or check produced, verified by OS parentage and an identity stamp
before anything is terminated. It is not a sandbox and does not certify that every
descendant was observed.
_Avoid_: Kill list, process registry

**Evaluation task**:
One prompt over a fixture repository with an independent acceptance command and
declared behavioral expectations. Its success is measured, never self-reported.
_Avoid_: Benchmark, score, grade

**Fixture baseline**:
The solved state of an evaluation fixture, whose own verification commands pass. A
task's setup overlay turns it into the unsolved starting state; the pair is what
makes the task real rather than assumed.
_Avoid_: Test data, sample repo

**Task success**:
Execution completed, the independent verification command passed, and every declared
acceptance predicate held. Casper's own verification report is recorded separately
and never counts as acceptance.
_Avoid_: Pass, green, working

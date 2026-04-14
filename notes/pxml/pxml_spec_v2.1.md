# PXML Specification v2.1

**Plugin-Extended Markup Language**
Version: 0.2.1-draft
Status: Design phase — not yet implemented
Authors: Mark Manley, with design assistance from Claude (Anthropic)
Supersedes: PXML_SPEC_v2.md v0.2.0-draft

---

## 1. Purpose

PXML is a bulk-flow command language for describing AI agent pipelines. It exists in two modes that share one grammar:

- **Block mode** — a structured document describing agents, tool scoping, interceptors, lifecycle phases, and prompts. This is what an orchestration engine (Phlox) executes as chunks arrive through the buffer.
- **Inline mode** — sigil-annotated natural language that a human writes inside a free-text prompt. A planning agent compiles inline PXML into block mode for execution. The compilation is stored as an event-sourced aggregate for auditability, replay, and versioning.

PXML is designed to be:

- Bulk-flow — fixed-size chunks of complete elements flow through a buffer at a consumer-controlled rate
- Readable by humans and parseable by LLMs without a formal parser
- Embeddable in free-text prompts as small annotated fragments
- Compilable into Phlox graph structs for execution
- Event-sourced — every mutation to a compilation is an immutable event, projectable into any read model
- Framework-agnostic on the validation side — Gladius validates PXML schemas whether the downstream consumer is Phoenix, Bandit, SpaceCowboy, or bare Plug


---

## 2. Design principles

1. **Sigils are the parse hints.** Every structured element in inline mode is prefixed with a sigil that an LLM can extract without a parser.

2. **Block mode is the compilation target.** Inline mode is lossy by design. Block mode captures the full execution plan including explicit defaults for everything inline leaves implicit.

3. **Bulk flow, not batch, not streaming.** PXML is neither a batch document (parsed whole) nor a stream (parsed token-by-token). It is a bulk-flow pipeline: the parser produces fixed-size chunks of complete bookended elements into a buffer. The consumer (Phlox) pulls chunks at its own pace via demand-based backpressure. The buffer controls the rate. This is GenStage/Flow semantics applied to document parsing.

4. **Capability scoping, not capability binding.** Tools are picked into and dropped from a mutable toolbelt that flows through the document. The prompt decides invocation; pick/drop decides possibility.

5. **The document is the scope.** Tool availability, interceptor configuration, and state typing are lexically scoped by document structure.

6. **Phlox is the runtime, PXML is the notation, Gladius is the contract.** None of the three depend on each other. Bridges connect them.

7. **The Interceptor is a specific Extension.** Extensions are persistent. Plugins are ephemeral. The Interceptor Extension manages plugin activation on individual nodes. Two types, one distinguished bridge.

8. **Event-sourced persistence.** Compilations are aggregates. Every mutation (compile, revise, execute, complete, fail) is an immutable event. Read models are projections. The event log is the source of truth.

9. **The interceptor pipeline has a canonical order.** The Interceptor Extension owns the execution sequence of its managed plugins. Node authors declare *what* interceptors they want, not *when* they fire. Tool ordering within the node's work phase is the only ordering the node controls.


---

## 3. Architecture overview

### 3.1 Package topology

```
phlox              — graph execution engine (no PXML knowledge)
gladius            — validation/spec library (no Phlox knowledge)
phlox_gladius      — bridge: Interceptor Extension + Validate Plugin
pxml               — parser + compiler (depends on phlox, gladius, phlox_gladius)
pxml_store         — CQRS/ES persistence (depends on pxml, uses Commanded + Postgres)
```

Optional framework bridges:

```
gladius_phoenix    — Gladius integration for Phoenix
gladius_bandit     — Gladius integration for Bandit
gladius_plug       — Gladius integration for bare Plug
space_cowboy       — Datastar-native Elixir server with built-in Gladius + PXML
```

### 3.2 The Extension / Plugin / Interceptor relationship

```
Extensions (persistent, cross-cutting)
├── Telemetry Extension
├── Audit Log Extension
├── Circuit Breaker Extension
├── Token Ledger Extension
└── Interceptor Extension            ← the distinguished one
    │
    │  manages plugin activation per-node
    │  owns the canonical execution pipeline
    │
    ├── Validate Plugin              (uses Gladius via phlox_gladius)
    ├── Retry Plugin
    ├── Fallback Model Plugin
    ├── Structured Output Plugin
    ├── Rate Limit Plugin
    ├── Redact Plugin
    ├── Cache Plugin
    └── Guard Plugin

Plugins (ephemeral, per-run, wrap entire traversal)
├── Dry Run
├── Debug Trace
├── Timeout Budget
├── Cost Ceiling
└── Seed Pin
```

### 3.3 Bulk flow model

PXML parsing is a producer-consumer pipeline with buffer-controlled backpressure:

```
Source (text)
    │
    ▼
┌─────────────────────────┐
│  Parser (nimble_parsec)  │
│  produces: complete      │
│  bookended elements      │
│  chunk size: 1 element   │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Buffer (GenStage)       │
│  max_demand: configurable│
│  min_demand: configurable│
│  backpressure: demand    │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Consumer (Phlox)        │
│  pulls elements on       │
│  demand, begins          │
│  execution as phases     │
│  arrive                  │
└─────────────────────────┘
```

**Why bulk flow, not streaming:**

Streaming implies continuous, unbounded, token-at-a-time delivery. PXML elements are discrete, bounded chunks — a `<pre>` block is complete when `pre>` closes. The parser doesn't emit partial elements. It buffers incomplete elements internally and only produces complete AST nodes into the downstream buffer.

Batch implies the entire document must arrive before processing begins. Bulk flow lets Phlox begin executing `<pre>` while `<exec>` is still being parsed. The buffer decouples parser speed from executor speed.

**Chunk boundaries:** A chunk is one complete top-level element within its parent. The parser emits:

1. `<defaults>` — consumer applies defaults immediately
2. `<state>` — consumer registers typed state
3. `<pre>` — consumer begins pre-phase execution
4. `<exec>` — consumer begins exec-phase (may overlap with pre completion)
5. `<post>` — consumer begins post-phase after exec completes
6. `<with>` — consumer wraps the entire traversal with plugins

The `<pxml>` root itself is not a chunk — its children are. The root's attributes (`%ns`, `%version`, etc.) are emitted as a header chunk before any children.

**Buffer configuration:**

```elixir
PXML.parse(source,
  max_demand: 2,      # pull at most 2 elements ahead
  min_demand: 1,      # refill when buffer drops to 1
  timeout: 30_000     # ms to wait for next complete element
)
```


---

## 4. Sigil table

| Sigil | Name | Meaning | Example |
|-------|------|---------|---------|
| `%` | Attribute | Metadata key on an element | `%name = fetch_context.` |
| `^` | Spec ref | Gladius registry lookup | `^findings_list` |
| `@` | Mention | Agent or human reference | `@security_scan` |
| `#` | Tag | Label, category, or redaction target | `#env_vars` |
| `/` | Command | Imperative action | `/dry-run` |
| `.` | Terminator | Ends a value | `%timeout = 10s.` |
| `=` | Assignment | Binds a value to an attribute | `%model = claude-opus.` |
| `:` | Type annotation | Declares a type constraint | `%pr_diff : ^diff_schema.` |
| `~~` | Comment | Bookended comment | `~~ this is a note ~~` |
| `[,]` | List | Ordered collection | `[#env_vars, #api_keys]` |
| `'...'` | Literal | Escapes sigil parsing | `'sending:to:LLM'` |

**Removed from v2.0:** The `[|]` pipeline sigil. See section 6.8 for why.

### Sigil precedence in inline mode

1. `/command` — imperative, highest priority
2. `@mention` — agent/human references
3. `^spec` — type/schema references
4. `#tag` — labels and categories
5. `%attribute` — contextual metadata


---

## 5. Syntax

### 5.1 Elements (bookended)

```
<element-name ... element-name>
```

Symmetric bookend closing. The word at both ends is the same.

### 5.2 Attributes

```
%name = fetch_context.
%retry : int(gte: 0) = 3.
%on-failure : [halt, warn, skip, fallback] = halt.
```

Prefixed with `%`, terminated with `.`. Optional `:` type annotation between name and `=`.

### 5.3 Values

- **Atoms:** `halt.` `true.` `json.`
- **Numbers:** `3.` `0.50.` — parser is greedy, reads longest valid numeric before final `.`
- **Durations:** `10s.` `1h.` `120s.` `500ms.` `1/min.`
- **Currency:** `$0.50.`
- **Strings:** Unquoted when unambiguous. Single-quoted `'like:this'` for sigil-active characters.
- **Lists:** `[a, b, c].`
- **Spec refs:** `^schema_name.`
- **Agent refs:** `[@agent_a, @agent_b].`
- **Tag refs:** `[#env_vars, #api_keys].`
- **Globs:** `github:*.`

### 5.4 Freetext blocks

```
<prompt=
  Review this diff. Cite line numbers from %pr_diff.
=prompt>
```

The `=` mode switch. `%name` interpolates state variables. All other sigils are literal.

### 5.5 Comments

```
~~ this is a comment ~~
```

### 5.6 Namespaces

```
<pxml %ns = PXML:org:pxml:brain-trust.
```


---

## 6. Elements

### 6.1 Root: `<pxml>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%ns` | Yes | Reverse-domain namespace |
| `%version` | Yes | PXML spec version |
| `%context` | No | URL to external schema/documentation |
| `%compiled_from` | No | UUID of the inline source |
| `%compiled_at` | No | ISO 8601 compilation timestamp |
| `%compilation_id` | No | UUID of the compilation aggregate |

Children: `<defaults>`, `<state>`, `<pre>`, `<exec>`, `<post>`, `<with>`, `<capability>`

### 6.2 Defaults: `<defaults>`

Explicit values for everything inline mode leaves implicit. Every attribute on an agent that is not explicitly set inherits from here.

```
<defaults
  ~~ model and execution ~~
  %model = claude-sonnet.
  %timeout : duration = 30s.
  %on-failure : [halt, warn, skip, fallback] = warn.

  ~~ interceptor-managed plugins ~~
  %retry : int(gte: 0) = 2.
  %structured_output : [json, xml, custom, none] = none.
  %output_schema = none.
  %fallback_model = none.
  %cache : [duration, off] = off.
  %rate_limit = 10/min.
  %redact = [].
  %guard : [guard_name, none] = none.

  ~~ extensions ~~
  %audit_log : bool = false.

  ~~ scoping ~~
  %tool-inheritance : [inherit, empty] = inherit.
defaults>
```

**`%tool-inheritance`** controls whether child agents inherit their parent's toolbelt:

- `inherit` — children see all tools their parent can see (default)
- `empty` — children start with an empty toolbelt, must pick explicitly

### 6.3 State: `<state>`

```
<state
  %pr_diff   : ^diff_schema.
  %findings  : ^findings_list.
  %review    : ^review_output.
state>
```

Typed shared state. `^ref` names are resolved against Gladius registry. At runtime, reads/writes are validated by the Validate Plugin via the Interceptor Extension.

### 6.4 Lifecycle phases: `<pre>`, `<exec>`, `<post>`

- **`<pre>`** — Setup. Fetch context, establish tool availability.
- **`<exec>`** — Core work. Agent graph. May contain `<plan>` blocks.
- **`<post>`** — Teardown. Publish, clean up, notify.

**Bulk flow behavior:** Each phase is emitted as a complete chunk when its bookend closes. Phlox can begin executing a phase as soon as it arrives in the buffer.

### 6.5 Agent: `<agent>`

| Attribute | Required | Default source | Description |
|-----------|----------|----------------|-------------|
| `%name` | Yes | — | Unique identifier |
| `%model` | No | `<defaults>` | LLM model |
| `%depends_on` | No | `[]` | List of `@agent` refs that must complete first |
| `%timeout` | No | `<defaults>` | Per-agent wall-clock timeout |
| `%on-failure` | No | `<defaults>` | Failure policy for this agent |

Children: `<pick-tool>`, `<drop-tool>`, `<intercept>`, `<prompt=>`, `<system=>`

**Explicit defaults on agents:** When inline mode is compiled to block mode, the compiler fills in every attribute that has a default. A fully explicit agent looks like:

```
<agent %name = security_scan.
  %model = claude-opus.
  %depends_on = [].
  %timeout = 30s.
  %on-failure = warn.
  <intercept
    %validate_in = none.
    %validate_out = ^findings_list.
    %retry = 3.
    %structured_output = json.
    %output_schema = json_schema.
    %fallback_model = none.
    %cache = off.
    %rate_limit = 10/min.
    %redact = [].
    %guard = block_if_hallucinated_cve.
    %audit_log = false.
  intercept>
  <prompt=
    Review this diff for security vulnerabilities.
    Focus on: injection, auth bypass, secret leakage.
    Cite exact line numbers from %pr_diff.
  =prompt>
agent>
```

The `= none.` values are explicit "I am not using this." A human authoring block mode directly can omit them (they inherit from `<defaults>`). A compiler producing block mode from inline MUST include them, making the compiled document fully self-describing with zero hidden assumptions.

### 6.6 Plan: `<plan>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%orchestration` | Yes | `parallel`, `sequential`, `race`, `round-robin` |

### 6.7 Tool scoping: `<pick-tool>`, `<drop-tool>`

Manage the agent's capability set. The prompt decides invocation; these decide possibility.

**`<pick-tool>`:**

| Attribute | Required | Default source | Description |
|-----------|----------|----------------|-------------|
| `%name` | Yes | — | Tool identifier or glob |
| `%on-failure` | No | `<defaults>` | `halt`, `warn`, `skip`, `fallback` |

**`<drop-tool>`:**

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Tool identifier or glob |

**Scoping rules:**

1. Inheritance direction set by `%tool-inheritance` in `<defaults>`.
2. Glob drops clear entire namespaces.
3. Pick after glob drop = whitelist (deny-all, allow-some).
4. Post-phase pick/drop ordering = LIFO lifecycle stack.

### 6.8 Intercept: `<intercept>`

Declares per-node plugin activation. The Interceptor Extension reads these and activates the corresponding plugins.

```
<intercept
  %validate_out = ^findings_list.
  %retry = 3.
  %structured_output = json.
  %guard = block_if_hallucinated_cve.
  %tool-order = [github:get_repo_conventions, github:get_pr_diff].
intercept>
```

**The canonical interceptor pipeline:**

The Interceptor Extension executes its managed plugins in a fixed order. This is not configurable by the node — it is an invariant of the Extension:

```
1. Rate Limit        ← throttle before doing any work
2. Cache check       ← return cached result if hit (skip steps 3-9)
3. Redact            ← strip sensitive fields from input
4. Validate (in)     ← check input shape via Gladius
5. ── Node work ──   ← LLM call + tool invocations (ordered by %tool-order)
6. Structured Output ← parse LLM text into typed data
7. Validate (out)    ← check output shape via Gladius
8. Guard             ← content safety filter
9. Redact (restore)  ← re-hydrate stripped fields in output
10. Cache store      ← cache the result if caching is on
```

Retry wraps steps 3-9. On failure, the Retry Plugin re-executes from step 3 (or from step 5 with Fallback Model).

**Why `[|]` pipeline syntax was removed:** In v2.0, `%tool-order = [%validate_in | %structured_output | %validate_out]` suggested the node could reorder interceptor stages. It cannot. The canonical pipeline is the Interceptor Extension's responsibility, not the node's. Allowing nodes to reorder it would break invariants (e.g., redaction must happen before validation, guard must happen after structured output).

**`%tool-order` is exclusively for tool execution order within step 5:**

```
%tool-order = [github:get_repo_conventions, github:get_pr_diff].
```

This is a list (`[,]`), not a pipeline. It says "call these tools in this order during the node's work phase." If omitted, tools are called in the order they were picked.

**Interceptor-managed plugin keys:**

| Key | Value type | Pipeline step | Description |
|-----|-----------|---------------|-------------|
| `%validate_in` | Spec ref or `none` | 4 | Validates node input |
| `%validate_out` | Spec ref or `none` | 7 | Validates node output |
| `%validate` | Spec ref or `none` | 4 + 7 | Shorthand: sets both in and out |
| `%retry` | Integer | wraps 3-9 | Max attempts with exponential backoff |
| `%structured_output` | Format or `none` | 6 | Parses LLM output |
| `%output_schema` | Spec ref or `none` | 6 | Schema for structured output |
| `%fallback_model` | Model name or `none` | retry alt | Re-execute step 5 with alternate model |
| `%cache` | Duration or `off` | 2 + 10 | Memoization TTL |
| `%rate_limit` | Rate expression | 1 | Token bucket throttle |
| `%redact` | Tag list | 3 + 9 | Strip/restore sensitive fields |
| `%guard` | Guard name or `none` | 8 | Content safety filter |
| `%audit_log` | Boolean | (Extension) | Routes to Audit Log Extension |
| `%tool-order` | List | 5 | Tool execution order within node work |

### 6.9 Prompt and system: `<prompt=>`, `<system=>`

Freetext blocks. `%name` interpolates state. Flat only — no nested access, no piped transforms.

### 6.10 With: `<with>`

Run-level ephemeral plugins wrapping the entire traversal:

```
<with
  <plugin %name = debug_trace. plugin>
  <plugin %name = timeout_budget. %max = 120s. plugin>
  <plugin %name = cost_ceiling. %max = $0.50. plugin>
with>
```

### 6.11 Plugin: `<plugin>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Plugin identifier |
| (additional) | No | Plugin-specific configuration |

### 6.12 Capability: `<capability>`

**New in v2.1.** Declares what this agent namespace *exposes* to other agents in A2A contexts. This is the counterpart to `<state>` (which declares what the pipeline consumes).

```
<capability
  %provides = [review:security, review:style, review:logic].
  %accepts_in : ^pr_diff_schema.
  %produces_out : ^review_output_schema.
  %tools_exposed = [review:run, review:status].
  %protocols = [ACP/1.0, A2A/0.3].
capability>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%provides` | Yes | List of capability identifiers this namespace offers |
| `%accepts_in` | No | Gladius spec ref for acceptable input |
| `%produces_out` | No | Gladius spec ref for guaranteed output shape |
| `%tools_exposed` | No | Tools this namespace makes available to callers |
| `%protocols` | No | Communication protocols supported |

A2A discovery works by querying namespaces for their `<capability>` declarations. An orchestrating agent can inspect a remote namespace's capabilities before routing work to it.


---

## 7. Inline mode

### 7.1 Example

```
Review the PR at %pr_url for security issues.
Have @security_scan and @logic_review run in parallel,
and then @synthesize combines their output.

Validate all findings against ^findings_list.
Redact #env_vars and #api_keys before 'sending:to:LLM'.
Cap the run at $0.50 and 120s.

/dry-run this first so I can see the cost estimate.
```

### 7.2 Extraction rules

| Sigil | Pattern | Extraction |
|-------|---------|------------|
| `/` | `/word` after whitespace or start-of-line | Command |
| `@` | `@word` | Agent/human mention |
| `^` | `^word` | Spec ref |
| `#` | `#word` | Tag |
| `%` | `%word` | State variable reference |
| `$` | `$N.NN` | Currency value |
| `Ns/Nh/Nm` | Number + time unit | Duration |
| `'...'` | Single-quoted span | Literal |

### 7.3 Compilation

Deterministic: sigil extraction. LLM-interpreted: orchestration, phase assignment, model selection, interceptor mapping. System-defaulted: everything in `<defaults>`.

### 7.4 Compilation storage

See section 9 (event-sourced).


---

## 8. Compilation target

| PXML element | Phlox struct / concept |
|-------------|------------------------|
| `<pxml>` | `%Phlox.Graph{}` |
| `<defaults>` | Default config on graph |
| `<state>` | Typed shared state (V2.8) |
| `<pre>` / `<exec>` / `<post>` | Phase groupings |
| `<agent>` | `%Phlox.Node{}` |
| `<plan>` | Subgraph with orchestration strategy |
| `<intercept>` | Interceptor Extension declarations on node |
| `<pick-tool>` / `<drop-tool>` | Tool scope mutations |
| `<prompt=>` / `<system=>` | Prompt template fields |
| `<with>` | Plugin list for `Phlox.run/2` |
| `<capability>` | Metadata (not executed, used for A2A discovery) |
| `^spec_ref` | `Gladius.Registry.fetch!/1` |

### The phlox_gladius bridge

```
phlox  ←── phlox_gladius ──→  gladius
              ↑
             pxml (uses the bridge during compilation and execution)
```

`phlox_gladius` provides:

- `PhloxGladius.InterceptorExtension` — the Interceptor Extension implementation
- `PhloxGladius.ValidatePlugin` — calls `Gladius.conform/2` at pipeline steps 4 and 7
- `PhloxGladius.StructuredOutputPlugin` — parses LLM output, validates against Gladius schema
- Convenience: `PhloxGladius.install(graph)` registers the extension on a Phlox graph

Neither `phlox` nor `gladius` knows about the bridge. The bridge depends on both.


---

## 9. Persistence layer (CQRS / Event Sourcing)

### 9.1 Aggregate: Compilation

A Compilation is an event-sourced aggregate managed by Commanded. Its state is built by folding events, never by mutating a row.

**Commands:**

| Command | Description |
|---------|-------------|
| `CompileInline` | Compile inline text into block mode |
| `CompileBlock` | Register a hand-authored block document |
| `ReviseCompilation` | Create a new revision from modified inline/block |
| `BeginExecution` | Mark the compilation as executing |
| `RecordAgentStart` | An agent within the graph has started |
| `RecordAgentComplete` | An agent completed (with output hash, tokens, duration) |
| `RecordAgentFailure` | An agent failed (with error) |
| `RecordToolInvocation` | A tool was actually invoked during node work |
| `RecordInterceptorResult` | An interceptor plugin produced a result |
| `CompleteExecution` | The entire pipeline completed |
| `FailExecution` | The pipeline failed |
| `MarkIncomplete` | The bulk-flow source terminated before `pxml>` closed |

**Events:**

| Event | Fields |
|-------|--------|
| `InlineCompiled` | `inline_text`, `inline_sigils`, `block_text`, `block_ast`, `compiler_model`, `compiler_reasoning`, `system_defaults`, `namespace`, `compiled_at` |
| `BlockRegistered` | `block_text`, `block_ast`, `namespace`, `registered_at` |
| `CompilationRevised` | `parent_id`, `revision`, `inline_text`, `block_text`, `block_ast`, `revised_at` |
| `ExecutionStarted` | `phlox_graph_id`, `started_at` |
| `AgentStarted` | `agent_name`, `phase`, `tools_available`, `interceptors_active`, `started_at` |
| `AgentCompleted` | `agent_name`, `phase`, `input_hash`, `output_hash`, `model_used`, `tokens_in`, `tokens_out`, `duration_ms`, `tools_invoked`, `completed_at` |
| `AgentFailed` | `agent_name`, `phase`, `error`, `retry_count`, `failed_at` |
| `ToolInvoked` | `agent_name`, `tool_name`, `input_hash`, `output_hash`, `duration_ms`, `invoked_at` |
| `InterceptorResultRecorded` | `agent_name`, `plugin_name`, `pipeline_step`, `result`, `recorded_at` |
| `ExecutionCompleted` | `total_tokens_in`, `total_tokens_out`, `total_duration_ms`, `total_cost`, `completed_at` |
| `ExecutionFailed` | `error`, `last_agent`, `failed_at` |
| `MarkedIncomplete` | `last_complete_element`, `buffer_state`, `marked_at` |

### 9.2 Read models (projections)

Projections are built from the event stream. Each serves a different consumer:

**CompilationSummary** — the "current state" view:

```elixir
defmodule PxmlStore.Projections.CompilationSummary do
  use Ecto.Schema

  schema "compilation_summaries" do
    field :compilation_id, :binary_id
    field :namespace, :string
    field :version, :integer, default: 1
    field :revision, :integer, default: 1
    field :status, :string  # compiled | executing | completed | failed | incomplete

    # Source
    field :inline_text, :string
    field :inline_sigils, :map

    # Compiled output
    field :block_text, :string
    field :block_ast, :map

    # Provenance
    field :compiler_model, :string
    field :compiler_reasoning, :string
    field :system_defaults, :map

    # Graph binding
    field :phlox_graph_id, :binary_id

    # Lineage
    field :parent_id, :binary_id
    field :compiled_at, :utc_datetime_usec
    field :executed_at, :utc_datetime_usec
    field :completed_at, :utc_datetime_usec

    timestamps()
  end
end
```

**ExecutionTrace** — per-agent execution detail:

```elixir
defmodule PxmlStore.Projections.ExecutionTrace do
  use Ecto.Schema

  schema "execution_traces" do
    field :compilation_id, :binary_id
    field :agent_name, :string
    field :phase, :string

    # Tool lifecycle
    field :tools_available, {:array, :string}
    field :tools_invoked, {:array, :string}

    # Interceptor results
    field :interceptor_results, :map

    # Execution data
    field :input_hash, :string
    field :output_hash, :string
    field :model_used, :string
    field :tokens_in, :integer
    field :tokens_out, :integer
    field :duration_ms, :integer
    field :error, :string

    field :started_at, :utc_datetime_usec
    field :completed_at, :utc_datetime_usec

    timestamps()
  end
end
```

**CostReport** — aggregated cost view per namespace:

```elixir
defmodule PxmlStore.Projections.CostReport do
  use Ecto.Schema

  schema "cost_reports" do
    field :namespace, :string
    field :period, :string  # daily, weekly, monthly
    field :period_start, :date
    field :total_compilations, :integer
    field :total_executions, :integer
    field :total_tokens_in, :integer
    field :total_tokens_out, :integer
    field :estimated_cost, :decimal
    field :avg_duration_ms, :integer

    timestamps()
  end
end
```

**DiffView** — comparison between compilation revisions:

Projects `CompilationRevised` events. Stores the diff between consecutive block_text/block_ast versions. Enables "what changed between revision 3 and revision 5?" queries.

### 9.3 Event store configuration (Commanded)

```elixir
defmodule PxmlStore.Application do
  use Commanded.Application,
    otp_app: :pxml_store,
    event_store: [
      adapter: Commanded.EventStore.Adapters.EventStore,
      event_store: PxmlStore.EventStore
    ]
end

defmodule PxmlStore.Router do
  use Commanded.Commands.Router

  identify PxmlStore.Aggregates.Compilation,
    by: :compilation_id,
    prefix: "compilation-"

  dispatch [
    CompileInline,
    CompileBlock,
    ReviseCompilation,
    BeginExecution,
    RecordAgentStart,
    RecordAgentComplete,
    RecordAgentFailure,
    RecordToolInvocation,
    RecordInterceptorResult,
    CompleteExecution,
    FailExecution,
    MarkIncomplete
  ], to: PxmlStore.Aggregates.Compilation
end
```

### 9.4 Why event sourcing

1. **Audit trail for free.** Every compilation, every agent execution, every tool invocation is an immutable event. Compliance and debugging are projection queries, not log scraping.

2. **Time travel.** Replay the event stream to reconstruct the state of any compilation at any point. "What did revision 3 look like before the security agent was added?" is a fold operation.

3. **Decoupled read models.** The cost report, the execution trace, and the diff view are independent projections. Add a new read model (e.g., "model usage by namespace") without touching the write side.

4. **Eventual consistency with Phlox.** Phlox executes the graph synchronously. PXML Store records events asynchronously via event handlers. The execution is never blocked by persistence — events are appended and projections rebuild in the background.

5. **Natural fit for bulk flow.** Events are chunks. The event store is a buffer. The projectors are consumers. The same producer-consumer semantics that drive PXML parsing also drive persistence.


---

## 10. Grammar implementation

### 10.1 nimble_parsec

Stack-based parser that emits AST nodes as bookended elements close. The parser is a GenStage producer — it yields complete elements into the downstream buffer.

**Key design considerations:**

- Freetext mode (`<tag= ... =tag>`) suppresses structure parsing except `%name` interpolation
- The `.` terminator and decimal numbers need greedy numeric parsing
- Comments (`~~ ... ~~`) are stripped during tokenization
- The parser should emit structured errors with line/column for malformed elements

### 10.2 Tree-sitter

Enables syntax highlighting in Neovim, VS Code, Helix, Monologue. Targets incremental reparsing. Injection support for PXML inside markdown fences (` ```pxml `). Freetext blocks fall back to plain text highlighting.


---

## 11. Full example (block mode)

```
<pxml %ns = PXML:org:pxml:brain-trust.
  %version = 0.2.1.
  %context = codex.pxml.org
  %compilation_id = a1b2c3d4-5e6f-7890-abcd-ef1234567890.
  %compiled_at = 2026-04-07T14:30:00Z.

  <defaults
    %model = claude-sonnet.
    %timeout = 30s.
    %on-failure = warn.
    %retry = 2.
    %structured_output = none.
    %output_schema = none.
    %fallback_model = none.
    %cache = off.
    %rate_limit = 10/min.
    %redact = [].
    %guard = none.
    %audit_log = false.
    %tool-inheritance = inherit.
  defaults>

  <state
    %pr_diff   : ^diff_schema.
    %findings  : ^findings_list.
    %review    : ^review_output.
  state>

  <capability
    %provides = [review:security, review:style, review:logic, review:synthesized].
    %accepts_in : ^diff_schema.
    %produces_out : ^review_output.
    %protocols = [ACP/1.0].
  capability>

  <pre
    <agent %name = fetch_context.
      %model = claude-sonnet.
      %depends_on = [].
      %timeout = 30s.
      %on-failure = warn.
      <drop-tool %name = github:*. drop-tool>
      <pick-tool %name = github:get_pr_diff. pick-tool>
      <pick-tool %name = github:get_repo_conventions. pick-tool>
      <intercept
        %validate_in = none.
        %validate_out = ^diff_schema.
        %retry = 2.
        %structured_output = none.
        %output_schema = none.
        %fallback_model = none.
        %cache = off.
        %rate_limit = 10/min.
        %redact = [].
        %guard = none.
        %audit_log = false.
        %timeout = 10s.
        %tool-order = [github:get_repo_conventions, github:get_pr_diff].
      intercept>
    agent>
  pre>

  <exec
    <plan %orchestration = parallel.

      <agent %name = security_scan.
        %model = claude-opus.
        %depends_on = [].
        %timeout = 30s.
        %on-failure = warn.
        <intercept
          %validate_in = none.
          %validate_out = ^findings_list.
          %retry = 3.
          %structured_output = json.
          %output_schema = json_schema.
          %fallback_model = none.
          %cache = off.
          %rate_limit = 10/min.
          %redact = [].
          %guard = block_if_hallucinated_cve.
          %audit_log = false.
        intercept>
        <prompt=
          Review this diff for security vulnerabilities.
          Focus on: injection, auth bypass, secret leakage.
          Cite exact line numbers from %pr_diff.
        =prompt>
      agent>

      <agent %name = style_check.
        %model = claude-haiku.
        %depends_on = [].
        %timeout = 30s.
        %on-failure = warn.
        <intercept
          %validate_in = none.
          %validate_out = ^findings_list.
          %retry = 2.
          %structured_output = none.
          %output_schema = none.
          %fallback_model = claude-sonnet.
          %cache = 1h.
          %rate_limit = 10/min.
          %redact = [].
          %guard = none.
          %audit_log = false.
        intercept>
      agent>

      <agent %name = logic_review.
        %model = claude-opus.
        %depends_on = [].
        %timeout = 30s.
        %on-failure = warn.
        <intercept
          %validate_in = none.
          %validate_out = ^findings_list.
          %retry = 2.
          %structured_output = none.
          %output_schema = none.
          %fallback_model = none.
          %cache = off.
          %rate_limit = 10/min.
          %redact = [#env_vars, #api_keys].
          %guard = none.
          %audit_log = false.
        intercept>
      agent>

    plan>

    <agent %name = synthesize.
      %model = claude-sonnet.
      %depends_on = [@security_scan, @style_check, @logic_review].
      %timeout = 30s.
      %on-failure = warn.
      <intercept
        %validate_in = ^findings_list.
        %validate_out = ^review_output.
        %retry = 2.
        %structured_output = json.
        %output_schema = json_schema.
        %fallback_model = none.
        %cache = off.
        %rate_limit = 10/min.
        %redact = [].
        %guard = none.
        %audit_log = false.
      intercept>
      <prompt=
        Synthesize findings from all three reviewers.
        Deduplicate, rank by severity, produce a single review.
        Keep the tone constructive — this ships to a human.
      =prompt>
    agent>
  exec>

  <post
    <agent %name = publish.
      %model = claude-sonnet.
      %depends_on = [].
      %timeout = 30s.
      %on-failure = warn.
      <pick-tool
          %name = hook:on-enter:lint.
          %on-failure : [halt, warn, skip, fallback] = halt.
      pick-tool>
      <pick-tool
          %name = hook:on-enter:typecheck.
          %on-failure : [halt, warn, skip, fallback] = halt.
      pick-tool>
      <pick-tool %name = github:post_review. pick-tool>
      <pick-tool %name = slack:notify_channel. pick-tool>
      <intercept
        %validate_in = none.
        %validate_out = none.
        %retry = 2.
        %structured_output = none.
        %output_schema = none.
        %fallback_model = none.
        %cache = off.
        %rate_limit = 1/min.
        %redact = [].
        %guard = none.
        %audit_log = true.
        %tool-order = [
          hook:on-enter:lint,
          hook:on-enter:typecheck,
          github:post_review,
          slack:notify_channel,
          hook:on-exit:typecheck,
          hook:on-exit:lint
        ].
      intercept>
      <drop-tool %name = hook:on-exit:typecheck. drop-tool>
      <drop-tool %name = hook:on-exit:lint. drop-tool>
    agent>
  post>

  <with
    <plugin %name = debug_trace. plugin>
    <plugin %name = timeout_budget. %max = 120s. plugin>
    <plugin %name = cost_ceiling. %max = $0.50. plugin>
  with>
pxml>
```


## 12. Full example (inline mode)

```
Review the PR at %pr_url for security issues.
Have @security_scan and @logic_review run in parallel,
and then @synthesize combines their output.

Validate all findings against ^findings_list.
Redact #env_vars and #api_keys before 'sending:to:LLM'.
Cap the run at $0.50 and 120s.

/dry-run this first so I can see the cost estimate.
```


---

## 13. Open questions

### 13.1 Numeric terminator ambiguity

`%amount = 3.50.` — greedy parsing reads `3.50` then `.` terminator. Needs exhaustive edge case testing in nimble_parsec.

### 13.2 SpaceCowboy integration depth

SpaceCowboy as a Datastar-native Elixir server could accept inline PXML via Datastar forms, compile it, and stream SSE events (`datastar-patch-elements` / `datastar-patch-signals`) as agents execute. The bulk-flow model maps naturally to SSE: each completed agent emits a patch. The integration depth — built-in vs. library — is an open design question that will depend on SpaceCowboy's own architecture.


---

## Appendix A: System defaults

When `<defaults>` is absent:

| Key | Default value |
|-----|---------------|
| `%model` | `claude-sonnet` |
| `%retry` | `2` |
| `%timeout` | `30s` |
| `%on-failure` | `warn` |
| `%structured_output` | `none` |
| `%output_schema` | `none` |
| `%tool-inheritance` | `inherit` |
| `%audit_log` | `false` |
| `%rate_limit` | `10/min` |
| `%cache` | `off` |
| `%redact` | `[]` |
| `%guard` | `none` |
| `%fallback_model` | `none` |


## Appendix B: Canonical interceptor pipeline

The Interceptor Extension executes managed plugins in this invariant order:

```
 1. Rate Limit          ← throttle
 2. Cache check         ← short-circuit if hit
 3. Redact              ← strip sensitive input
 4. Validate (in)       ← Gladius conform on input
 5. ── Node work ──     ← LLM call + tools (per %tool-order)
 6. Structured Output   ← parse LLM text → typed data
 7. Validate (out)      ← Gladius conform on output
 8. Guard               ← content safety
 9. Redact (restore)    ← re-hydrate sensitive fields
10. Cache store         ← memoize result

Retry wraps steps 3–9.
Fallback Model retries from step 5 with alternate model.
```


## Appendix C: Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-04-07 | 0.1.0-draft | Initial draft. |
| 2026-04-07 | 0.2.0-draft | Streaming model. Defaults. Interceptor as Extension. Persistence. Bridge. |
| 2026-04-07 | 0.2.1-draft | Bulk flow model (replaces streaming). CQRS/Event Sourcing (replaces CRUD tables). Canonical interceptor pipeline (fixes 13.3). Removed `[\|]` pipeline syntax. `<capability>` element for A2A. Explicit agent defaults in compiled output. CostReport and DiffView projections. GenStage buffer configuration. Commanded aggregate/router structure. |

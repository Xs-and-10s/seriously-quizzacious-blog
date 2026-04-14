# PXML Specification v2

**Plugin-Extension Markup Language**
Version: 0.2.0-draft
Status: Design phase — not yet implemented
Authors: Mark Manley, with design assistance from Claude (Anthropic)
Supersedes: PXML_SPEC.md v0.1.0-draft

---

## 1. Purpose

PXML is a streaming command language for describing AI agent pipelines. It exists in two modes that share one grammar:

- **Block mode** — a streaming document describing agents, tool scoping, interceptors, lifecycle phases, and prompts. This is what an orchestration engine (Phlox) executes incrementally as messages arrive.
- **Inline mode** — sigil-annotated natural language that a human writes inside a free-text prompt. A planning agent compiles inline PXML into block mode for execution. The compilation result is persisted for auditability, replay, and versioning.

PXML is designed to be:

- Streamable message-by-message — the parser emits partial ASTs as bookended elements close
- Readable by humans and parseable by LLMs without a formal parser
- Embeddable in free-text prompts as small annotated fragments
- Compilable into Phlox graph structs for execution
- Storable — every inline→block compilation is persisted with full provenance
- Framework-agnostic on the validation side — Gladius validates PXML schemas whether the downstream consumer is Phoenix, Bandit, SpaceCowboy, or bare Plug


---

## 2. Design principles

1. **Sigils are the parse hints.** Every structured element in inline mode is prefixed with a sigil that an LLM can extract without a parser. The sigils are deterministic; the natural language between them is interpreted by a planning agent.

2. **Block mode is the compilation target.** Inline mode is lossy by design — it captures intent, not structure. Block mode captures the full execution plan including explicit defaults for everything inline leaves implicit.

3. **Streaming first.** PXML is not a batch document. It is a sequence of messages, each containing one or more bookended elements. The parser emits AST nodes as elements close, enabling incremental execution. Phlox can begin executing `<pre>` while `<exec>` is still being streamed.

4. **Capability scoping, not capability binding.** Tools are not statically assigned to agents. They are picked into and dropped from a mutable toolbelt that flows through the document. The prompt decides what to actually invoke from the available set.

5. **The document is the scope.** Tool availability, interceptor configuration, and state typing are all lexically scoped by the document structure.

6. **Phlox is the runtime, PXML is the notation, Gladius is the contract.** PXML compiles into Phlox graph structs. Gladius validates data at every boundary. None of the three depend on each other — bridges connect them.

7. **The Interceptor is a specific Extension.** Extensions are persistent cross-cutting concerns. Plugins are ephemeral per-run concerns. The Interceptor is the Extension whose job is to manage plugin activation on individual nodes. There are not three parallel types — there are two types (Extension, Plugin) and a distinguished Extension (the Interceptor) that bridges them.

8. **Compilations are stored.** Every inline→block compilation is persisted with the original inline text, the compiled block document, the compiler's reasoning, timestamps, and a version identifier. This enables audit trails, replay, diffing between compilations, and rollback.


---

## 3. Architecture overview

### 3.1 Package topology

```
phlox           — graph execution engine (no PXML knowledge)
gladius          — validation/spec library (no Phlox knowledge)
pxml             — parser + compiler (depends on phlox + gladius)
pxml_store       — persistence layer (depends on pxml, uses Ecto/Postgres)
```

Optional framework bridges (separate packages):

```
gladius_phoenix  — Gladius integration for Phoenix controllers/channels
gladius_bandit   — Gladius integration for Bandit endpoints
gladius_plug     — Gladius integration for bare Plug pipelines
space_cowboy     — Datastar-native Elixir server with built-in Gladius validation
```

Gladius is the universal validator. It does not know about Phlox, PXML, Phoenix, or any server framework. Each bridge package adapts Gladius to a specific consumer. This means a Gladius schema defined once can validate:

- PXML state declarations (via `^ref` resolution)
- Phlox node input/output (via the Interceptor extension)
- Phoenix controller params (via `gladius_phoenix`)
- SpaceCowboy request bodies (via built-in integration)
- Raw maps in any Elixir application (via `Gladius.conform/2` directly)

### 3.2 The Extension / Plugin / Interceptor relationship

```
Extensions (persistent, cross-cutting)
├── Telemetry Extension
├── Audit Log Extension
├── Circuit Breaker Extension
├── Token Ledger Extension
└── Interceptor Extension          ← the distinguished one
    │
    │  manages plugin activation per-node
    │
    ├── Validate Plugin            (uses Gladius)
    ├── Retry Plugin
    ├── Fallback Model Plugin
    ├── Structured Output Plugin
    ├── Rate Limit Plugin
    ├── Redact Plugin
    ├── Cache Plugin
    └── Guard Plugin

Plugins (ephemeral, per-run)
├── Dry Run
├── Debug Trace
├── Timeout Budget
├── Cost Ceiling
└── Seed Pin
```

The Interceptor Extension is installed once on a Phlox graph. When a node declares `<intercept>` attributes, the Interceptor Extension reads those declarations and activates the corresponding plugins for that node's execution. The node says *what* it wants; the Interceptor provides the *how*.

Plugins managed by the Interceptor are distinct from run-level plugins in `<with>`. Interceptor-managed plugins fire per-node based on node declarations. Run-level plugins wrap the entire traversal.

### 3.3 Streaming model

PXML is a stream of messages. Each message contains one or more complete bookended elements. The parser processes the stream incrementally:

```
Message 1:  <pxml %ns = PXML:org:pxml:brain-trust. %version = 0.2.0.
Message 2:    <state %pr_diff : ^diff_schema. %findings : ^findings_list. state>
Message 3:    <pre <agent %name = fetch_context. ... agent> pre>
Message 4:    <exec ...
...
Message N:  pxml>
```

**Parser behavior:**

- The parser emits an AST node when a bookend closes (`element-name>`)
- Partial elements (open but not yet closed) are buffered
- Phlox can begin executing phase N while phase N+1 is still streaming
- The `<prompt= ... =prompt>` freetext mode switch is respected during streaming — the parser does not look for structure inside freetext blocks
- If the stream terminates before the root `pxml>` closes, the partial document is stored with status `incomplete`

**Why bookends matter for streaming:** With XML's `</tag>`, the parser needs the `/` to distinguish opening from closing. With PXML's `<tag ... tag>`, the parser sees the element name at both ends — if it matches the currently open element, it's a close. This is unambiguous even in a token-by-token stream.


---

## 4. Sigil table

| Sigil | Name | Meaning | Example |
|-------|------|---------|---------|
| `%` | Attribute | Metadata key on an element | `%name = fetch_context.` |
| `^` | Spec ref | Gladius registry lookup (type/schema) | `^findings_list` |
| `@` | Mention | Agent or human reference | `@security_scan` |
| `#` | Tag | Label, category, or redaction target | `#env_vars` |
| `/` | Command | Imperative action (plugin invocation) | `/dry-run` |
| `.` | Terminator | Ends a value | `%timeout = 10s.` |
| `=` | Assignment | Binds a value to an attribute | `%model = claude-opus.` |
| `:` | Type annotation | Declares a type constraint | `%pr_diff : ^diff_schema.` |
| `~~` | Comment | Bookended comment (ignored by parser) | `~~ this is a note ~~` |
| `[,]` | List | Ordered collection | `[#env_vars, #api_keys]` |
| `[\|]` | Pipeline | Ordered execution stages | `[%validate_in \| %structured_output \| %validate_out]` |
| `'...'` | Literal | Escapes sigil parsing in inline mode | `'sending:to:LLM'` |

### Sigil precedence in inline mode

When parsing inline PXML from free text, sigils are extracted in this order:

1. `/command` — imperative, highest priority
2. `@mention` — agent/human references
3. `^spec` — type/schema references
4. `#tag` — labels and categories
5. `%attribute` — contextual metadata

Natural language between sigils is interpreted by the compiling agent.


---

## 5. Syntax

### 5.1 Elements (bookended)

Elements use symmetric bookend closing:

```
<element-name ... element-name>
```

The opening tag begins with `<` followed by the element name. The closing uses the element name followed by `>`. The word at both ends is the same.

**Single-line elements:**

```
<pick-tool %name = github:get_pr_diff. pick-tool>
```

**Multi-line elements:**

```
<agent %name = synthesize.
  %model = claude-sonnet.
  <intercept
    %validate_out = ^review_output.
  intercept>
agent>
```

### 5.2 Attributes

Attributes are prefixed with `%` and terminated with `.`:

```
%name = fetch_context.
%model = claude-opus.
%retry = 3.
```

**Inline type annotations** use `:` between the attribute name and `=`:

```
%on-failure : [halt, warn, skip, fallback] = halt.
%timeout : duration = 10s.
%retry : int(gte: 0) = 3.
```

The type annotation is optional. When present, it declares a Gladius-compatible constraint that can be validated at parse time or runtime.

### 5.3 Values

Values follow `=` and are terminated by `.`:

- **Atoms:** `halt.` `true.` `json.`
- **Numbers:** `3.` `0.50.` — the parser reads the longest valid numeric literal before the final terminator
- **Durations:** `10s.` `1h.` `120s.` `500ms.` `1/min.`
- **Currency:** `$0.50.`
- **Strings:** Unquoted when unambiguous. Single-quoted `'like:this'` when the value contains sigil-active characters.
- **Lists:** `[a, b, c].` — comma-separated, bracket-delimited
- **Pipelines:** `[a | b | c].` — pipe-separated, bracket-delimited, denotes ordered execution flow
- **Spec refs:** `^schema_name.` — resolved via Gladius registry
- **Agent refs:** `[@agent_a, @agent_b].` — references to named agents
- **Tag refs:** `[#env_vars, #api_keys].` — references to named tags
- **Globs:** `github:*.` — namespace wildcard (used in tool scoping)

### 5.4 Freetext blocks (mode switch)

The `<tag= ... =tag>` syntax switches the parser into literal mode:

```
<prompt=
  Review this diff for security vulnerabilities.
  Cite exact line numbers from %pr_diff.
=prompt>
```

Everything between the `=` bookends is literal content except `%name` interpolation of state variables. All other sigils are treated as text.

Any element can use this form: `<system= ... =system>`, `<context= ... =context>`.

### 5.5 Comments

```
~~ this is a comment ~~
```

Comments are ignored by the parser. They do not nest.

### 5.6 Namespaces

```
<pxml %ns = PXML:org:pxml:brain-trust.
```

Reverse-domain, colon-separated. Serves as a capability address in A2A contexts.


---

## 6. Elements

### 6.1 Root: `<pxml>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%ns` | Yes | Reverse-domain namespace |
| `%version` | Yes | PXML spec version this document conforms to |
| `%context` | No | URL to external schema/documentation |
| `%compiled_from` | No | Reference to the inline source that produced this document (set by compiler) |
| `%compiled_at` | No | ISO 8601 timestamp of compilation |
| `%compilation_id` | No | UUID linking to the stored compilation record |

Children: `<defaults>`, `<state>`, `<pre>`, `<exec>`, `<post>`, `<with>`

### 6.2 Defaults: `<defaults>`

**New in v2.** Declares explicit values for everything inline mode leaves implicit. When a planning agent compiles inline→block, it fills this section based on system policy. This makes the compiled document fully self-describing — no hidden assumptions.

```
<defaults
  %model = claude-sonnet.
  %retry : int(gte: 0) = 2.
  %timeout : duration = 30s.
  %on-failure : [halt, warn, skip, fallback] = warn.
  %structured_output = json.
  %output_schema = json_schema.
  %tool-inheritance = inherit.
  %audit_log = false.
  %rate_limit = 10/min.
  %cache = off.
  %redact = [].
  %guard = none.
  %fallback_model = none.
defaults>
```

**Semantics:** An agent that does not explicitly set an attribute inherits the value from `<defaults>`. If `<defaults>` is absent, the PXML runtime uses hardcoded system defaults (documented in Appendix A).

**`%tool-inheritance`** resolves open question 8.1 from v1:

- `inherit` — child agents inherit their parent's toolbelt (default)
- `empty` — child agents start with an empty toolbelt and must pick explicitly

The default is `inherit` because most pipelines want tools to flow downward. Security-sensitive pipelines set `%tool-inheritance = empty.` and use the deny-all-allow-some pattern on every agent.

### 6.3 State: `<state>`

Declares typed shared state accessible to all agents. Each entry is a `%`-prefixed attribute with a `:` type annotation referencing a Gladius spec:

```
<state
  %pr_diff   : ^diff_schema.
  %findings  : ^findings_list.
  %review    : ^review_output.
state>
```

State variables can be interpolated inside `<prompt= ... =prompt>` blocks using `%name`.

**Validation:** At compilation time, `^ref` names are resolved against the Gladius registry. If a ref cannot be resolved, the compiler emits a warning (not an error — the spec may be registered at runtime). At execution time, every state read/write is validated by Gladius via the Interceptor Extension.

### 6.4 Lifecycle phases: `<pre>`, `<exec>`, `<post>`

Three phases borrowed from PocketFlow:

- **`<pre>`** — Setup. Fetch context, establish tool availability, validate preconditions.
- **`<exec>`** — Core work. The agent graph that performs the task. May contain `<plan>` blocks.
- **`<post>`** — Teardown. Publish results, clean up resources, fire notifications.

**Streaming behavior:** The parser emits `<pre>` as a complete AST node when `pre>` closes. Phlox begins executing pre immediately. If `<exec>` is still being streamed, Phlox buffers until `exec>` closes (or, for `<plan %orchestration = sequential.>`, begins executing the first agent as soon as it closes).

### 6.5 Agent: `<agent>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Unique identifier within the document |
| `%model` | No | LLM model (inherits from `<defaults>` if unset) |
| `%depends_on` | No | List of `@agent` mentions that must complete first |

Children: `<pick-tool>`, `<drop-tool>`, `<intercept>`, `<prompt=>`, `<system=>`

### 6.6 Plan: `<plan>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%orchestration` | Yes | `parallel`, `sequential`, `race`, `round-robin` |

### 6.7 Tool scoping: `<pick-tool>`, `<drop-tool>`

These manage the agent's capability set — what tools are available, not what tools are invoked.

**`<pick-tool>`** — adds a tool or namespace to the toolbelt.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Tool identifier or glob pattern |
| `%on-failure` | No | `halt`, `warn`, `skip`, `fallback`. Default from `<defaults>` |

**`<drop-tool>`** — removes a tool or namespace from the toolbelt.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Tool identifier or glob pattern |

**Scoping rules:**

1. Tool inheritance direction is set by `%tool-inheritance` in `<defaults>`.
2. `<drop-tool>` with a glob clears an entire namespace.
3. `<pick-tool>` after a glob drop creates a whitelist (deny-all, allow-some).
4. In the post phase, pick/drop ordering is significant — it defines a LIFO lifecycle stack.

**The deny-all, allow-some pattern (security sandboxing):**

```
<drop-tool %name = github:*. drop-tool>
<pick-tool %name = github:get_pr_diff. pick-tool>
```

**The lifecycle stack pattern (resource management):**

```
<pick-tool %name = hook:on-enter:lint. %on-failure = halt. pick-tool>
<pick-tool %name = hook:on-enter:typecheck. %on-failure = halt. pick-tool>
  ... agent executes, prompt decides what to invoke ...
<drop-tool %name = hook:on-exit:typecheck. drop-tool>
<drop-tool %name = hook:on-exit:lint. drop-tool>
```

### 6.8 Intercept: `<intercept>`

Declares per-node plugin activation via the Interceptor Extension. The Interceptor Extension reads these declarations and activates the corresponding plugins for the enclosing agent.

```
<intercept
  %validate_out = ^findings_list.
  %retry = 3.
  %structured_output = json.
intercept>
```

Every attribute that is not explicitly set inherits from `<defaults>`.

**Interceptor-managed plugin keys:**

| Key | Value type | Plugin activated | Description |
|-----|-----------|-----------------|-------------|
| `%validate` | Spec ref | Validate | Validates both input and output |
| `%validate_in` | Spec ref | Validate | Validates node input only |
| `%validate_out` | Spec ref | Validate | Validates node output only |
| `%retry` | Integer | Retry | Max attempts with exponential backoff |
| `%structured_output` | Format name | Structured Output | Parses LLM output into typed data |
| `%output_schema` | Spec ref or format | Structured Output | Schema for parsing |
| `%fallback_model` | Model name | Fallback Model | Re-execute with alternate model on failure |
| `%cache` | Duration or `off` | Cache | Per-node memoization TTL |
| `%rate_limit` | Rate expression | Rate Limit | Token bucket throttle |
| `%redact` | Tag list | Redact | Strip tagged fields before LLM call |
| `%guard` | Guard name or `none` | Guard | Content safety filter on output |
| `%audit_log` | Boolean | (Extension, not plugin) | Delegates to Audit Log Extension directly |
| `%timeout` | Duration | (Extension, not plugin) | Delegates to timeout handling |
| `%tool-order` | List or Pipeline | — | Execution ordering (see below) |

Note that `%audit_log` and `%timeout` are not Interceptor-managed plugins — they delegate to standalone Extensions. The `<intercept>` block is the declaration site for all per-node concerns, whether they route through the Interceptor Extension or directly to other Extensions.

**Tool ordering (`%tool-order`):**

List form — explicit tool invocation order:
```
%tool-order = [github:get_repo_conventions, github:get_pr_diff].
```

Pipeline form — interceptor stage ordering using `|`:
```
%tool-order = [%validate_in | %structured_output | %output_schema | %validate_out].
```

The `|` denotes "flows into." The `,` denotes unordered collection.

### 6.9 Prompt and system: `<prompt=>`, `<system=>`

Freetext blocks using the `=` mode switch:

```
<prompt=
  Review this diff for security vulnerabilities.
  Cite exact line numbers from %pr_diff.
=prompt>

<system=
  You are a senior security engineer.
  Be thorough but constructive.
=system>
```

**Interpolation:** `%name` interpolates state variable values. All other sigils are literal text inside freetext blocks.

**Interpolation depth:** Flat only. `%name` resolves to the state variable's value. Nested access (`%name.field`) and piped transforms (`%name | fn`) are not supported in prompt interpolation. Complex data shaping belongs in the interceptor pipeline.

### 6.10 With: `<with>`

Declares run-level ephemeral plugins scoped to this entire execution:

```
<with
  <plugin %name = debug_trace. plugin>
  <plugin %name = timeout_budget. %max = 120s. plugin>
  <plugin %name = cost_ceiling. %max = $0.50. plugin>
with>
```

These plugins wrap the entire pipeline (all phases). They are distinct from interceptor-managed plugins, which fire per-node.

### 6.11 Plugin: `<plugin>`

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Plugin identifier |
| (additional) | No | Plugin-specific configuration |


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

Sigils are deterministically extractable from any text:

| Sigil | Pattern | Extraction |
|-------|---------|------------|
| `/` | `/word` at start of line or after whitespace | Command |
| `@` | `@word` | Agent/human mention |
| `^` | `^word` | Spec ref |
| `#` | `#word` | Tag |
| `%` | `%word` | State variable reference |
| `$` | `$N.NN` | Currency value |
| `Ns/Nh/Nm` | Number followed by time unit | Duration |
| `'...'` | Single-quoted span | Literal (sigils not parsed inside) |

Words are sequences of `[a-zA-Z0-9_-]`. Sigils must be preceded by whitespace or start-of-line.

### 7.3 Compilation

Inline → block compilation is performed by a planning agent (LLM).

**Deterministic (regex-extractable):**
- Agent names, spec refs, tags, commands, state refs, numeric values with units

**Requires LLM interpretation:**
- Parallel vs. sequential ("run in parallel" / "then" / "and then")
- Phase assignment (pre/exec/post)
- Validation direction (in/out/both)
- Interceptor-to-agent mapping
- Model selection

**Filled from system defaults (not expressible inline):**
- Everything in `<defaults>`
- Hook lifecycle ordering (pick/drop stacks)
- Tool-order pipelines

### 7.4 Compilation storage

Every compilation is persisted. See section 9.


---

## 8. Compilation target

PXML block mode compiles into Phlox graph structs:

| PXML element | Phlox struct / concept |
|-------------|------------------------|
| `<pxml>` | `%Phlox.Graph{}` |
| `<defaults>` | Default config on graph |
| `<state>` | Typed shared state (V2.8) |
| `<pre>` / `<exec>` / `<post>` | Phase groupings in graph |
| `<agent>` | `%Phlox.Node{}` |
| `<plan>` | Parallel/sequential subgraph |
| `<intercept>` | Interceptor Extension declarations on node |
| `<pick-tool>` / `<drop-tool>` | Tool scope mutations on node |
| `<prompt=>` / `<system=>` | Prompt template fields on node |
| `<with>` | Plugin list passed to `Phlox.run/2` |
| `<plugin>` | Plugin struct |
| `^spec_ref` | `Gladius.Registry.fetch!/1` call |

### The Gladius–Phlox bridge

The bridge is `Phlox.Extensions.Interceptor`, which:

1. Is installed once on a Phlox graph as an Extension
2. Reads `<intercept>` declarations from each node at traversal time
3. Activates the corresponding plugins for that node's execution
4. For validation plugins, calls `Gladius.conform/2` with the resolved `^ref` schema
5. Routes non-plugin concerns (`%audit_log`, `%timeout`) to their respective Extensions

The bridge package (`phlox_gladius` or built into `pxml`) depends on both `phlox` and `gladius`. Neither `phlox` nor `gladius` depends on the bridge.

```
phlox  ←── phlox_gladius ──→  gladius
              ↑
             pxml (uses the bridge during compilation)
```


---

## 9. Persistence layer

### 9.1 Storage schema (Postgres)

```sql
CREATE TABLE pxml_compilations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version         SMALLINT NOT NULL DEFAULT 1,

    -- Source
    inline_text     TEXT,
    inline_sigils   JSONB NOT NULL,

    -- Compiled output
    block_text      TEXT NOT NULL,
    block_ast       JSONB NOT NULL,

    -- Compiler provenance
    compiler_model  VARCHAR(100),
    compiler_reasoning TEXT,
    system_defaults JSONB NOT NULL,

    -- Graph binding
    phlox_graph_id  UUID,
    namespace       VARCHAR(500) NOT NULL,

    -- Status
    status          VARCHAR(20) NOT NULL DEFAULT 'compiled'
                    CHECK (status IN (
                        'compiled',
                        'executing',
                        'completed',
                        'failed',
                        'incomplete'
                    )),

    -- Lifecycle
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at     TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- Lineage
    parent_id       UUID REFERENCES pxml_compilations(id),
    revision        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_pxml_compilations_ns ON pxml_compilations(namespace);
CREATE INDEX idx_pxml_compilations_status ON pxml_compilations(status);
CREATE INDEX idx_pxml_compilations_parent ON pxml_compilations(parent_id);
CREATE INDEX idx_pxml_compilations_created ON pxml_compilations(created_at DESC);
```

### 9.2 Field semantics

| Field | Description |
|-------|-------------|
| `inline_text` | The original free-text prompt (null if authored directly in block mode) |
| `inline_sigils` | Extracted sigils as structured JSON: `{"mentions": ["@a"], "refs": ["^b"], ...}` |
| `block_text` | The compiled PXML block-mode document as text |
| `block_ast` | The parsed AST as JSON (for programmatic access without re-parsing) |
| `compiler_model` | Which LLM performed the inline→block compilation |
| `compiler_reasoning` | The compiler's explanation of its decisions (model selection, phase assignment, default choices) |
| `system_defaults` | Snapshot of the `<defaults>` values used at compilation time |
| `phlox_graph_id` | UUID of the Phlox graph struct produced from this compilation |
| `namespace` | The `%ns` value from the document root |
| `status` | Lifecycle state: compiled → executing → completed/failed. `incomplete` if the stream terminated before `pxml>` closed |
| `parent_id` | Points to the previous compilation this one revises (for version chains) |
| `revision` | Monotonically increasing revision number within a parent chain |

### 9.3 Execution trace table

```sql
CREATE TABLE pxml_execution_traces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compilation_id  UUID NOT NULL REFERENCES pxml_compilations(id),

    -- Per-node trace
    agent_name      VARCHAR(200) NOT NULL,
    phase           VARCHAR(10) NOT NULL CHECK (phase IN ('pre', 'exec', 'post')),

    -- Tool lifecycle
    tools_picked    JSONB NOT NULL DEFAULT '[]',
    tools_invoked   JSONB NOT NULL DEFAULT '[]',
    tools_dropped   JSONB NOT NULL DEFAULT '[]',

    -- Interceptor results
    interceptor_results JSONB NOT NULL DEFAULT '{}',

    -- Execution data
    input_hash      VARCHAR(64),
    output_hash     VARCHAR(64),
    model_used      VARCHAR(100),
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    duration_ms     INTEGER,
    error           TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pxml_traces_compilation ON pxml_execution_traces(compilation_id);
CREATE INDEX idx_pxml_traces_agent ON pxml_execution_traces(agent_name);
```

This table records what actually happened during execution: which tools were picked, which were actually invoked (the prompt's decisions), which were dropped, and what each interceptor-managed plugin produced. It answers the question: "given the possibility space declared in PXML, what did the agent actually do?"


---

## 10. Grammar implementation

### 10.1 nimble_parsec

The PXML parser should be implemented as an Elixir library using `nimble_parsec`. Key design considerations:

**Incremental emission:** The parser should be structured as a streaming tokenizer that emits AST nodes as bookend elements close. This requires a stack-based approach where opening tags push onto the stack and closing bookends pop and emit.

**Freetext mode:** The `<tag= ... =tag>` mode switch must suppress all PXML parsing inside the freetext block except `%name` interpolation. The parser enters literal mode when it encounters `<identifier=` and exits when it encounters `=identifier>`.

**Grammar sketch (pseudo-parsec):**

```
document       = element*
element        = open_tag content close_tag | freetext_element
open_tag       = "<" identifier attribute*
close_tag      = identifier ">"
freetext_element = "<" identifier "=" freetext_body "=" identifier ">"
attribute      = "%" identifier (":" type_expr)? "=" value "."
               | "%" identifier ":" type_ref "."
value          = atom | number | duration | currency | string
               | list | pipeline | spec_ref | agent_ref | tag_ref | glob
list           = "[" value ("," value)* "]"
pipeline       = "[" value ("|" value)* "]"
spec_ref       = "^" identifier
agent_ref      = "@" identifier
tag_ref        = "#" identifier
comment        = "~~" text "~~"
```

### 10.2 Tree-sitter

A Tree-sitter grammar enables PXML syntax highlighting and structural navigation in editors (Neovim, VS Code, Monologue, Helix). The Tree-sitter grammar should mirror the nimble_parsec grammar but target incremental reparsing for editor use.

Key Tree-sitter concerns:

- Error recovery: partial PXML in a prompt should highlight correctly even if the document is incomplete
- Injection: PXML inside markdown code fences (` ```pxml `) should activate the PXML grammar
- Freetext blocks should fall back to the host language's highlighting (or plain text)

The Tree-sitter grammar is a separate deliverable from the nimble_parsec parser.


---

## 11. Full example (block mode)

```
<pxml %ns = PXML:org:pxml:brain-trust.
  %version = 0.2.0.
  %context = codex.pxml.org
  %compiled_from = c9f3a1b2-7e4d-4f8a-b5c6-d8e9f0a1b2c3.
  %compiled_at = 2026-04-07T14:30:00Z.
  %compilation_id = a1b2c3d4-5e6f-7890-abcd-ef1234567890.

  <defaults
    %model = claude-sonnet.
    %retry = 2.
    %timeout = 30s.
    %on-failure = warn.
    %structured_output = json.
    %output_schema = json_schema.
    %tool-inheritance = inherit.
    %audit_log = false.
    %rate_limit = 10/min.
    %cache = off.
    %redact = [].
    %guard = none.
    %fallback_model = none.
  defaults>

  <state
    %pr_diff   : ^diff_schema.
    %findings  : ^findings_list.
    %review    : ^review_output.
  state>

  <pre
    <agent
      %name = fetch_context.
      %model = claude-sonnet.
      <drop-tool %name = github:*. drop-tool>
      <pick-tool %name = github:get_pr_diff. pick-tool>
      <pick-tool %name = github:get_repo_conventions. pick-tool>
      <intercept
        %validate = ^diff_schema.
        %timeout = 10s.
        %tool-order = [github:get_repo_conventions, github:get_pr_diff].
      intercept>
    agent>
  pre>

  <exec
    <plan %orchestration = parallel.

      <agent
        %name = security_scan.
        %model = claude-opus.
        <intercept
          %validate_out = ^findings_list.
          %retry = 3.
          %structured_output = json.
          %output_schema = json_schema.
          %guard = block_if_hallucinated_cve.
        intercept>
        <prompt=
          Review this diff for security vulnerabilities.
          Focus on: injection, auth bypass, secret leakage.
          Cite exact line numbers from %pr_diff.
        =prompt>
      agent>

      <agent
        %name = style_check.
        %model = claude-haiku.
        <intercept
          %validate_out = ^findings_list.
          %fallback_model = claude-sonnet.
          %cache = 1h.
        intercept>
      agent>

      <agent %name = logic_review.
        %model = claude-opus.
        <intercept
          %validate_out = ^findings_list.
          %retry = 2.
          %redact = [#env_vars, #api_keys].
        intercept>
      agent>

    plan>

    <agent %name = synthesize.
      %model = claude-sonnet.
      %depends_on = [@security_scan, @style_check, @logic_review].
      <intercept
        %validate_in = ^findings_list.
        %validate_out = ^review_output.
        %structured_output = json.
        %output_schema = json_schema.
        %tool-order = [%validate_in | %structured_output | %output_schema | %validate_out].
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
        %audit_log = true.
        %rate_limit = 1/min.
        %tool-order = [
          hook:on-enter:lint,
          hook:on-enter:typecheck,
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

`%amount = 3.50.` — is that `3.50` terminated by `.`, or `3` terminated by `.` followed by `50.`? Resolution: the parser is greedy, reads the longest valid numeric literal before the final `.` terminator. Edge cases need exhaustive testing in the nimble_parsec grammar.

### 13.2 A2A capability advertisement

PXML describes what an agent consumes. It does not yet describe what an agent exposes. A `<capability>` element or separate advertisement format may be needed for A2A discovery.

### 13.3 Interceptor vs. tool-order unification

When `%tool-order` includes both interceptor stages and tool names, the execution semantics are a superset of interceptor ordering. This unifies the concepts but adds complexity. Needs implementation-level validation.

### 13.4 SpaceCowboy integration depth

SpaceCowboy (Datastar-native Elixir server) should support PXML natively — e.g., a SpaceCowboy endpoint that accepts inline PXML via a Datastar form, compiles it, and streams SSE events as agents execute. The integration depth (built-in vs. library) is an open design question.


---

## Appendix A: System defaults

When `<defaults>` is absent, these hardcoded values apply:

| Key | Default value |
|-----|---------------|
| `%model` | `claude-sonnet` |
| `%retry` | `2` |
| `%timeout` | `30s` |
| `%on-failure` | `warn` |
| `%structured_output` | `json` |
| `%output_schema` | `json_schema` |
| `%tool-inheritance` | `inherit` |
| `%audit_log` | `false` |
| `%rate_limit` | `10/min` |
| `%cache` | `off` |
| `%redact` | `[]` |
| `%guard` | `none` |
| `%fallback_model` | `none` |


---

## Appendix B: Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-04-07 | 0.1.0-draft | Initial draft. Sigil table, elements, inline/block modes. |
| 2026-04-07 | 0.2.0-draft | Streaming model. `<defaults>` element. Interceptor as distinguished Extension. Persistence schema. Gladius-Phlox bridge. nimble_parsec/Tree-sitter grammar notes. SpaceCowboy integration. Compilation provenance attributes. Execution trace table. |

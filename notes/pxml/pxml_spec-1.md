# PXML Specification

**Plugin-Extension Markup Language**
Version: 0.1.0-draft
Status: Design phase — not yet implemented
Authors: Mark Manley, with design assistance from Claude (Anthropic)

---

## 1. Purpose

PXML is a structured command language for describing AI agent pipelines. It exists in two modes that share one grammar:

- **Block mode** — a full document describing agents, tool scoping, interceptors, lifecycle phases, and prompts. This is what an orchestration engine (Phlox) executes.
- **Inline mode** — sigil-annotated natural language that a human writes inside a free-text prompt. A planning agent compiles inline PXML into block mode for execution.

PXML is designed to be:

- Readable by humans and parseable by LLMs without a formal parser
- Embeddable in free-text prompts as small annotated fragments
- Compilable into Phlox graph structs for execution
- Expressive enough for ACP (Agent Communication Protocol) and A2A (Agent-to-Agent) messaging

PXML is not XML. It borrows angle-bracket delimiters but uses symmetric bookend closing, sigil-prefixed attributes, dot-terminated values, and a freetext mode switch that XML cannot express.


---

## 2. Design principles

1. **Sigils are the parse hints.** Every structured element in inline mode is prefixed with a sigil that an LLM can extract without a parser. The sigils are deterministic; the natural language between them is interpreted by a planning agent.

2. **Block mode is the compilation target.** Inline mode is lossy by design — it captures intent, not structure. Block mode captures the full execution plan. The compilation step is where human intent meets machine precision.

3. **Capability scoping, not capability binding.** Tools are not statically assigned to agents. They are picked into and dropped from a mutable toolbelt that flows through the document. The prompt decides what to actually invoke from the available set.

4. **The document is the scope.** Tool availability, interceptor configuration, and state typing are all lexically scoped by the document structure. A child element inherits its parent's context unless explicitly narrowed.

5. **Phlox is the runtime, PXML is the notation.** PXML compiles into Phlox graph structs. Phlox never depends on PXML. Someone who prefers Elixir DSL over PXML markup uses the same execution engine.


---

## 3. Sigil table

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
| `[|]` | Pipeline | Ordered execution stages | `[%validate_in \| %structured_output \| %validate_out]` |
| `'...'` | Literal | Escapes sigil parsing in inline mode | `'sending:to:LLM'` |
| `"""` | Heredoc | Freetext block (deprecated by `<tag= =tag>`) | — |

### Sigil precedence in inline mode

When parsing inline PXML from free text, sigils are extracted in this order:

1. `/command` — imperative, highest priority
2. `@mention` — agent/human references
3. `^spec` — type/schema references
4. `#tag` — labels and categories
5. `%attribute` — contextual metadata

Natural language between sigils is interpreted by the compiling agent using the surrounding sigils as structural hints.


---

## 4. Syntax

### 4.1 Elements (bookended)

Elements use symmetric bookend closing:

```
<element-name ... element-name>
```

The opening tag begins with `<` followed by the element name. The closing uses the element name followed by `>`. This is visually scannable and unambiguous — the word at both ends is the same.

**Single-line elements** may be self-contained:

```
<pick-tool %name = github:get_pr_diff. pick-tool>
```

**Multi-line elements** nest freely:

```
<agent %name = synthesize.
  %model = claude-sonnet.
  <intercept
    %validate_out = ^review_output.
  intercept>
agent>
```

### 4.2 Attributes

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

The type annotation is optional. When present, it declares a constraint that can be validated (via Gladius) at parse time or runtime. When absent, the value is untyped.

### 4.3 Values

Values follow `=` and are terminated by `.`:

- **Atoms:** `halt.` `true.` `json.`
- **Numbers:** `3.` `0.50.` (note: the final `.` is the terminator, not a decimal — context disambiguates because PXML values are always terminated)
- **Durations:** `10s.` `1h.` `120s.` `1/min.`
- **Currency:** `$0.50.`
- **Strings:** Unquoted when unambiguous. Single-quoted `'like:this'` when the value contains sigil-active characters.
- **Lists:** `[a, b, c].` — comma-separated, bracket-delimited
- **Pipelines:** `[a | b | c].` — pipe-separated, bracket-delimited, denotes ordered execution flow
- **Spec refs:** `^schema_name.` — resolved via Gladius registry
- **Agent refs:** `[@agent_a, @agent_b].` — references to named agents
- **Tag refs:** `[#env_vars, #api_keys].` — references to named tags
- **Globs:** `github:*.` — namespace wildcard (used in tool scoping)

### 4.4 Freetext blocks

The `<tag= ... =tag>` syntax switches the parser into literal mode. Everything between the `=` bookends is treated as raw content, not parsed as PXML — except for `%` interpolation of state variables.

```
<prompt=
  Review this diff for security vulnerabilities.
  Focus on: injection, auth bypass, secret leakage.
  Cite exact line numbers from %pr_diff.
=prompt>
```

This is PXML's equivalent of CDATA, but native to the bookend grammar. Any element can use this form when its content is freetext:

```
<system=
  You are a senior security engineer reviewing pull requests.
  Be thorough but constructive.
=system>
```

The `=` on the opening tag and closing tag is the mode switch. Without it, child content is parsed as PXML structure. With it, child content is literal.

### 4.5 Comments

Comments use bookended tildes:

```
~~ this is a comment ~~
```

Comments are ignored by the parser. They do not nest.

### 4.6 Namespaces

The `%ns` attribute on the root `<pxml>` element declares a reverse-domain namespace:

```
<pxml %ns = PXML:org:pxml:brain-trust.
```

Namespaces use `:` as the separator (not `.` which is the value terminator). They serve as capability addresses in A2A contexts — an agent can advertise its namespace for discovery.


---

## 5. Elements

### 5.1 Root: `<pxml>`

The document root. Attributes:

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%ns` | Yes | Reverse-domain namespace |
| `%version` | Yes | PXML spec version |
| `%context` | No | URL to external schema/documentation |

Children: `<state>`, `<pre>`, `<exec>`, `<post>`, `<with>`

### 5.2 State: `<state>`

Declares typed shared state accessible to all agents in the document. Each entry is an attribute with a type annotation referencing a Gladius spec:

```
<state
  %pr_diff   : ^diff_schema.
  %findings  : ^findings_list.
  %review    : ^review_output.
state>
```

State variables can be interpolated inside `<prompt= ... =prompt>` blocks using `%name`.

**Scoping:** State is document-global. All agents read from and write to the same shared state. Phlox V2.8's typed shared state is the compilation target.

### 5.3 Lifecycle phases: `<pre>`, `<exec>`, `<post>`

Borrowed from PocketFlow. These structure the agent pipeline into three phases:

- **`<pre>`** — Setup. Fetch context, establish tool availability, validate preconditions. Runs once before execution.
- **`<exec>`** — Core work. The agent graph that performs the task. May contain `<plan>` blocks for parallel/sequential orchestration.
- **`<post>`** — Teardown. Publish results, clean up resources, fire notifications. Runs once after execution.

Each phase contains one or more `<agent>` elements.

### 5.4 Agent: `<agent>`

A single node in the pipeline. Attributes:

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Unique identifier within the document |
| `%model` | No | LLM model to use (inherits from parent if unset) |
| `%depends_on` | No | List of agent mentions that must complete first |

Children: `<pick-tool>`, `<drop-tool>`, `<intercept>`, `<prompt=>`, `<system=>`

### 5.5 Plan: `<plan>`

Groups agents under an orchestration strategy:

```
<plan %orchestration = parallel.
  <agent %name = a. agent>
  <agent %name = b. agent>
  <agent %name = c. agent>
plan>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%orchestration` | Yes | `parallel`, `sequential`, `race`, `round-robin` |

Agents inside a `<plan>` with `%orchestration = parallel` run concurrently. The enclosing phase waits for all to complete before proceeding.

### 5.6 Tool scoping: `<pick-tool>`, `<drop-tool>`

These manage the agent's **capability set** — what tools are available, not what tools are invoked. The prompt decides invocation; pick/drop decide possibility.

```
<drop-tool %name = github:*. drop-tool>
<pick-tool %name = github:get_pr_diff. pick-tool>
```

**`<pick-tool>`** — adds a tool (or tool namespace) to the agent's toolbelt.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Tool identifier or glob pattern |
| `%on-failure` | No | `halt`, `warn`, `skip`, or `fallback`. Default: `halt` |

The `%on-failure` attribute controls what happens when the tool cannot be made available (server down, auth expired, MCP connection failed). This is a precondition check on capability, not an execution retry.

**`<drop-tool>`** — removes a tool (or tool namespace) from the agent's toolbelt.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Tool identifier or glob pattern |

**Scoping rules:**

1. An agent inherits its parent's toolbelt by default.
2. `<drop-tool>` with a glob (`github:*`) clears an entire namespace.
3. `<pick-tool>` after a glob drop creates a whitelist (deny-all, allow-some).
4. Tool availability flows downward through nesting. A drop at a parent level affects all children unless they re-pick.
5. In the post phase, pick/drop ordering within an agent is significant — it defines a lifecycle stack (LIFO for cleanup).

**The deny-all, allow-some pattern:**

```
<drop-tool %name = github:*. drop-tool>
<pick-tool %name = github:get_pr_diff. pick-tool>
<pick-tool %name = github:get_repo_conventions. pick-tool>
```

This is a security primitive: the agent can only see two specific github tools, nothing else from that namespace. Tool sandboxing is expressed in document structure.

**The lifecycle stack pattern (post phase):**

```
<pick-tool %name = hook:on-enter:lint. %on-failure = halt. pick-tool>
<pick-tool %name = hook:on-enter:typecheck. %on-failure = halt. pick-tool>
  ... agent runs ...
<drop-tool %name = hook:on-exit:typecheck. drop-tool>
<drop-tool %name = hook:on-exit:lint. drop-tool>
```

This is `try`/`after` expressed as document structure. The LIFO ordering ensures cleanup runs in reverse acquisition order.

### 5.7 Intercept: `<intercept>`

Declares interceptor configuration for the enclosing agent. Interceptors are harness concerns that fire per-node — the agent opts in by declaring them.

```
<intercept
  %validate_out = ^findings_list.
  %retry = 3.
  %structured_output = json.
  %guard = block_if_hallucinated_cve.
intercept>
```

Inside `<intercept>`, every line is a key-value pair. The `%` prefix is retained for consistency with the rest of the grammar.

**Known interceptor keys:**

| Key | Value type | Description |
|-----|-----------|-------------|
| `%validate` | Spec ref | Validates both input and output |
| `%validate_in` | Spec ref | Validates node input only |
| `%validate_out` | Spec ref | Validates node output only |
| `%retry` | Integer | Max retry attempts with exponential backoff |
| `%structured_output` | `json`, `xml`, `custom` | Parses LLM output into typed data |
| `%output_schema` | Spec ref or format name | Schema for structured output parsing |
| `%fallback_model` | Model name | Re-execute with this model on failure |
| `%cache` | Duration | Per-node memoization TTL |
| `%rate_limit` | Rate expression | Token bucket throttle (e.g., `1/min`) |
| `%redact` | Tag list | Strip tagged fields before LLM call, re-hydrate after |
| `%guard` | Guard name | Content safety filter on output |
| `%audit_log` | Boolean | Append to audit trail |
| `%timeout` | Duration | Per-node wall-clock timeout |
| `%tool-order` | List or Pipeline | Explicit ordering of tool/interceptor execution |

**Tool ordering:**

The `%tool-order` attribute controls the execution order of tools and interceptor stages within an agent. It accepts two forms:

List form (for tool execution order):
```
%tool-order = [github:get_repo_conventions, github:get_pr_diff].
```

Pipeline form (for interceptor stage ordering, using `|` separator):
```
%tool-order = [%validate_in | %structured_output | %output_schema | %validate_out].
```

The `|` separator denotes "flows into" — a pipeline where each stage's output feeds the next. The `,` separator in lists denotes unordered collection. This is a meaningful grammatical distinction.

### 5.8 Prompt: `<prompt=>`

Freetext prompt content using the `=` mode switch:

```
<prompt=
  Review this diff for security vulnerabilities.
  Focus on: injection, auth bypass, secret leakage.
  Cite exact line numbers from %pr_diff.
=prompt>
```

Within a `<prompt=>` block, `%name` interpolates the value of the named state variable. All other sigils are treated as literal text. This means an agent's prompt can reference shared state without escaping.

### 5.9 With: `<with>`

Declares ephemeral plugins scoped to this execution run:

```
<with
  <plugin %name = debug_trace. plugin>
  <plugin %name = timeout_budget. %max = 120s. plugin>
  <plugin %name = cost_ceiling. %max = $0.50. plugin>
with>
```

Plugins are not persistent — they exist for one traversal and then they're gone. They wrap the entire pipeline (all phases), unlike interceptors which are per-node.

### 5.10 Plugin: `<plugin>`

A single ephemeral plugin within a `<with>` block:

| Attribute | Required | Description |
|-----------|----------|-------------|
| `%name` | Yes | Plugin identifier |
| (additional) | No | Plugin-specific configuration |


---

## 6. Inline mode

Inline PXML is natural language annotated with sigils. It is designed to be written by humans inside free-text prompts and compiled into block mode by a planning agent.

### 6.1 Example

```
Review the PR at %pr_url for security issues.
Have @security_scan and @logic_review run in parallel,
and then @synthesize combines their output.

Validate all findings against ^findings_list.
Redact #env_vars and #api_keys before 'sending:to:LLM'.
Cap the run at $0.50 and 120s.

/dry-run this first so I can see the cost estimate.
```

### 6.2 Extraction rules

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
| `'...'` | Single-quoted span | Literal (no sigil parsing inside) |

Words are sequences of `[a-zA-Z0-9_-]`. Sigils must be preceded by whitespace or start-of-line to avoid false positives in natural text.

### 6.3 Compilation

Inline → block compilation is performed by a planning agent (LLM), not a deterministic parser. The sigils provide structural anchors; the natural language provides semantic intent.

**What is deterministic** (extractable by regex):

- Agent names (`@mentions`)
- Spec refs (`^refs`)
- Tags (`#tags`)
- Commands (`/commands`)
- State refs (`%names`)
- Numeric values with units (`$0.50`, `120s`)

**What requires LLM interpretation:**

- Which agents run in parallel vs. sequentially ("run in parallel" / "then")
- Which phase an agent belongs to (pre/exec/post)
- Whether validation is input, output, or both
- Which agents get which interceptors
- Default model selection
- Tool scoping decisions

**What is defaulted by system policy (not expressible inline):**

- Hook lifecycle ordering (pick/drop stacks)
- Failure policies (`%on-failure`)
- Retry counts
- Structured output format
- Audit logging
- Tool-order pipelines

The compilation step produces a valid block-mode PXML document that can be reviewed by the human before execution, or executed directly if trust level permits.


---

## 7. Compilation target

PXML block mode compiles into Phlox graph structs:

| PXML element | Phlox struct |
|-------------|--------------|
| `<pxml>` | `%Phlox.Graph{}` |
| `<state>` | Typed shared state (V2.8) |
| `<pre/exec/post>` | Phase groupings in graph |
| `<agent>` | `%Phlox.Node{}` |
| `<plan>` | Parallel/sequential subgraph |
| `<intercept>` | Interceptor declarations (V2.9) |
| `<pick-tool/drop-tool>` | Tool scope mutations on node |
| `<prompt=>` | Prompt template on node |
| `<with>` | Plugin list passed to `Phlox.run/2` |
| `<plugin>` | Plugin struct |
| `^spec_ref` | `Gladius.Registry.fetch!/1` call |

### Dependencies

PXML compilation requires:

1. **Phlox V2.8** — typed shared state (for `<state>` block)
2. **Phlox V2.9** — stable interceptor behaviours (for `<intercept>` block)
3. **Gladius** — spec registry (for `^ref` resolution)
4. **Phlox.Extensions.Validate** — the bridge between Phlox interceptors and Gladius validation

### Package structure

PXML should be a **sibling package** to Phlox, not part of Phlox core:

```
phlox        — graph execution engine (no PXML knowledge)
gladius      — validation/spec library (no Phlox knowledge)
pxml         — parser + compiler (depends on phlox + gladius)
```

The `pxml` package:
- Parses PXML text into an AST (via nimble_parsec)
- Compiles the AST into Phlox graph structs
- Resolves `^ref` via Gladius registry
- Validates the document against PXML's own structural rules

Someone who doesn't want PXML can define their graphs in pure Elixir DSL. Two front-ends, one execution engine.


---

## 8. Open questions

### 8.1 Tool inheritance

Does a child agent inherit its parent's toolbelt, or start with an empty set? Current assumption: inherit downward, narrow with drop. But this means a deeply nested agent might have access to tools its author didn't intend. An alternative: start empty, pick explicitly. The deny-all-allow-some pattern works either way, but the default matters for security posture.

### 8.2 Numeric ambiguity

The `.` terminator and decimal numbers create a parsing edge case: `%amount = 3.50.` — is that "3.50" terminated by `.`, or "3" terminated by `.` followed by stray `50.`? Current resolution: the parser is greedy — it reads the longest valid numeric literal before the terminator. `3.50.` parses as value `3.50`, terminated by `.`. This works but should be validated against edge cases in the nimble_parsec grammar.

### 8.3 Prompt interpolation depth

Within `<prompt= ... =prompt>`, `%name` interpolates state variables. But what about `%name.field` for nested state? Or `%name | transform` for piped transforms? Current position: keep it simple — `%name` only, flat interpolation. Complex transforms belong in the interceptor pipeline, not in prompt text.

### 8.4 A2A capability advertisement

PXML can describe what an agent *consumes* (tools, inputs, interceptors). It does not yet describe what an agent *exposes* (capabilities, output schemas, available endpoints). For A2A, a receiving agent needs to advertise: "here is my namespace, here are the tools I provide, here are the schemas I accept." This may require a `<capability>` element or a separate advertisement document format.

### 8.5 Wire format

The text format is human-readable. For A2A transport, a compact binary or JSON serialization of the PXML AST may be needed. This is a future concern — the text format is the source of truth; any wire format is derived.

### 8.6 Interceptor vs. tool-order interaction

When `%tool-order` specifies a pipeline that includes both interceptors and tools, the execution semantics need to be precise. Does `[%validate_in | github:get_pr_diff | %validate_out]` mean "validate input, then call the tool, then validate output"? If so, tool-order is a superset of interceptor ordering — it's the full execution pipeline for a node. This unifies two concepts but adds complexity.


---

## 9. Changelog

| Date | Change |
|------|--------|
| 2026-04-07 | Initial draft from design conversation. Sigil table, element vocabulary, inline/block modes, scoping semantics, compilation target. |


---

## 10. Full example (block mode)

```
<pxml %ns = PXML:org:pxml:brain-trust.
  %version = 0.1.0.
  %context = codex.pxml.org

  ~~ shared state: typed via Gladius spec refs ~~
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

  ~~ plugins: ephemeral, scoped to this run ~~
  <with
    <plugin %name = debug_trace. plugin>
    <plugin %name = timeout_budget. %max = 120s. plugin>
    <plugin %name = cost_ceiling. %max = $0.50. plugin>
  with>
pxml>
```

## 11. Full example (inline mode)

The same pipeline expressed as annotated natural language:

```
Review the PR at %pr_url for security issues.
Have @security_scan and @logic_review run in parallel,
and then @synthesize combines their output.

Validate all findings against ^findings_list.
Redact #env_vars and #api_keys before 'sending:to:LLM'.
Cap the run at $0.50 and 120s.

/dry-run this first so I can see the cost estimate.
```

A planning agent compiles this into the block mode document above, filling in defaults for model selection, tool scoping, interceptor configuration, and lifecycle phase assignment based on system policy.

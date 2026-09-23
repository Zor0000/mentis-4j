# Mentis

## One-line idea

**Metis is a graph-backed incident-response agent that investigates system failures, records what it tried and what worked, and reuses prior incident knowledge to resolve future incidents more efficiently.**

---

## Core thesis

Enterprise incident-response agents should not treat every incident as a new problem.

They should remember:

- what happened before,
- which services were involved,
- what hypotheses were considered,
- what remediation actions were attempted,
- which actions failed,
- which actions resolved the incident,
- and what evidence justified the final conclusion.

Metis stores this operational experience as a **Neo4j graph** and retrieves relevant prior incidents before and during future investigations.

The memory is not chat history. It is **structured operational memory**.

---

## Product flow

```text
User reports incident
        ↓
      Pi Agent
        ↓
investigates via tools
        ↓
Neo4j infrastructure graph
+ incident memory graph
        ↓
forms hypotheses
        ↓
chooses remediation
        ↓
verifies outcome
        ↓
writes incident experience
back into Neo4j
```

The agent runtime is provided by **Pi SDK**.

Metis does **not** build a custom harness, sandbox, durable runtime, or orchestration framework.

---

## Why graph memory

A production incident is relational.

Example:

```text
checkout-api
   │ DEPENDS_ON
   ▼
payments-api
   │ USES
   ▼
redis

deployment-182
   │ CHANGED
   ▼
payments-api
```

A previous incident is also relational:

```text
Incident #21
   │ AFFECTED
   ▼
payments-api
   │ HAD_SYMPTOM
   ▼
redis timeouts

Incident #21
   │ ATTEMPTED
   ▼
restart_service
   │ RESULTED_IN
   ▼
failure

Incident #21
   │ RESOLVED_BY
   ▼
rollback_config
```

The agent should be able to combine:

1. the **current infrastructure topology**, and
2. **historical incident experience**.

This is the primary reason for Neo4j.

---

## Locked scope

### We are building

- a single incident-response agent using Pi SDK,
- a small simulated production environment,
- a Neo4j infrastructure graph,
- a Neo4j incident-memory graph,
- tools for logs, metrics, deployments, dependencies, remediation, and health checks,
- retrieval of related historical incidents,
- write-back of new incident experience,
- a visual demo showing how memory changes future behavior.

### We are not building

- sandboxing,
- a coding agent,
- a custom agent harness,
- LangGraph,
- Temporal,
- multi-agent orchestration,
- Kubernetes integration,
- real Datadog/Prometheus integration,
- real production remediation,
- autonomous cloud infrastructure,
- reinforcement learning,
- sophisticated long-term memory consolidation,
- automatic runbook generation,
- a generic conversational-memory system.

If a feature does not directly support the incident-memory loop, it is out of scope for the hackathon MVP.

---

## Agent runtime

Use **Pi SDK** for:

- agent execution,
- tool calling,
- session lifecycle,
- model interaction,
- streaming events.

Metis only adds domain-specific tools and memory behavior.

---

## Neo4j responsibilities

Neo4j owns two connected graphs.

### 1. Infrastructure graph

Possible nodes:

```text
(:Service)
(:Database)
(:Queue)
(:Deployment)
(:Host)
```

Possible relationships:

```text
Service -[:DEPENDS_ON]-> Service
Service -[:USES]-> Database
Service -[:USES]-> Queue
Deployment -[:CHANGED]-> Service
Service -[:RUNS_ON]-> Host
```

This graph helps the agent understand:

- service dependencies,
- likely blast radius,
- recent changes,
- shared infrastructure.

---

### 2. Incident experience graph

Possible nodes:

```text
(:Incident)
(:Symptom)
(:Hypothesis)
(:Evidence)
(:Remediation)
(:Outcome)
(:Runbook)
```

Possible relationships:

```text
Incident -[:AFFECTED]-> Service
Incident -[:HAD_SYMPTOM]-> Symptom
Incident -[:CONSIDERED]-> Hypothesis
Hypothesis -[:SUPPORTED_BY]-> Evidence
Incident -[:PRODUCED]-> Evidence
Incident -[:ATTEMPTED]-> Remediation
Remediation -[:RESULTED_IN]-> Outcome
Incident -[:RESOLVED_BY]-> Remediation
Remediation -[:DERIVED_FROM]-> Runbook
```

The graph should make it possible to answer questions such as:

- Have we seen this symptom on this service before?
- Have we seen this symptom on one of its dependencies?
- Which remediation actions failed in similar incidents?
- Which remediation actions eventually succeeded?
- Which deployment or dependency was common across multiple incidents?
- What evidence supported the previous root-cause conclusion?

---

## Memory model

Metis stores **operational outcomes**, not transcripts.

A completed incident should become something like:

```text
Incident #184

Affected service:
payments-api

Symptoms:
- p95 latency spike
- Redis timeout errors

Hypothesis:
recent Redis connection-pool configuration change

Attempts:
1. restart payments-api
   outcome: failed

2. scale payments-api
   outcome: failed

3. roll back Redis configuration
   outcome: succeeded

Evidence:
latency returned to baseline after rollback

Learned operational memory:
For payments-api incidents involving Redis timeouts,
check recent Redis configuration changes before restarting
or scaling the service.
```

The exact consolidation logic can stay simple for the MVP.

---

## Retrieval strategy

For a new incident:

1. identify the affected service,
2. traverse its dependency neighborhood,
3. identify symptoms and recent changes,
4. retrieve historically related incidents,
5. expand those incidents through their:
   - affected services,
   - symptoms,
   - hypotheses,
   - attempted remediations,
   - outcomes,
6. provide the most relevant operational history to the Pi agent.

Retrieval can combine:

```text
graph traversal
+
semantic similarity
```

Semantic similarity is useful for matching differently worded symptoms.

Graph traversal is useful for determining whether the historical incident actually involved related services, dependencies, actions, or outcomes.

---

## Agent tools

The MVP should expose a deliberately small tool surface.

```text
get_service(name)

get_dependencies(service)

get_metrics(service)

get_logs(service)

get_recent_deployments(service)

restart_service(service)

rollback_deployment(service)

rollback_config(service)

check_health(service)
```

Optional if time permits:

```text
get_related_incidents(service, symptoms)

get_incident_history(incident_id)
```

Memory retrieval may also happen automatically before planning instead of being exposed as a tool.

---

## Simulated production environment

Keep the topology small enough that judges can understand it immediately.

```text
frontend
   ↓
api-gateway
   ↓
checkout-api
   ↓
payments-api
   ├────→ postgres
   └────→ redis
```

The environment can be backed entirely by deterministic simulated state.

No Kubernetes or real cloud environment is required.

---

## Demo incident scenarios

### Scenario 1: bad deployment

```text
payments-api error rate increases
        ↓
agent checks metrics
        ↓
agent checks recent deployments
        ↓
finds deployment immediately before incident
        ↓
rollback deployment
        ↓
health check passes
        ↓
incident memory written to Neo4j
```

Purpose:

Demonstrate basic investigation, remediation, verification, and write-back.

---

### Scenario 2: Redis configuration issue

```text
checkout latency increases
        ↓
agent traces dependency to payments-api
        ↓
finds Redis timeout errors
        ↓
tries restart_service
        ↓
health check still fails
        ↓
checks recent configuration changes
        ↓
rolls back Redis configuration
        ↓
system recovers
        ↓
failed + successful remediation history written to Neo4j
```

Purpose:

Create useful historical experience.

---

### Scenario 3: related repeat incident

Trigger a related incident involving the same Redis dependency or similar symptoms.

#### Without memory

```text
inspect
→ restart
→ inspect more
→ discover Redis issue
→ rollback
```

#### With Metis memory

```text
retrieve previous Redis incident
→ see that restart previously failed
→ inspect config/deployment history immediately
→ rollback
```

Purpose:

This is the core memory demonstration.

The model has not changed.

The operational history has.

---

## Primary evaluation

Compare:

```text
baseline Pi agent
vs
Pi agent + Metis graph memory
```

Metrics:

- number of tool calls,
- number of remediation attempts,
- number of repeated failed strategies,
- steps to successful recovery,
- total investigation latency,
- successful recovery rate.

The most important metric for the demo is:

**Does the memory-enabled agent avoid an action that previously failed in a structurally similar incident?**

---

## UI

Keep the UI focused on three things.

```text
┌─────────────────┬────────────────────┐
│ Agent trace     │ Infrastructure     │
│                 │ graph              │
│ inspect logs    │                    │
│ inspect Redis   │ api → payments     │
│ rollback config │       ↓            │
│                 │     redis          │
├─────────────────┴────────────────────┤
│ Retrieved incident memory            │
│                                      │
│ Similar Incident #12                 │
│ restart_service → FAILED             │
│ rollback_config → RESOLVED           │
└──────────────────────────────────────┘
```

The graph should be visible because Neo4j must be clearly central to the product.

---

## Demo narrative

The demo should tell one simple story:

> Metis investigates an incident and resolves it.

Then:

> The same organization encounters a related incident later.

Then:

> Metis remembers the previous failed and successful remediation paths and changes its investigation strategy.

The key moment is not merely retrieving history.

The key moment is showing that **retrieved history changes the agent's next action**.

---

## Product positioning

### Short version

**Metis is graph-backed operational memory for incident-response agents.**

### Longer version

**Metis gives incident-response agents persistent operational memory. It connects infrastructure topology with previous incidents, hypotheses, evidence, remediation attempts, and outcomes in Neo4j so agents can reuse what the organization learned instead of investigating every failure from scratch.**

---

## Design principle

The system should follow this loop:

```text
observe
   ↓
investigate
   ↓
act
   ↓
verify
   ↓
remember
   ↓
reuse
```

Every feature should strengthen this loop.

---

## Main open questions for implementation discussion

1. Should incident-memory retrieval happen automatically before every planning step, or only at incident start?
2. How should we represent semantically similar symptoms in Neo4j?
3. Should remediation attempts be shared nodes or unique per incident?
4. How much reasoning trace should be persisted versus only the structured incident summary?
5. Should failed hypotheses be retained as reusable memory?
6. What is the simplest deterministic simulator that still makes the investigation feel realistic?
7. What graph visualization library should the frontend use?
8. Should the agent query Neo4j directly through Cypher tools, or should Metis expose higher-level domain tools?
9. What exact baseline should we use for the memory-vs-no-memory evaluation?
10. Which Neo4j products should be used beyond AuraDB without adding unnecessary complexity?

---

## Current locked decisions

- **Name:** Metis
- **Domain:** enterprise incident response
- **Agent runtime:** Pi SDK
- **Database / graph memory:** Neo4j
- **Core memory:** operational incident history
- **Core differentiator:** future remediation changes based on previous incident outcomes
- **Environment:** simulated
- **Architecture:** single agent
- **Hackathon focus:** graph + agent memory
- **No custom harness**
- **No sandboxing**
- **No coding-agent scope**

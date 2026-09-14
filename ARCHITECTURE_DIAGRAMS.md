# ARCHITECTURE_DIAGRAMS.md

**Ollama Coding Agent — Component Relationship Flowcharts**

Version: 1.1
Status: Architecture Baseline
Format: Mermaid diagrams (render trong VS Code, GitHub, GitLab, Obsidian)
Related specs:
`INVARIANTS.md`, `DOMAIN_CONTRACTS.md`, `STATE_MACHINE_SPEC.md`,
`GRAPH_PROTOCOL.md`, `VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`,
`CONTEXT_SPEC_v1.0.md`, `INFRASTRUCTURE_SPEC.md`, `PLATFORM_SUPPORT.md`

---

## 0. Cách đọc

File này gồm **12 diagrams**, mỗi cái trả lời một câu hỏi cụ thể:

| # | Diagram | Câu hỏi |
|---|---|---|
| 1 | 5-Plane Overview | Hệ thống chia thành những plane nào? |
| 2 | Control Plane Detail | Authority nằm ở đâu? |
| 3 | Intelligence Plane | LLM đề xuất gì? |
| 4 | Execution Plane | Tool được thực thi thế nào? |
| 5 | Verification Plane | Verify làm sao? |
| 6 | Evidence Plane | Bằng chứng lưu ở đâu? |
| 7 | Dependency Direction | Layer nào phụ thuộc layer nào? |
| 8 | Trust Boundary | Cái gì trusted, cái gì không? |
| 9 | Planning Flow | Goal → Graph ra sao? |
| 10 | Execution Flow | Task → PASSED ra sao? |
| 11 | Recovery Flow | Failure → Recovery ra sao? |
| 12 | Full Lifecycle Sequence | Một session chạy từ đầu đến cuối thế nào? |


---

## 1. 5-Plane Overview

Câu hỏi: **Hệ thống chia thành những plane nào?**

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 40, 'rankSpacing': 55, 'padding': 8}, 'themeVariables': {'fontSize': '14px'}}}%%
flowchart TB
    User([USER / VS Code])

    subgraph CP["CONTROL PLANE (Authority)"]
        Goal[Goal]
        Session[Session]
        TG1[TaskGraph]
        Sched[Scheduler]
        SM[StateMachine]
        Policy[PolicyEngine]
        Budget[Budget]
        CP2[Checkpoint]
    end

    subgraph IP["INTELLIGENCE PLANE (Proposals only)"]
        Planner[Planner]
        Critic[Critic]
        Replanner[Replanner]
        CtxBuilder[ContextBuilder]
        Retriever[Retriever]
        FailureAn[FailureAnalyzer]
        StrategyReg[StrategyRegistry]
    end

    subgraph EP["EXECUTION PLANE (Action)"]
        TaskExec[TaskExecutor]
        ModelGW[ModelGateway]
        ToolGW[ToolGateway]
        ProcSup[ProcessSupervisor]
        WsMgr[WorkspaceManager]
    end

    subgraph VP["VERIFICATION PLANE (Evidence)"]
        VerEng[VerificationEngine]
        VerPol[VerificationPolicy]
        VerScope[VerificationScope]
        VerRep[VerificationReport]
    end

    subgraph EviP["EVIDENCE PLANE (Persistence)"]
        ArtStore[ArtifactStore]
        WsRev[WorkspaceRevision]
        Checkpoint[Checkpoint]
        EventLog[EventLog]
        Provenance[Provenance]
    end

    subgraph Infra["INFRASTRUCTURE (Adapters)"]
        SQLite[(SQLite)]
        FS[(Filesystem)]
        Git[(Git)]
        Shell[(Shell)]
        Ollama[(Ollama)]
        TS[(Tree-sitter)]
        LSP[(LSP)]
    end

    User --> CP
    CP --> IP
    CP --> EP
    EP --> VP
    VP --> EviP
    EP --> EviP
    CP --> EviP

    EP -.adapter.-> Infra
    VP -.adapter.-> Infra
    EviP -.adapter.-> Infra
    IP -.adapter.-> Infra

    IP -.propose.-> CP
    EP -.evidence.-> VP
    VP -.report.-> CP

    classDef control fill:#e1f5ff,stroke:#01579b,stroke-width:2px
    classDef intel fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef exec fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef verif fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef evid fill:#fce4ec,stroke:#880e4f,stroke-width:2px
    classDef infra fill:#eceff1,stroke:#263238,stroke-width:1px

    class Goal,Session,TG1,Sched,SM,Policy,Budget,CP2 control
    class Planner,Critic,Replanner,CtxBuilder,Retriever,FailureAn,StrategyReg intel
    class TaskExec,ModelGW,ToolGW,ProcSup,WsMgr exec
    class VerEng,VerPol,VerScope,VerRep verif
    class ArtStore,WsRev,Checkpoint,EventLog,Provenance evid
    class SQLite,FS,Git,Shell,Ollama,TS,LSP infra
```

**Nguyên tắc:**
- Control Plane là **authority** — không ai bypass.
- Intelligence Plane chỉ **propose**.
- Execution Plane **thực thi** theo policy.
- Verification Plane **chứng minh**.
- Evidence Plane **lưu** mọi thứ.

---

## 2. Control Plane — Authority Detail

Câu hỏi: **Authority nằm ở đâu? Ai quyết định cái gì?**

```mermaid
flowchart LR
    subgraph Authority["Authority (Runtime decides)"]
        direction TB
        SM[StateMachine]
        Policy[PolicyEngine]
        Sched[Scheduler]
        Budget[BudgetEngine]
        GraphCommit[GraphCommit]
        VerGate[CompletionGate]
    end

    subgraph Proposers["Proposers (Only suggest)"]
        direction TB
        Planner[Planner]
        Replanner[Replanner]
        CodeGen[CodeGenerator]
        FailureAn[FailureAnalyzer]
    end

    subgraph Enforcers["Enforcers (Block / Allow)"]
        ToolGW[ToolGateway]
        WsMgr[WorkspaceManager]
        ProcSup[ProcessSupervisor]
        Approval[ApprovalEngine]
    end

    Planner -->|propose plan| GraphCommit
    Replanner -->|propose mutation| GraphCommit
    FailureAn -->|propose recovery| Policy
    CodeGen -->|propose tool call| ToolGW

    Policy -->|decide| Approval
    Policy -->|decide| ToolGW
    Policy -->|decide| Sched
    Policy -->|decide| Budget
    SM -->|transition| Sched
    GraphCommit -->|validate| Policy
    VerGate -->|check| SM

    ToolGW -->|enforce| WsMgr
    ToolGW -->|enforce| ProcSup
    Approval -->|bind| ToolGW

    classDef auth fill:#ffcdd2,stroke:#b71c1c,stroke-width:3px
    classDef prop fill:#fff9c4,stroke:#f57f17,stroke-width:1px,stroke-dasharray: 5 5
    classDef enf fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px

    class SM,Policy,Sched,Budget,GraphCommit,VerGate auth
    class Planner,Replanner,CodeGen,FailureAn prop
    class ToolGW,WsMgr,ProcSup,Approval enf
```

**Nguyên tắc vàng:**
> LLM proposes (dashed). Runtime decides (solid red). Enforcers block (green).

Không có mũi tên nào từ Proposer → Authority mà không qua validation.

---

## 3. Intelligence Plane — Proposal Flow

Câu hỏi: **LLM đề xuất gì, và đề xuất đó đi đâu?**

```mermaid
flowchart TB
    Goal[Goal] --> CtxBuilder[ContextBuilder]
    Task[Task] --> CtxBuilder
    Failure[Failure] --> CtxBuilder

    CtxBuilder --> Retriever[Retriever]
    Retriever --> FileSel[FileSelector]
    FileSel --> Compactor[Compactor]
    Compactor --> TokenBudget[TokenBudgeter]
    TokenBudget --> TrustMark[TrustMarker]
    TrustMark --> Snapshot[(ContextSnapshot)]

    Snapshot --> ModelGW[ModelGateway]
    ModelGW --> Ollama[Ollama Adapter]
    Ollama --> RawOutput[Raw LLM Output]
    RawOutput --> Parser[Parser]
    Parser --> SchemaVal[Schema Validator]
    SchemaVal --> SemVal[Semantic Validator]
    SemVal --> Proposal[Accepted Proposal]

    Proposal --> Planner[Planner]
    Proposal --> Critic[Critic]
    Proposal --> Replanner[Replanner]
    Proposal --> CodeGen[CodeGenerator]
    Proposal --> FailureAn[FailureAnalyzer]

    Planner -->|Plan| PValidator[PlanValidator]
    Replanner -->|GraphMutation| GValidator[GraphValidator]
    FailureAn -->|FailureClass| RecoveryPol[RecoveryPolicy]
    CodeGen -->|ToolCall| ToolGW[ToolGateway]

    PValidator -->|reject| ModelGW
    GValidator -->|reject| ModelGW

    classDef llm fill:#fff3e0,stroke:#e65100
    classDef val fill:#e1f5ff,stroke:#01579b
    classDef ctx fill:#f3e5f5,stroke:#4a148c

    class ModelGW,Ollama,RawOutput,Planner,Critic,Replanner,CodeGen,FailureAn llm
    class Parser,SchemaVal,SemVal,Proposal,PValidator,GValidator,RecoveryPol val
    class CtxBuilder,Retriever,FileSel,Compactor,TokenBudget,TrustMark,Snapshot ctx
```

**Điểm chốt:**
- Mọi LLM call qua `ModelGateway`.
- Output qua **3 lớp validation**: parse → schema → semantic.
- Chỉ khi pass → proposal.
- Proposal vẫn phải qua Authority (Control Plane).

---

## 4. Execution Plane — Tool Execution

Câu hỏi: **Tool call được thực thi thế nào và bị chặn ở đâu?**

```mermaid
flowchart TB
    Proposal[LLM proposes ToolCall] --> TG[ToolGateway]

    TG --> SchemaVal{Schema valid?}
    SchemaVal -->|no| Reject1[DENIED]
    SchemaVal -->|yes| RiskClass{Risk class?}

    RiskClass -->|READ_ONLY| AutoA[Auto-approve]
    RiskClass -->|LOW_RISK| AutoA
    RiskClass -->|MODIFY_WORKSPACE| PolicyChk{Policy?}
    RiskClass -->|NETWORK| PolicyChk
    RiskClass -->|PACKAGE_INSTALL| ApprovalReq[Approval required]
    RiskClass -->|SYSTEM| ApprovalReq
    RiskClass -->|DESTRUCTIVE| ApprovalReq
    RiskClass -->|PRIVILEGED| DenyP[DENIED]

    PolicyChk -->|allow| AutoA
    PolicyChk -->|require| ApprovalReq
    PolicyChk -->|deny| Reject1

    ApprovalReq --> HumanUI[VS Code Approval UI]
    HumanUI --> Decision{Human decision}
    Decision -->|approve| Approved[APPROVED]
    Decision -->|deny| Reject1
    Decision -->|timeout| Expired[EXPIRED]

    AutoA --> Approved
    Approved --> Exec[Execute]

    Exec --> WsCheck{Workspace boundary?}
    WsCheck -->|violate| Reject2[PATH_ESCAPE / SYMLINK_ESCAPE]
    WsCheck -->|ok| ProcCheck{Process model}

    ProcCheck -->|WSL2| PosixSpawn[spawn + process group]
    ProcCheck -->|Windows| WinSpawn[spawn + Job Object]

    PosixSpawn --> Result[ProcessResult]
    WinSpawn --> Result

    Result --> Success{exit 0?}
    Success -->|yes| SUCCEEDED
    Success -->|no| FAILED
    Result -->|timeout| TIMEOUT

    classDef gateway fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px
    classDef deny fill:#ffcdd2,stroke:#b71c1c
    classDef human fill:#fff9c4,stroke:#f57f17
    classDef ok fill:#e1f5ff,stroke:#01579b

    class TG,SchemaVal,RiskClass,PolicyChk gateway
    class Reject1,Reject2,DenyP,Expired deny
    class HumanUI,Decision,ApprovalReq human
    class AutoA,Approved,Exec,SUCCEEDED ok
```

**Điểm chốt:**
- Không có đường nào tới `Execute` mà không qua `Approved`.
- DESTRUCTIVE/PRIVILEGED **không** auto-approve.
- Boundary check **sau** approval, không tin approval.

---

## 5. Verification Plane — Evidence Binding

Câu hỏi: **Verification bind với cái gì và verify cái gì?**

```mermaid
flowchart TB
    Task[Task] --> VerPolicy[VerificationPolicy]
    VerPolicy --> Scope{Compute scope}

    Scope -->|FULL| Full[Full test suite]
    Scope -->|AFFECTED_CLOSURE| Closure[Transitive closure]
    Scope -->|AFFECTED_DIRECT| Direct[Direct tests]
    Scope -->|SMOKE| Smoke[Build + smoke]

    Direct --> Affected[Compute affected set]
    Closure --> Affected
    Affected --> AffectedCalc[Diff + import graph]
    AffectedCalc --> Deterministic[Deterministic set]

    Deterministic --> Scratch[Declare scratch zones]
    Scratch --> R1[Capture revision R_before]
    R1 --> Run[Execute checks]
    Run --> R2[Capture revision R_after]

    R2 --> Validate{Validate}
    Validate -->|R_before == R_after| OK[OK]
    Validate -->|diff ngoài scratch| Invalid[INVALID]

    OK --> Build[Build VerificationReport]
    Invalid --> Build

    Build --> Bind{Bind to revision}
    Bind --> Report[(VerificationReport)]
    Report --> Fresh{Fresh?}

    Fresh -->|revision match| FreshOK[Fresh]
    Fresh -->|revision differ| Stale[Stale]

    FreshOK --> Gate[CompletionGate]
    Stale --> Reject[REJECT stale evidence]

    Gate --> Check{All criteria}
    Check -->|PASS + fresh + scope ok| Complete[Task PASSED]
    Check -->|fail| Reject

    Reject --> Override{Human override?}
    Override -->|no| FailedT[Task FAILED]
    Override -->|"yes (HUMAN_OVERRIDE_PASSED)"| Marked[Task PASSED with marker]
    Marked -. keeps original report .-> Report

    classDef verif fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef bad fill:#ffcdd2,stroke:#b71c1c
    classDef good fill:#c8e6c9,stroke:#1b5e20
    classDef human fill:#fff9c4,stroke:#f57f17

    class VerPolicy,Scope,Affected,Deterministic,Run,Build,Report verif
    class Invalid,Stale,Reject,FailedT bad
    class OK,FreshOK,Gate,Complete good
    class Override,Marked human
```

**Điểm chốt:**
- Verification **luôn** bind với `WorkspaceRevision`.
- Mutation ngoài scratch thì INVALID.
- Revision thay đổi thì stale; stale thì không complete.
- Đường vào PASSED không qua verification duy nhất là **human override** (`HUMAN_OVERRIDE_PASSED`): tạo marker `HUMAN_OVERRIDE_COMPLETED`, **không** sửa VerificationReport gốc (VR-005, HI-004). Xem `VERIFICATION_PROTOCOL §11`.

---

## 6. Evidence Plane — Persistence Map

Câu hỏi: **Bằng chứng lưu ở đâu, hình dạng thế nào?**

```mermaid
flowchart TB
    subgraph Ops["Operational State — 'Hiện tại ở đâu?'"]
        Session[(sessions)]
        Task[(tasks)]
        TaskExec[(task_executions)]
        TaskRun[(task_runs)]
        Graph[(task_graph_versions)]
        ToolCall[(tool_calls)]
        Budget[(budgets)]
        Checkpoint[(checkpoints)]
    end

    subgraph Audit["Audit Trail — 'Điều gì đã xảy ra?'"]
        Events[(events — append-only)]
        Mutations[(graph_mutations)]
        VerReports[(verification_reports)]
        Failures[(failures)]
        Recoveries[(recoveries)]
        Provenance[(provenance)]
    end

    subgraph Artifacts["Artifact Store — bytes"]
        Logs[(logs)]
        Patches[(patches)]
        TestResults[(test results)]
        Reports[(reports)]
        Screenshots[(screenshots)]
    end

    subgraph Revisions["Workspace Revisions"]
        WsRev[(workspace_revisions)]
        ChangeRec[(change_records)]
    end

    Session --> Events
    Task --> Events
    TaskRun --> Events
    Graph --> Mutations
    ToolCall --> Events
    VerReports --> Events
    Failures --> Events

    VerReports -.artifact.-> Reports
    TaskRun -.artifact.-> Logs
    TaskRun -.artifact.-> Patches
    ToolCall -.artifact.-> TestResults

    WsRev --> ChangeRec
    Checkpoint -. hash claim .-> WsRev
    Checkpoint --> Graph
    Checkpoint -. dirty marked by .-> Events

    Events --> Provenance

    classDef ops fill:#e1f5ff,stroke:#01579b
    classDef audit fill:#fce4ec,stroke:#880e4f
    classDef art fill:#fff3e0,stroke:#e65100
    classDef rev fill:#f3e5f5,stroke:#4a148c

    class Session,Task,TaskExec,TaskRun,Graph,ToolCall,Budget,Checkpoint ops
    class Events,Mutations,VerReports,Failures,Recoveries,Provenance audit
    class Logs,Patches,TestResults,Reports,Screenshots art
    class WsRev,ChangeRec rev
```

**Điểm chốt:**
- SQLite = **operational state** + **audit trail**.
- ArtifactStore = **bytes** (ngoài SQLite).
- Mọi event append-only.
- Provenance chain: model → context → revision.
- Checkpoint metadata atomic trong SQLite; `workspaceRevision.hash` là **claim** về filesystem (đường nét đứt), không atomic cùng SQLite. Drift lúc capture được đánh dấu bằng event `CHECKPOINT_DIRTY_AT_CAPTURE`. Xem `WORKSPACE_SPEC §10.3`, CP-010..CP-012.

---

## 7. Dependency Direction

Câu hỏi: **Layer nào được import layer nào?**

```mermaid
flowchart BT
    subgraph L4["Layer 4 — Infrastructure (Adapters)"]
        SQLite[SQLite Adapter]
        FS[Filesystem Adapter]
        Git[Git Adapter]
        Ollama[Ollama Adapter]
        Proc[ProcessSupervisor]
        Art[ArtifactStore]
    end

    subgraph L3["Layer 3 — Application"]
        Planning[planning]
        Context[context]
        Execution[execution]
        Verification[verification]
        Recovery[recovery]
        Tools[tools]
        Models[models]
    end

    subgraph L2["Layer 2 — Domain"]
        Core[agent-core]
        SM[StateMachine]
        Graph[Graph]
        Repos[Repository Interfaces]
    end

    subgraph L1["Layer 1 — Primitives"]
        Types[Types]
        Errors[Errors]
        Contract[Contracts]
    end

    L4 -. implements .-> L2
    L3 --> L2
    L2 --> L1
    L3 --> L1

    L2 -. forbidden .-> L3
    L2 -. forbidden .-> L4
    L1 -. forbidden .-> L2

    classDef domain fill:#c8e6c9,stroke:#1b5e20,stroke-width:3px
    classDef app fill:#e1f5ff,stroke:#01579b
    classDef infra fill:#eceff1,stroke:#263238
    classDef prim fill:#fff9c4,stroke:#f57f17

    class Core,SM,Graph,Repos domain
    class Planning,Context,Execution,Verification,Recovery,Tools,Models app
    class SQLite,FS,Git,Ollama,Proc,Art infra
    class Types,Errors,Contract prim
```

**Nguyên tắc:**
- `-->` = allowed import.
- `-.x.->` = **forbidden** import (CI enforce qua dependency-cruiser).
- Domain (L2) **không** import app (L3) hay infra (L4).
- Infrastructure (L4) chỉ **implements** interface từ domain.

Tham chiếu: `INVARIANTS.md` → **DC-001..DC-005**.

---

## 8. Trust Boundary

Câu hỏi: **Cái gì trusted, cái gì không?**

```mermaid
flowchart TB
    subgraph T0["T0 — System (Trusted)"]
        Runtime[Runtime code]
        Hardcoded[Hardcoded policy]
    end

    subgraph T1["T1 — User (Trusted, constrained)"]
        UserInput[User input]
        UserConfig[User config]
    end

    subgraph T2["T2 — Policy (Trusted after validation)"]
        PolicyFiles[Policy files]
        Allowlist[Allowlists]
    end

    subgraph T3["T3 — Model (UNTRUSTED)"]
        LLMOutput[LLM output]
        ToolProposal[Tool proposal]
        PlanProposal[Plan proposal]
    end

    subgraph T4["T4 — Workspace (UNTRUSTED)"]
        Files[Source files]
        README[README / docs]
        Comments[Code comments]
        Logs[Test logs]
    end

    subgraph T5["T5 — External (UNTRUSTED)"]
        Network[Network]
        Packages[Packages]
        Subproc[Subprocess output]
    end

    T0 -->|authority| T2
    T1 -->|authority| T2
    T2 -->|decide| Decision[Runtime decision]

    T3 -->|propose only| Validation[Validation layer]
    T4 -->|data only| Context[Context marking]
    T5 -->|data only| Sandbox[Sandbox layer]

    Validation --> Decision
    Context --> Decision
    Sandbox --> Decision

    T3 -. no authority .-> Decision
    T4 -. no authority .-> Decision
    T5 -. no authority .-> Decision

    classDef trusted fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px
    classDef untrusted fill:#ffcdd2,stroke:#b71c1c,stroke-width:2px
    classDef boundary fill:#fff9c4,stroke:#f57f17

    class Runtime,Hardcoded,UserInput,UserConfig,PolicyFiles,Allowlist trusted
    class LLMOutput,ToolProposal,PlanProposal,Files,README,Comments,Logs,Network,Packages,Subproc untrusted
    class Decision,Validation,Context,Sandbox boundary
```

**Nguyên tắc:**
- `T0/T1/T2` = trusted → có authority.
- `T3/T4/T5` = untrusted → **chỉ data**, không authority.
- Mọi untrusted phải qua validation/sandbox **trước khi** ảnh hưởng decision.

Tham chiếu: `SECURITY_MODEL.md` → §1, §3.

---

## 9. Planning Flow

Câu hỏi: **Goal → Graph ra sao?**

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CP as Control Plane
    participant P as Planner
    participant V as PlanValidator
    participant C as PlanCritic
    participant GC as GraphCommit
    participant G as GraphStore
    participant E as EventLog

    U->>CP: Goal
    CP->>CP: Create Session
    CP->>P: Plan(goal)
    P->>P: Build Context
    P->>P: Call LLM
    P-->>CP: Plan proposal

    CP->>V: Validate(plan)
    V->>V: Schema check
    V->>V: Cycle check
    V->>V: Budget check
    alt Valid
        V-->>CP: VALIDATED
    else Invalid
        V-->>CP: REJECTED
        CP->>P: Retry with feedback
    end

    CP->>C: Critique(plan)
    C-->>CP: Critique (optional)

    CP->>GC: Commit mutation
    GC->>GC: Transaction begin
    GC->>G: Check baseVersion
    GC->>G: Write graph v1
    GC->>E: Append GRAPH_VERSION_CREATED
    GC->>GC: Transaction commit
    GC-->>CP: Graph v1

    CP->>U: Session RUNNING
```

**Điểm chốt:**
- Planner **không** commit graph.
- Validator **deterministic**.
- Critic chỉ **góp ý**, không authority.
- Commit atomic.

---

## 10. Execution Flow — Task Lifecycle

Câu hỏi: **Task → PASSED ra sao?**

```mermaid
sequenceDiagram
    autonumber
    participant Sch as Scheduler
    participant SM as StateMachine
    participant Exec as TaskExecutor
    participant MG as ModelGateway
    participant TG as ToolGateway
    participant WS as Workspace
    participant V as Verification
    participant CG as CompletionGate
    participant E as EventLog

    Sch->>SM: Task READY → RUNNING
    SM->>E: TASK_STATE_CHANGED

    SM->>Exec: Execute(taskRun)
    Exec->>MG: Generate code
    MG-->>Exec: Proposal

    loop Tool calls
        Exec->>TG: ToolCall
        TG->>TG: Schema + Risk + Policy
        alt Need approval
            TG->>TG: AWAITING_HUMAN
        end
        TG->>WS: Execute
        WS-->>TG: Result
        TG->>E: TOOL_CALL_ENDED
    end

    Exec->>SM: TaskRun ended
    SM->>E: TASK_RUN_ENDED

    alt TaskRun SUCCEEDED or FAILED (RUN_ENDED_OK)
        SM->>SM: RUNNING to VERIFYING
        SM->>V: Verify(taskRun)
        V->>V: Compute scope
        V->>V: Capture R_before
        V->>WS: Run checks
        V->>V: Capture R_after
        V->>V: Build report
        V->>E: VERIFICATION_ENDED

        alt PASS and fresh
            V-->>SM: Report PASS
            SM->>CG: Can complete?
            CG->>CG: Check criteria + freshness + scope
            alt OK
                CG-->>SM: COMPLETE
                SM->>SM: VERIFYING to PASSED
                SM->>E: TASK_STATE_CHANGED
            else Fail
                CG-->>SM: REJECT
                SM->>SM: VERIFYING to FAILED
            end
        else FAIL or INVALID or ERROR
            V-->>SM: Report not PASS
            SM->>SM: VERIFYING to FAILED
            SM->>E: FAILURE_DETECTED
        end
    else TaskRun TIMEOUT or INTERRUPTED (RUN_ENDED_ABNORMAL)
        SM->>SM: RUNNING to FAILED (bo qua VERIFYING)
        SM->>E: FAILURE_DETECTED
    else TaskRun CANCELLED
        SM->>SM: RUNNING to ABORTED
        SM->>E: TASK_STATE_CHANGED
    end
```

**Điểm chốt:**
- Không có đường tắt từ RUNNING sang PASSED.
- TaskRun SUCCEEDED/FAILED đi qua VERIFYING; TIMEOUT/INTERRUPTED đi thẳng FAILED (bỏ verify vô nghĩa); CANCELLED sang ABORTED. Xem `STATE_MACHINE_SPEC §4.3, §13.2`.
- Verification bind với revision.
- Completion qua gate. Đường vào PASSED không qua verification duy nhất là human override (`HUMAN_OVERRIDE_PASSED`, xem Diagram 5).

---

## 11. Recovery Flow — Failure → Action

Câu hỏi: **Failure được xử lý thế nào?**

```mermaid
flowchart TB
    Fail[FAILURE_DETECTED] --> Stage{Stage?}
    Stage -->|plan| P[Plan failure]
    Stage -->|execute| E[Execution failure]
    Stage -->|verify| V[Verification failure]
    Stage -->|recover| R[Recovery failure]

    P --> Parser[Deterministic parser]
    E --> Parser
    V --> Parser
    R --> Parser

    Parser --> Known{Known signature?}
    Known -->|yes| Classify[Classify]
    Known -->|no| Analyzer[FailureAnalyzer LLM]
    Analyzer --> Validate[Validate classification]
    Validate --> Classify

    Classify --> FClass{Failure class}

    FClass -->|TRANSIENT| Policy[RecoveryPolicy]
    FClass -->|DEPENDENCY| Policy
    FClass -->|SYNTAX| Policy
    FClass -->|LOGIC| Policy
    FClass -->|ENVIRONMENT| Policy
    FClass -->|TOOL| Policy
    FClass -->|PERMISSION| Policy
    FClass -->|TIMEOUT| Policy
    FClass -->|MODEL_OUTPUT_INVALID| Policy
    FClass -->|UNKNOWN| Policy

    Policy --> Allowed[Allowed actions]
    Allowed --> Budget{Budget ok?}
    Budget -->|no| Escalate[ESCALATE]
    Budget -->|yes| Choose[Choose action]

    Choose --> Retry[RETRY]
    Choose --> Fix[FIX]
    Choose --> Split[SPLIT]
    Choose --> Replace[REPLACE]
    Choose --> Rollback[ROLLBACK]
    Choose --> Replan[REPLAN]
    Choose --> Escalate
    Choose --> Abort[ABORT]

    Retry --> NewRun[New TaskRun]
    Fix --> NewRun
    Split --> Mut[GraphMutation]
    Replace --> Mut
    Replan --> Mut
    Rollback --> NewRun
    Mut --> GraphValidator
    GraphValidator -->|valid| NewRun
    GraphValidator -->|invalid| Abort
    Escalate --> AwaitHuman[AWAITING_HUMAN]
    Abort --> Terminal[ABORTED]

    NewRun --> Task[Task RUNNING]
    Task --> Fail

    DepDead[Predecessor terminal-non-PASSED] --> DepUnreach{Path to PASSED?}
    DepUnreach -->|no| BlockedAbort[DEP_UNREACHABLE to ABORTED]
    DepUnreach -->|yes| StayPending[Stay PENDING]
    BlockedAbort --> Terminal

    NoProgress[NoProgressDetector] -. check .-> Choose
    NoProgress -. bounded .-> Escalate

    classDef fail fill:#ffcdd2,stroke:#b71c1c
    classDef proc fill:#e1f5ff,stroke:#01579b
    classDef action fill:#f3e5f5,stroke:#4a148c
    classDef ok fill:#c8e6c9,stroke:#1b5e20

    class Fail,Abort,Terminal,BlockedAbort fail
    class Parser,Analyzer,Validate,Classify,FClass,Policy,Allowed,Budget,DepUnreach proc
    class Retry,Fix,Split,Replace,Rollback,Replan,Escalate,Choose action
    class NewRun,Task,NoProgress,StayPending ok
```

**Điểm chốt:**
- Recovery **bounded** (budget + policy).
- UNKNOWN không retry vô hạn.
- NoProgressDetector **deterministic** trên tập tín hiệu khả dụng tại phase hiện tại; tín hiệu chưa có (ví dụ `relevantFilesChanged` trước Phase 6) coi là unknown, không gây báo no-progress sai (RC-003).
- Replan tạo **mutation**, không overwrite graph.
- Task PENDING có predecessor terminal-non-PASSED và không còn path đạt PASSED thì chuyển **ABORTED** qua `DEP_UNREACHABLE` (không kẹt vô hạn; SM-L8). Đây là điều kiện graph, không phải failure của một run.

---

## 12. Full Lifecycle Sequence

Câu hỏi: **Một session chạy từ đầu đến cuối thế nào?**

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant VS as VS Code
    participant S as Session
    participant P as Planner
    participant G as GraphStore
    participant Sch as Scheduler
    participant Ex as Executor
    participant V as Verification
    participant R as Recovery
    participant E as Evidence

    U->>VS: "Add feature X"
    VS->>S: Create session
    S->>E: Compute baseline revision R0
    S->>S: Acquire workspace lock
    S->>E: SESSION_CREATED

    Note over S,P: Planning
    S->>P: Plan(goal)
    P->>E: Build context snapshot
    P->>E: Model call (via gateway)
    P-->>S: Plan
    S->>G: Commit graph v1
    G->>E: GRAPH_VERSION_CREATED

    Note over Sch,Ex: Execution Loop
    loop Each task
        Sch->>Sch: Compute READY set
        Sch->>Ex: Schedule next task
        Ex->>E: TASK_RUN_STARTED

        Ex->>E: Tool calls (via gateway)
        Ex->>Ex: Modify workspace

        alt TaskRun SUCCEEDED or FAILED
            Ex->>V: Verify
            V->>E: Capture R_before
            V->>V: Run checks
            V->>E: Capture R_after
            V->>V: Build report
            alt Verification PASS + fresh
                V-->>Ex: PASSED
                Ex->>E: TASK_STATE_CHANGED
            else Verification not PASS
                V-->>Ex: FAILED
                Ex->>R: Analyze failure
                R->>R: Classify
                R->>R: Choose action
                alt Recoverable
                    R->>Sch: New run
                else Escalate
                    R->>U: AWAITING_HUMAN
                else Abort
                    R->>S: ABORT
                end
            end
        else TaskRun TIMEOUT or INTERRUPTED
            Ex->>R: FAILED (bo qua verify), analyze failure
        end
    end

    Note over S,V: Final Verification
    S->>V: Verify whole graph (AFFECTED_CLOSURE)
    V-->>S: Final report

    S->>E: Final checkpoint
    S->>S: Release lock
    S->>E: SESSION_COMPLETED
    S->>VS: Report result
    VS->>U: Done
```

**Điểm chốt:**
- Session giữ workspace lock suốt.
- Mọi action đi qua Control Plane.
- Evidence ghi ở mọi bước.
- Final verification là bước cuối.

---

## 13. Bonus — Invariant Enforcement Map

Câu hỏi: **Mỗi invariant được enforce ở đâu?**

```mermaid
flowchart LR
    subgraph Session["Session"]
        SS1[SS-001 lock]
        SS2[SS-002 transition]
        SS7[SS-007 human]
    end

    subgraph Task["Task"]
        TI1[TI-001 identity]
        TI3[TI-003 no deps]
        SM2[SM-002 no shortcut]
        TI5[TI-005 verified complete]
    end

    subgraph Graph["Graph"]
        GI2[GI-002 validated]
        GI4[GI-004 no cycle]
        GI8[GI-008 atomic]
        GI9[GI-009 no LLM mutate]
    end

    subgraph Security["Security"]
        SE1[SE-001 untrusted]
        SE2[SE-002 injection]
        SE5[SE-005 secrets]
        TG7[TG-007 risk class]
    end

    subgraph Verify["Verification"]
        VR1[VR-001 bind revision]
        VR2[VR-002 freshness]
        VR3[VR-003 scratch]
        VR6[VR-006 append-only]
    end

    subgraph Persist["Persistence"]
        CP1[CP-001 transaction]
        CP2[CP-002 checkpoint meta atomic]
        CP10[CP-010 hash is claim]
        CP11[CP-011 drift at capture]
        CP12[CP-012 drift on load]
        CP8[CP-008 event append-only]
        PR3[PR-003 provenance]
    end

    subgraph Arch["Architecture"]
        DC1[DC-001 domain independent]
        DC3[DC-003 no infra import]
    end

    Session -. enforced by .-> CP1
    Task -. enforced by .-> SM2
    Graph -. enforced by .-> GI8
    Security -. enforced by .-> SE2
    Verify -. enforced by .-> VR1
    Persist -. enforced by .-> CP1
    Arch -. enforced by .-> DC1

    classDef sess fill:#e1f5ff,stroke:#01579b
    classDef task fill:#fff3e0,stroke:#e65100
    classDef graphcls fill:#f3e5f5,stroke:#4a148c
    classDef sec fill:#ffcdd2,stroke:#b71c1c
    classDef ver fill:#e8f5e9,stroke:#1b5e20
    classDef per fill:#fce4ec,stroke:#880e4f
    classDef arch fill:#eceff1,stroke:#263238

    class SS1,SS2,SS7 sess
    class TI1,TI3,SM2,TI5 task
    class GI2,GI4,GI8,GI9 graphcls
    class SE1,SE2,SE5,TG7 sec
    class VR1,VR2,VR3,VR6 ver
    class CP1,CP2,CP10,CP11,CP12,CP8,PR3 per
    class DC1,DC3 arch
```

---

## 14. Ghi chú kỹ thuật

### 14.1 Render Mermaid

**VS Code:**
```bash
code --install-extension bierner.markdown-mermaid
```

**GitHub:** render tự động trong `.md` files.

**GitLab:** render tự động.

**Obsidian:** render tự động.

**Export PNG/SVG:**
```bash
npx @mermaid-js/mermaid-cli -i ARCHITECTURE_DIAGRAMS.md -o diagrams/
```

### 14.2 Convention

| Ký hiệu | Nghĩa |
|---|---|
| `-->` | Luồng bình thường |
| `-.->` | Proposal / adapter / non-authority |
| `-.x.->` | **Forbidden** (không được phép) |
| `(( ))` | Terminal / user |
| `[( )]` | Storage |
| `[ ]` | Component |
| `{ }` | Decision |
| `[[ ]]` | Subroutine |

### 14.3 Color palette

| Color | Meaning |
|---|---|
| 🟦 Xanh dương nhạt | Control Plane |
| 🟧 Cam nhạt | Intelligence Plane |
| 🟪 Tím nhạt | Execution Plane |
| 🟩 Xanh lá nhạt | Verification Plane |
| 🟥 Hồng nhạt | Evidence Plane |
| ⬜ Xám nhạt | Infrastructure |
| 🟥 Đỏ | Deny / reject |
| 🟨 Vàng | Human / approval |
| 🟩 Xanh đậm | Success |

### 14.4 Cập nhật diagram

Khi architecture thay đổi:

1. Update spec tương ứng.
2. Update diagram trong file này.
3. Bump version.
4. Ghi change log.

### 14.5 Change log

| Version | Ngày | Thay đổi |
|---|---|---|
| 1.0 | (baseline) | 13 diagrams ban đầu. |
| 1.1 | 2026-09-14 | **Sửa lỗi render:** thay cú pháp cạnh không hợp lệ `-.x.->` (Diagram 7, 8) và `classDef graph` (từ reserved, Diagram 13) bằng cú pháp hợp lệ; chuẩn hóa nhãn dotted link nhiều từ thành `-. text .->`. Bỏ emoji/em-dash trong subgraph title Diagram 1, 2 và thêm init spacing cho dễ đọc. **Đồng bộ nội dung với spec sau các bản vá:** Diagram 5 thêm nhánh human override (`HUMAN_OVERRIDE_PASSED`); Diagram 6 phản ánh checkpoint hash-claim + `CHECKPOINT_DIRTY_AT_CAPTURE`; Diagram 10, 12 tách nhánh TaskRun (RUN_ENDED_OK vs RUN_ENDED_ABNORMAL); Diagram 11 thêm `DEP_UNREACHABLE` + graceful degradation NoProgress; Diagram 13 thêm CP-010..012. Đã validate 13/13 diagram bằng mermaid parser. |

---

## 15. North Star

> **Một diagram tốt thay thế 1000 dòng spec. Nhưng nó phải trung thực.**

Mỗi diagram trong file này trả lời một câu hỏi cụ thể:

- **Component nào** tồn tại?
- **Ai** gọi ai?
- **Cái gì** được enforce ở đâu?
- **Đường nào** bị chặn?
- **Bằng chứng** lưu ở đâu?

Và câu hỏi cuối cùng:

> **Nếu một kỹ sư mới nhìn vào diagram này, họ có hiểu ngay LLM không có authority không?**

Nếu có → diagrams đúng.
Nếu không → diagrams cần sửa.

---


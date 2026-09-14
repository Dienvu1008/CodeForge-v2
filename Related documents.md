Nguyên tắc cốt lõi **"LLM proposes, deterministic runtime decides"** .

### 📜 Các thuật ngữ và tài liệu liên quan

Dưới đây là các khái niệm và tài liệu có chung triết lý với thiết kế:

*   **Stochastic-Deterministic Boundary (SDB)**: Khái niệm gần gũi nhất với kiến trúc. Bài báo *"A Methodology for Selecting and Composing Runtime Architecture Patterns for Production LLM Agents"* (arXiv:2605.20173) định nghĩa SDB là một **hợp đồng bốn phần** giữa **Proposer** (LLM), **Verifier** (kiểm tra deterministic), **Commit** (ghi bền vững) và **Reject Signal** (phản hồi lỗi). Đây chính xác là mô hình "LLM proposes, runtime decides" mà tôi đã xây dựng.

*   **Agent Harness**: Bài khảo sát *"Awesome Agent Harness"* (HuggingFace) định nghĩa Agent = **Model (Stochastic Intelligence)** + **Harness (Deterministic Infrastructure)**. Harness được chia thành 4 lớp, trong đó **Layer 4 (Constraints & Guardrails)** chính là nơi thực thi các "deterministic laws" như access control, permission management và defense against agent injection.

*   **Deterministic AI Orchestration**: Praetorian đề xuất sử dụng **deterministic hooks** (PreToolUse, PostToolUse, Stop) để inject logic mà LLM **không thể bypass**, với mô hình **8-layer defense in depth**. Đây là hiện thực hóa cụ thể của tầng enforcement trong kiến trúc.

*   **Policy-Based Agentic Systems (PBAS)**: Framework **DAF** (Deterministic Agentic Framework) triển khai mô hình "The model proposes. The system governs." với **Policy Engine** là deterministic (no LLM calls), đánh giá plan của LLM dựa trên **PolicyMatrix** được định nghĩa trong YAML.

*   **Decision Intelligence Runtime (DIR)**: Kiến trúc lấy cảm hứng từ OS, tách biệt rõ ràng **probabilistic LLM reasoning (User Space)** và **deterministic execution (Kernel Space)**. DIR bao gồm **Decision Integrity Module (DIM)**, JIT state verification, và cryptographic idempotency guards.

*   **AIKernel Semantic DSL**: LLM không trực tiếp execute code, mà generate một **Semantic DSL** (non-Turing-complete). Runtime parse DSL thành **Semantic IR**, thực hiện **admissibility checking** (capabilities, policies, bounded loops, provenance), rồi compile thành **governed deterministic pipeline** có thể audit và replay.

### 🧩 Tổng hợp và đánh giá

| Khía cạnh trong kiến trúc  | Tài liệu/khái niệm tương ứng |
|---|---|
| **Nguyên tắc "LLM proposes, runtime decides"** | SDB, Agent Harness, PBAS, DIR |
| **Enforcement points (ToolGateway, PolicyEngine)** | SDB (Verifier), DAF (Policy Engine) |
| **Deterministic transition functions** | DIR (Kernel Space), AIKernel (Semantic IR) |
| **Invariant testing từ Phase 0** | agent-runtime-integrity-bench (fault-injection checks) |
| **Adversarial model harness** | Microsoft AGT, LATTICE (governance-first architecture) |
| **WorkspaceRevision + canonical hash** | DIR (JIT state verification, Proof-Carrying Intents) |
| **Recovery engine với bounded actions** | ESAA (Event Sourcing for Autonomous Agents) |

**Sự khác biệt **:
1.  **Mức độ cụ thể hóa**: Các tài liệu trên thường ở mức khái niệm hoặc framework chung. Kiến trúc này đã đi xa hơn khi định nghĩa **từng invariant, từng state transition, từng transaction boundary** một cách chi tiết.
2.  **Tính hệ thống**: Tôi đã kết hợp các ý tưởng từ nhiều nguồn (SDB, Agent Harness, DIR, AIKernel) thành một **kiến trúc thống nhất** với roadmap rõ ràng từ Phase 0 đến Phase 8.
3.  **Evaluation Model hai trục**: Việc tách **Runtime Integrity** và **Task Correctness** thành hai trục độc lập là một đóng góp quan trọng, giúp đánh giá đúng bản chất vấn đề.

Tóm lại, tôi đã **không phát minh lại bánh xe**, mà đã **thiết kế một chiếc xe hoàn chỉnh từ những bánh xe tốt nhất** đang có trên thị trường nghiên cứu, với bản thiết kế kỹ thuật chi tiết và lộ trình triển khai cụ thể.

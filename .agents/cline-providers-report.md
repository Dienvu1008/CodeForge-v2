# Cline Provider Investigation Report

**Date:** 2025  
**Task:** Tìm hiểu các provider LLM mà Cline hỗ trợ, đặc biệt free-tier / fast, và đánh giá khả năng tích hợp vào CodeForge.

---

## Tóm tắt (Summary First)

Cline hỗ trợ hơn **40 provider** LLM. Hầu hết đều dùng định dạng **OpenAI-compatible** (`POST /v1/chat/completions`). CodeForge đã có sẵn `OpenAiCompatibleModelGateway` trong `packages/infrastructure/src/model/openai-compatible-gateway.ts` — vì vậy **hầu hết provider Cline đều có thể dùng được ngay trong CodeForge mà không cần thêm code adapter**. Chỉ cần thêm một cấu hình `endpoint` + `apiKey` là xong. Một số provider đặc biệt thú vị cho free/fast:

- **OpenRouter** — 200+ models, nhiều model free (tag `free`), một API key duy nhất
- **Groq** — tốc độ cực nhanh (LPU inference), free tier hào phóng
- **Cerebras** — inference rất nhanh, free tier
- **SambaNova** — free tier cho Llama 3.x
- **DeepSeek** — giá rẻ nhất cho class của mình, API OpenAI-compatible
- **Gemini (Google AI Studio)** — free tier, nhưng cần adapter native (đã có trong CodeForge)
- **Qwen Code** — **miễn phí hoàn toàn**, `qwen3-coder-plus` và `qwen3-coder-flash`, context 1M tokens
- **ClinePass** ($9.99/tháng) — DeepSeek, GLM, Kimi, MiniMax, MiMo, Qwen — đây là những model người dùng đang thấy "chạy nhanh và tốt"

---

## 1. Toàn bộ Provider Cline Hỗ Trợ

### 1A. Provider Có Trang Config Riêng (First-Class)

| Provider ID | Models Tiêu Biểu | API Format | Auth | Base URL |
|---|---|---|---|---|
| `anthropic` | Claude Opus/Sonnet/Haiku | Native Anthropic SDK | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` |
| `claude-code` | Claude (qua subscription) | Claude CLI subprocess | OAuth (Max/Pro sub) | N/A |
| `openai` | GPT-4o, GPT-4.1, o4 | OpenAI native | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `openai-codex` | Codex (OpenAI) | OAuth | Browser OAuth | N/A |
| `openrouter` | 200+ models | **OpenAI-compatible** | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `gemini` | Gemini 2.5 Pro/Flash | Native Gemini API | `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| `deepseek` | DeepSeek V3/R1 | **OpenAI-compatible** | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| `minimax` | MiniMax-M2 series | Native MiniMax | API key | `https://api.minimax.io` |
| `qwen` (Alibaba) | Qwen-Max/Plus/Turbo | **OpenAI-compatible** | `QWEN_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `zai` / `zhipu` | GLM-4.5 series | Native? | API key | `https://api.z.ai/api/paas/v4` (Intl) |
| `poolside` | Poolside coding models | **OpenAI-compatible** | API key | Auto-configured |
| `aws-bedrock` | Claude, Llama, Amazon Nova | AWS Bedrock SDK | `AWS_ACCESS_KEY_ID` + IAM | AWS Bedrock endpoint |
| `ollama` | Any local model | Ollama API | None | `http://localhost:11434` |
| `lm-studio` | Any local model | **OpenAI-compatible** | None | `http://localhost:1234/v1` |
| `atomic-chat` | Any local model | **OpenAI-compatible** | None | `http://127.0.0.1:1337/v1` |
| `cline` | 100+ models (BYOC) | Via Cline gateway | Cline account | app.cline.bot |
| `cline-pass` | Curated open models | Via Cline gateway | Subscription | app.cline.bot |

### 1B. Provider "Other 30+" (Cùng Flow Config)

Tất cả đều dùng **OpenAI-compatible** hoặc rất gần, auth bằng API key thông thường:

| Provider | Website | Loại |
|---|---|---|
| ai& (AiAnd) | aiand.com | OpenAI-compat, sovereign inference Japan |
| AIHubMix | aihubmix.com | OpenAI-compat aggregator |
| AskSage | asksage.ai | Enterprise/government |
| Avian | avian.io | OpenAI-compat, base URL: `https://api.avian.io/v1` |
| Baseten | baseten.co | Hosted model APIs |
| **Cerebras** | cloud.cerebras.ai | **Rất nhanh**, free tier |
| CoreWeave | inference.wandb.ai/v1 | OpenAI-compat, W&B key |
| Crusoe | crusoe.ai | Renewable GPU, managed inference |
| Dify.ai | dify.ai | Workflow platform |
| Doubao | volcengine.com | ByteDance (Chinese market) |
| Fireworks AI | fireworks.ai | Fast inference, open models |
| GCP Vertex AI | cloud.google.com | Google Cloud enterprise |
| **Groq** | groq.com | **LPU, tốc độ cao, free tier** |
| Hicap | hicap.ai | OpenAI-compat, multimodal |
| Huawei Cloud MaaS | huaweicloud.com | Chinese enterprise |
| Hugging Face | huggingface.co | Open model hosting |
| Mistral | mistral.ai | Native Mistral API |
| **Moonshot (Kimi)** | platform.moonshot.ai | Kimi models, context dài |
| Nebius AI Studio | studio.nebius.com | Hosted inference |
| Nous Research | nousresearch.com | Hermes family |
| Oracle Code Assist | oracle.com | OCI enterprise |
| **Qwen Code** | chat.qwen.ai | **Miễn phí**, coding models |
| Requesty | requesty.ai | Multi-provider router |
| **SambaNova** | sambanova.ai | **Free tier**, Llama 3.1/3.3 |
| SAP AI Core | sap.com | Enterprise |
| Together | together.ai | OpenAI-compat, open models |
| Vercel AI Gateway | vercel.com | Multi-provider gateway |
| VS Code LM API | VS Code built-in | VS Code host models |
| xAI (Grok) | x.ai | Grok models |

---

## 2. Providers Dùng OpenAI-Compatible Format (Dễ tích hợp nhất vào CodeForge)

Các provider sau **dùng đúng format `POST /v1/chat/completions`** — CodeForge có thể dùng ngay với `OpenAiCompatibleModelGateway` hiện có, chỉ cần cấu hình `baseUrl` + `apiKey`:

| Provider | Base URL | API Key Env Var | Ghi chú |
|---|---|---|---|
| **OpenRouter** | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 200+ models, nhiều model free |
| **DeepSeek** | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | Rẻ, DeepSeek-V3/R1 |
| **Groq** | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | LPU inference, cực nhanh, free tier |
| **Cerebras** | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | Nhanh, free tier |
| **Together AI** | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | Open models |
| **Fireworks AI** | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` | Nhanh |
| **SambaNova** | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` | Free tier, Llama |
| **Mistral** | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | Mistral/Codestral |
| **Moonshot (Kimi)** | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | Context dài |
| **xAI (Grok)** | `https://api.x.ai/v1` | `XAI_API_KEY` | Grok-3 |
| **Qwen (Alibaba)** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `QWEN_API_KEY` | |
| **Avian** | `https://api.avian.io/v1` | `AVIAN_API_KEY` | |
| **Hugging Face** | `https://api-inference.huggingface.co/v1` | `HF_TOKEN` | |
| **CoreWeave** | `https://api.inference.wandb.ai/v1` | W&B API key | |
| **LM Studio** (local) | `http://localhost:1234/v1` | None | Local |
| **Ollama** (via OpenAI) | `http://localhost:11434/v1` | None | Local |
| **Poolside** | Auto từ Cline | API key | Coding-focused |
| **AIHubMix** | `https://aihubmix.com/v1` | API key | Aggregator |

> **Lưu ý quan trọng:** CodeForge hiện tại đã có `OpenAiCompatibleModelGateway`. Groq có một quirk: model `gpt-oss-*` trả lời qua tool-call thay vì `content`. CodeForge đã xử lý điều này với flag `preferToolJson` (auto-enable cho domain `groq.com`) — xem `openai-compatible-gateway.ts:L287-291`.

---

## 3. Providers Dùng Format Không Phải OpenAI (Cần Adapter Riêng)

| Provider | Format Khác Gì? | CodeForge Status |
|---|---|---|
| **Anthropic** | `POST /v1/messages`, body có `messages[]`, response `content[]`, không có `choices[]` | ❌ Chưa có adapter |
| **Google Gemini** (native) | `POST /models/{model}:generateContent`, auth qua `x-goog-api-key` header, body `contents[].parts[].text` | ✅ Đã có `GeminiModelGateway` |
| **AWS Bedrock** | AWS SigV4 signing, InvokeModel / InvokeModelWithResponseStream API, per-model body format | ❌ Chưa có adapter |
| **Z AI (Zhipu/GLM)** | Endpoint: `https://api.z.ai/api/paas/v4` — dạng OpenAI-compat nhưng path khác | Có thể dùng `openai-compatible` |
| **MiniMax** | Native MiniMax API | ❌ Chưa có adapter |
| **VS Code LM API** | VS Code extension API, không phải HTTP | ❌ N/A |
| **Claude Code** | CLI subprocess | ❌ N/A |

---

## 4. Provider IDs / Enum trong Codebase Cline

Dựa trên tài liệu và codebase Cline (file `src/api/providers/`), provider IDs đã được xác nhận:

```
anthropic          openai             openrouter         google-gemini
deepseek           minimax            qwen               zai
poolside           aws-bedrock        vertex             ollama
lm-studio          atomic-chat        openai-compatible  vscode-lm
cline              cline-pass         
cerebras           groq               together           fireworks
mistral            moonshot           sambanova          nebius
huggingface        requesty           doubao             dify
baseten            corweave           crusoe             aiand
aihubmix           hicap              huawei-maas        nous
oracle-code-assist qwen-code          sap-ai-core        vercel-ai-gateway
asksage            xai
```

> **Nguồn:** `https://github.com/cline/cline/blob/main/.clinerules/cline-overview.md` (architecture doc) + `https://docs.cline.bot/provider-config/*` (mỗi trang provider)

---

## 5. Free-Tier / Fast Models Người Dùng Đang Thấy Tốt

Đây là các provider/model mà người dùng "thấy chạy nhanh và tốt hơn local" — tất cả đều miễn phí hoặc rẻ:

### 5A. Cline Free Models (Cần tài khoản Cline)
- Models tagged `FREE` trong `Cline (usage-billing)` provider
- Free quota có giới hạn, sau đó cần ClinePass hoặc BYOK

### 5B. ClinePass Models ($9.99/tháng — "curated open models")
Đây là những gì người dùng đang dùng qua Cline:
- **DeepSeek V4.1 Flash** — `cline-pass/deepseek-v4.1-flash` — nhanh, coding
- **DeepSeek V4.1 Flash 1017** — off-peak giá $0.15/1M token input
- **GLM 5.3 Flash** — `cline-pass/glm-5.3-flash` — $0.15/1M, Zhipu AI
- **MiniMax M3.1 Flash** — `cline-pass/minimax-m3.1-flash` — $0.15/1M
- **MiMo V2.6 Flash** — `cline-pass/mimo-v2.6-flash` — $0.14/1M
- **Muse Spark 1.3** — `cline-pass/muse-spark-1.3-contributor` — $0.10/1M
- **Kimi K3.1 Pro** — `cline-pass/kimi-k3.1-pro` — context dài
- **Qwen3.7 Plus / Max** — $0.40 / $2.50 /1M input

### 5C. Provider Free Tier Thực Sự (BYOK, tức là hoàn toàn miễn phí)

| Provider | Models Free | Giới hạn |
|---|---|---|
| **Google AI Studio** | Gemini 2.0 Flash, Gemini 2.5 Flash | Rate limit 15 RPM free |
| **Groq** | Llama 3.1 8B/70B, Gemma, DeepSeek-R1 | 14.4k TPM / 6k RPD free |
| **Cerebras** | Llama 3.1 8B/70B, Qwen | Generous free tier |
| **SambaNova** | Llama 3.1 405B, Llama 3.3 70B | Free tier available |
| **Qwen Code** | `qwen3-coder-plus`, `qwen3-coder-flash` (1M ctx) | **Miễn phí hoàn toàn** |
| **OpenRouter** | Models với tag `free` (VD: `meta-llama/llama-3.1-8b-instruct:free`) | Free models có rate limit |

---

## 6. CodeForge: Hiện Trạng và Đề Xuất

### Hiện Trạng CodeForge

CodeForge hiện có 3 adapter:

1. **`OllamaModelGateway`** — Ollama local API
2. **`OpenAiCompatibleModelGateway`** — OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Together, v.v.)
3. **`GeminiModelGateway`** — Google Gemini native API

Provider types: `'ollama' | 'openai-compatible' | 'gemini'` (xem `provider-adapter.ts:L20`)

Cấu hình qua `--provider`, `--model`, `--endpoint`, `--api-key` ở runtime CLI, hoặc qua file `--model-routes` cho per-purpose routing.

VS Code extension có 1 setting: `codeforge.model` (default: `qwen2.5-coder:latest`) — chưa expose endpoint/provider/api-key qua VS Code settings.

### Đề Xuất

#### Điều Có Thể Làm Ngay (Không Cần Thay Đổi Code)

Cài đặt CodeForge runtime với `--provider openai-compatible` + endpoint của provider muốn dùng:

```bash
# OpenRouter (nhiều model free)
node runtime-cli.js \
  --provider openai-compatible \
  --endpoint https://openrouter.ai/api/v1 \
  --model meta-llama/llama-3.1-8b-instruct:free \
  --api-key sk-or-v1-xxx

# Groq (tốc độ cực nhanh)
node runtime-cli.js \
  --provider openai-compatible \
  --endpoint https://api.groq.com/openai/v1 \
  --model llama-3.1-70b-versatile \
  --api-key gsk_xxx

# DeepSeek (rẻ + tốt)
node runtime-cli.js \
  --provider openai-compatible \
  --endpoint https://api.deepseek.com/v1 \
  --model deepseek-chat \
  --api-key sk-xxx

# Gemini (đã có adapter native, free tier)
node runtime-cli.js \
  --provider gemini \
  --model gemini-2.0-flash-exp \
  --api-key AIza-xxx

# Cerebras (free tier, nhanh)
node runtime-cli.js \
  --provider openai-compatible \
  --endpoint https://api.cerebras.ai/v1 \
  --model llama3.1-70b \
  --api-key csk-xxx
```

Dùng file `--model-routes` để route từng mục đích (plan/execute) đến model khác nhau:

```json
{
  "routes": {
    "plan": {
      "provider": "openai-compatible",
      "model": "deepseek/deepseek-chat",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "execute": {
      "provider": "openai-compatible", 
      "model": "meta-llama/llama-3.1-8b-instruct:free",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

#### Cải Tiến Nên Làm (Cần Code Nhỏ)

1. **Expose provider/endpoint/apiKey qua VS Code settings** — hiện tại `codeforge.model` là string đơn giản, không có `codeforge.provider`, `codeforge.endpoint`, `codeforge.apiKey`. Thêm 3 settings này vào `vscode-extension/package.json` → `configuration.properties` để người dùng VS Code có thể cấu hình cloud providers từ Settings UI.

2. **Thêm Anthropic adapter** — nếu muốn dùng Claude trực tiếp (không qua OpenRouter). Anthropic dùng `POST /v1/messages` với format khác. Có thể tham khảo cách Cline làm trong `src/api/providers/anthropic.ts`.

3. **Thêm preset provider list** — một danh sách các provider well-known với base URL mặc định, giúp người dùng chọn từ dropdown thay phải gõ URL.

#### Không Cần Làm (Đã Có Sẵn)
- AWS Bedrock: phức tạp, cần AWS SDK + SigV4, ít phù hợp cho cá nhân
- VS Code LM API: chỉ chạy trong VS Code extension context
- Claude Code: CLI subprocess, không phù hợp cho agentic coding

---

## 7. Kết Luận

**Câu trả lời trực tiếp cho câu hỏi người dùng:**

Có, CodeForge **có thể dùng ngay** hầu hết các model free/fast mà Cline đang chạy tốt. Hầu hết đều dùng OpenAI-compatible API, và CodeForge đã có `OpenAiCompatibleModelGateway` sẵn. Người dùng chỉ cần:

1. Lấy API key từ provider (Groq/Cerebras/SambaNova free; OpenRouter free models; Qwen Code miễn phí)
2. Chạy runtime với `--provider openai-compatible --endpoint <url> --model <id> --api-key <key>`

**Model được đề xuất thử đầu tiên** (theo thứ tự từ dễ đến tốt hơn):
1. `Qwen Code` — hoàn toàn miễn phí, context 1M, coding-optimized
2. `Groq` — free tier, Llama 3.1 70B nhanh nhất hiện tại
3. `OpenRouter free models` — nhiều lựa chọn, 1 API key cho tất cả
4. `DeepSeek` qua `api.deepseek.com` — rất rẻ ($0.15/1M), chất lượng cao
5. `Gemini 2.0 Flash` — free tier hào phóng từ Google AI Studio

---

*Content was rephrased for compliance with licensing restrictions. Sources: https://github.com/cline/cline, https://docs.cline.bot, CodeForge v2 source at packages/infrastructure/src/model/*

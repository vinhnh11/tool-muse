# API contract - Batch Video Studio

Base: cùng origin với web (server phục vụ cả `/api/*` và `web/dist`). Dev: Vite dev server proxy `/api` → `http://127.0.0.1:7878`.

## Quy ước chung

- Đăng nhập bằng cookie HttpOnly `bvs_session` (POST /api/auth/login hoặc /api/auth/setup).
- MỌI request ghi (POST/PUT/PATCH/DELETE) từ trình duyệt PHẢI gửi header `X-BVS-Request: 1` (chống CSRF) và `Content-Type: application/json` (trừ upload multipart).
- Workspace: header `X-Workspace-Id` (tùy chọn - mặc định workspace đầu tiên của user).
- Lỗi: HTTP 4xx/5xx với body `{ "error": { "code": string, "message": string (tiếng Việt, hiển thị được), "details": any|null } }`.
- 401 `UNAUTHORIZED` → chuyển về màn đăng nhập. 409 thường là "cần xác nhận/cấu hình". 422 `BATCH_INVALID` có `details` = BatchCheck.
- API KHÔNG BAO GIỜ trả secret: provider chỉ có `hasApiKey: boolean`; LLM settings chỉ có `hasApiKey`.

## Auth
- GET  /api/auth/setup-status → `{ needsSetup: boolean }` (không cần đăng nhập)
- POST /api/auth/setup `{ username, password }` → `{ user }` (tạo admin đầu tiên + đăng nhập)
- POST /api/auth/login `{ username, password }` → `{ user }`
- POST /api/auth/logout → `{ ok }`
- GET  /api/auth/me → `{ user:{id,username,role}, via, workspaceId, workspaces:[{id,name,role}] }`
- GET/POST/DELETE /api/tokens[/:id] - API token cho Hermes/CLI/MCP. POST `{name}` → `{ id, token, note }` (token hiện 1 lần)

## Cài đặt
- GET /api/settings/llm → `{ baseUrl, textModel, visionModel, audioModel, hasApiKey, updatedAt }`
- PUT /api/settings/llm `{ baseUrl?, textModel?, visionModel?, audioModel?, apiKey?: string|null }` (apiKey chỉ gửi khi đổi; null = xóa)
- GET /api/settings/system → `{ workerMode, editInboxConfigured, webhookBaseConfigured }`
- GET /api/audit → `{ entries:[{id,user_id,actor,action,target_type,target_id,data_json,created_at}] }`

## Provider
- GET /api/providers/types → `{ types:[{type,label,authType,defaultEndpoint,defaultModels,defaultConcurrency,defaultRpm}] }`
- GET /api/providers → `{ providers: ProviderConfig[] }`
- POST /api/providers `{ providerType, name?, endpoint?, modelIds?, defaultModelId?, maxConcurrency?, requestsPerMinute?, options?, apiKey?, enableWebhook?, enabled? }`
- PATCH /api/providers/:id (cùng trường, apiKey chỉ khi đổi) ; DELETE /api/providers/:id (vô hiệu hóa)
- POST /api/providers/:id/test → `{ ok, message }` (không tạo video)

### muse2api (Muse qua cổng muse2api)
`providerType: "muse2api"` — gọi service RIÊNG [muse2api](https://github.com/czg86389-hub/muse2api) (mặc định `http://127.0.0.1:18610`), service đó lái web muse.ai bằng Chromium/CDP. BVS chỉ nói HTTP với nó, không nhúng browser.
- `endpoint` = địa chỉ muse2api, `apiKey` = `MUSE2API_KEY`. Dùng: `POST /v1/videos` → `GET /v1/videos/{id}` (poll, có progress thật) → tải `/v1/media/{file}` (không đòi Authorization).
- `options.extraPrompt` nối thêm chỉ dẫn cố định vào mọi prompt; `options.videoTimeoutSec` đặt hạn chờ phía muse2api.
- Năng lực: chỉ `muse-video`, 5/6/8/10 giây, chỉ `9:16` và `16:9`, 720p, không audio, không negative prompt, không seed, tối đa 1 ảnh (khung đầu).
- **`pricing: "unknown"`** — không trả tiền theo request NHƯNG tiêu hạn mức tài khoản Muse, nên BVS vẫn buộc người dùng duyệt (`acknowledgeUnknownCost: true`) và trợ lý/agent KHÔNG được tự chạy.
- `cancel: "none"` (không có API hủy), `idempotency: false` (không gửi lại cùng key → tránh tạo trùng, tiêu hạn mức 2 lần).
- `POST /api/providers/:id/test` gọi `/v1/models` + `/readyz`: báo rõ khi pool chưa có tài khoản Muse. Không tạo video.

ProviderConfig:
```
{ id, providerType: "mock"|"seedance-byteplus"|"muse2api", name, endpoint, authType, modelIds: string[], defaultModelId,
  enabled, maxConcurrency, requestsPerMinute, options: { pricePerSecond?: {"480p":n,"720p":n,"1080p":n}, pricePerMillionTokens?, currency?, latencyMs?, pollIntervalMs?, watermark?, extraPrompt?, videoTimeoutSec? },
  hasApiKey, webhookEnabled, lastTest:{ok,message,at}|null, status:"active"|"disabled"|"needs_key",
  capabilities: { providerType, label, cancel:"none"|"queued_only"|"any", idempotency, progress, webhook, concurrencyHint, pricing:"free-mock"|"user-configured"|"unknown", docsUrl,
     models: [{ modelId, label, verified, modes:["text-to-video"|"image-to-video"|"reference-to-video"], durations:{min,max,auto}, aspectRatios:string[], resolutions:string[], defaultResolution, audio, negativePrompt, maxPromptChars, maxReferenceImages, qualityModes:string[], seed, notes:string[] }] },
  createdAt, updatedAt }
```

## Phiên làm việc, skill, chat
- GET /api/sessions → `{ sessions:[{id,title,skillMode:"auto"|"manual"|"none",skillIds,createdAt,updatedAt}] }`
- POST /api/sessions `{ title? }` ; GET/PATCH /api/sessions/:id `{ title?, skillMode?, skillIds? }`
- GET /api/skills → `{ skills:[{id,name,description,genres}] }`
- GET /api/sessions/:id/chat → `{ messages: ChatMessage[] }`
- POST /api/sessions/:id/chat `{ message, mode?:"auto"|"manual", skillIds?, providerConfigId?, modelId?, attachments?:{ assetIds?:string[], text?:{fileName,content} } }` → `{ messages: ChatMessage[] }` (các tin mới: user, assistant, tool...). Có thể mất 10-120s (LLM).

ChatMessage: `{ id, role:"user"|"assistant"|"tool", content, toolCalls:[{id,name,arguments}]|null, toolCallId, toolName, createdAt }`
- Tin `tool` có `content` = JSON kết quả tool. Hiển thị dạng thẻ: nếu `toolName==="video_create_batch"` → thẻ "Batch chờ duyệt" (batchId, summary, estimate.total/currency/kind) với nút "Duyệt & chạy" (mở dialog xác nhận như màn Batch). Nếu JSON có `needsUserApproval:true` → thẻ yêu cầu người dùng xác nhận. `video_generate_prompts` → thẻ bộ prompt (promptSetId, generated/requested, nút "Mở để duyệt"). Có `error` → thẻ lỗi.

## Asset
- GET /api/assets?kind=reference|image|generated&sessionId=&library=1 → `{ assets: Asset[] }`
- POST /api/assets?kind=reference&sessionId= (multipart, field `file`, nhiều file) → `{ assets: Asset[] }`
- GET /api/assets/:id ; file: GET /api/assets/:id/file (Range; `?download=1` để tải), /preview (bản phát được trên trình duyệt), /thumbnail
- POST /api/assets/library `{ assetIds, inLibrary?:boolean }` → `{ updated }`
- POST /api/assets/zip `{ assetIds }` → file ZIP (dùng fetch + blob hoặc form POST)
- POST /api/assets/:id/send-to-edit → `{ path }` hoặc 409 EDIT_INBOX_NOT_CONFIGURED
- POST /api/assets/delete `{ assetIds }` → `{ deleted:string[], skipped:[{id,reason}], freedBytes }` - XÓA HẲN file trên đĩa (video + thumbnail + bản xem) và dòng DB; không hoàn tác. Asset đang được job CHƯA xong dùng làm tham chiếu bị bỏ qua (`skipped`). Job giữ nguyên prompt/chi phí, chỉ `outputAssetId` thành null.
- DELETE /api/assets/:id → `{ deleted, freedBytes }` - như trên cho một asset; 409 ASSET_IN_USE nếu đang được job chưa xong dùng làm tham chiếu.
- POST /api/assets/prune-orphans → `{ removedDirs, freedBytes }` - dọn thư mục `ast_*` còn trên đĩa mà không còn trong DB.

Asset: `{ id, sessionId, kind, origin, fileName, mime, sizeBytes, sha256, durationSec, width, height, fps, videoCodec, hasAudio, inLibrary, sourceJobId, urls:{file,preview,thumbnail,download}, createdAt }`

## Prompt
- POST /api/prompts/parse `{ text, fileName?, format? }` → `{ format, items:[{line,draft:{prompt,title?,negative?,durationSec?,aspectRatio?}}], blankLines:number[], errors, check:{totalLines,blankLines,duplicates:[{line,duplicateOfLine}],nearDuplicates:[{line,similarToLine,score}],uniqueLines}, summary }`
- POST /api/prompts/check `{ providerConfigId, modelId, config, prompts:PromptInput[], blankLines?, lines? }` → BatchCheck
- GET /api/prompt-sets?sessionId= → `{ sets:[{id,name,source,counts:{total,approved,rejected},createdAt}] }`
- POST /api/prompt-sets `{ name, sessionId?, items?:PromptInput[] | text?:string, fileName? }`
- POST /api/prompt-sets/generate `{ sessionId?, count, durationSec, aspectRatio, providerConfigId, modelId, genres?:string[], brief?, consistency?:{product?,brand?,character?}, referenceAssetIds?, language?:"vi"|"en", name? }` → `{ set, requested, generated, shortfall, duplicatesRemoved, nearDuplicates, message }` (LLM - có thể lâu)
- GET /api/prompt-sets/:id → `{ id, name, source, params, items: PromptItem[], counts }`
- POST /api/prompt-sets/:id/items `{ items: PromptInput[] }` ; POST /api/prompt-sets/:id/approval `{ itemIds: string[]|"all", approval:"approved"|"rejected"|"pending" }`
- GET /api/prompt-sets/:id/export?format=txt|csv|json&onlyApproved=1
- PATCH /api/prompt-items/:id `{ title?, objective?, prompt?, negative?, durationSec?, aspectRatio?, approval? }` ; DELETE /api/prompt-items/:id
- POST /api/prompt-items/:id/duplicate ; POST /api/prompt-items/:id/rewrite `{ instruction, providerConfigId, modelId }`

PromptItem: `{ id, setId, index, title, objective, prompt, negative, model, durationSec, aspectRatio, genre, referenceAssetIds, approval:"pending"|"approved"|"rejected" }`
PromptInput: `{ prompt, title?, negative?, durationSec?, aspectRatio?, referenceAssetIds?, promptItemId? }`

## Batch
BatchConfig: `{ mode:"text-to-video"|"image-to-video"|"reference-to-video", durationSec (-1 = model tự chọn), aspectRatio, resolution, audio:boolean, quality:string|null, variantsPerPrompt (1-10), referenceAssetIds:string[], maxAttempts }`

- POST /api/batches/estimate `{ providerConfigId, modelId, config, prompts:PromptInput[], maxConcurrency, budgetLimit?, blankLines?, lines? }` → `{ check: BatchCheck, estimate: BatchEstimate }`
- POST /api/batches `{ name?, sessionId?, mode:"single"|"list"|"file"|"ai", promptSetId?, providerConfigId, modelId, config, prompts, maxConcurrency, budgetLimit?, blankLines?, lines? }` → `{ batch: Batch, check, estimate }` - batch ở trạng thái `awaiting_approval` (CHƯA chạy). 422 BATCH_INVALID nếu có lỗi (details = BatchCheck). 409 BUDGET_EXCEEDED.
- POST /api/batches/:id/approve `{ confirm:true, approvedMaxCost?:number, acknowledgeUnknownCost?:boolean }` → Batch (status running). Lỗi 409: COST_CONFIRMATION_MISMATCH / COST_UNKNOWN_ACK_REQUIRED / BUDGET_EXCEEDED / BUDGET_UNVERIFIABLE / NOTHING_TO_APPROVE (không còn job chờ duyệt - batch tự chuyển "cancelled"/"completed").
  UI: dialog hiện số video, chi phí ước tính (hoặc "không xác định" + checkbox chấp nhận), ngân sách, số luồng thực tế; nút xác nhận gửi approvedMaxCost = estimate.total.
- GET /api/batches?sessionId= → `{ batches: Batch[] }` ; GET /api/batches/:id
- POST /api/batches/:id/pause | /resume | /cancel-pending (→ `{cancelled}`) | /retry-failed `{confirm:true, approvedMaxCost?, acknowledgeUnknownCost?}` (→ `{retried, estimate, skipped}`; 409 CONFIRMATION_REQUIRED có details.estimate khi chưa confirm)
- GET /api/batches/:id/events → `{ events: Event[] }` (mới nhất trước; cùng định dạng với SSE)
- DELETE /api/batches/:id[?keepAssets=1] → `{ batchId, jobsDeleted, assetsDeleted, freedBytes }` - XÓA HẲN batch + job + lịch sử sự kiện, kèm video đã tạo (thêm `keepAssets=1` để giữ video lại trong Thư viện). Không hoàn tác. 409 BATCH_ACTIVE nếu còn job `submitting`/`processing` (hủy job đó trước).
- GET /api/batches/:id/export?format=zip|csv|json|txt (tải file)

Batch: `{ id, sessionId, name, mode, promptSetId, providerConfigId, providerName, providerType, modelId, config, maxConcurrency, status:"awaiting_approval"|"running"|"paused"|"completed"|"cancelled", budgetLimit, estimate, estimatedCost, actualCost, committedCost, currency, approvedAt, counts:{[status]:number}, total, progress, createdAt, updatedAt }`
BatchCheck: `{ totalLines, blankLines, validPrompts, invalidPrompts, duplicateCount, nearDuplicates, variantsPerPrompt, jobCount, summary ("50 dòng → 50 video"), items:[{index,line,prompt,issues:[{field,code,message}],duplicateOf,valid}], batchIssues:[{field,code,message}], ok }`
BatchEstimate: `{ jobCount, total:number|null, currency, kind:"free-mock"|"user-configured"|"unknown", basis, budgetLimit, withinBudget, effectiveConcurrency, providerConcurrency, notes:string[] }`

## Job
Trạng thái: draft, awaiting_approval, queued, waiting_for_capacity, submitting, processing, completed, failed, cancelled.
- GET /api/jobs?batchId=&sessionId=&status=a,b&q=&limit=&offset= → `{ total, jobs: Job[] }`
- GET /api/jobs/:id ; GET /api/jobs/:id/versions → `{ versions: Job[] }` (V1, V2...) ; GET /api/jobs/:id/events
- POST /api/jobs/:id/cancel → `{ job, cancelled, message }` (409 CANCEL_UNSUPPORTED / CANCEL_REJECTED khi provider không hủy được)
- POST /api/jobs/retry `{ jobIds, confirm:true, approvedMaxCost?, acknowledgeUnknownCost? }`
- POST /api/jobs/approve `{ jobIds, confirm:true, approvedMaxCost?, acknowledgeUnknownCost? }` (duyệt phiên bản mới đang chờ)
- POST /api/jobs/:id/regenerate `{ prompt?, negative?, durationSec?, aspectRatio?, confirm?, approvedMaxCost?, acknowledgeUnknownCost? }` → Job (version mới; mặc định awaiting_approval)

Job: `{ id, batchId, sessionId, seq, title, prompt, negative, referenceAssetIds, providerConfigId, providerName, modelId, config, status, attempt, maxAttempts, remoteJobId, progress:number|null, cancelRequested,
  error:{code,message,detail}|null, nextAttemptAt, outputAssetId, output:{assetId,thumbnail,preview,download,durationSec}|null, estimatedCost, actualCost, lineageId, version, parentJobId, createdAt, updatedAt, submittedAt, completedAt }`

## Thư viện
- GET /api/library?libraryOnly=1&kind=video|image|all → `{ items: (Asset & { kindOf, aspectRatio, batchId, batchName, sessionTitle, version, prompt })[] }` (mặc định `kind=video`)

## Ảnh hàng loạt (batch ảnh, Muse Image)
Batch ảnh dùng LẠI hàng đợi/lập lịch/retry của video (bảng `video_batches`/`video_batch_jobs`, thêm cột `kind`: `video` mặc định | `image`). Mỗi ảnh = một job. Ảnh tạo xong lưu ở kho BVS (`kind:"image"`, `origin:"provider"`, WebP giữ nguyên + thumbnail JPEG ≤480px) và KHÔNG bao giờ vào hàng đăng Facebook Reels.

- Provider: loại `muse2api` (gọi `POST /v1/images/tasks` kèm header `Idempotency-Key = <jobId>#<lần thử>` rồi poll `GET /v1/images/tasks/:id`). Provider khác → 400 `IMAGE_PROVIDER_UNSUPPORTED`. Model cố định `muse-image`.
- ImageBatchConfig: `{ aspectRatio:"1:1"|"4:5"|"9:16"|"16:9"|"3:4" (mặc định 1:1), variantsPerPrompt (1-4), referenceAssetIds (tối đa 1 ảnh), maxAttempts (1-6, mặc định 3) }`. Không có thời lượng/độ phân giải/âm thanh/negative. Giá trị sai trả lỗi tiếng Việt (KHÔNG âm thầm cắt): 400 `INVALID_ASPECT` / `INVALID_VARIANTS` / `TOO_MANY_REFERENCES` / `INVALID_CONCURRENCY` (số luồng ảnh 1-6, mặc định 3).
- POST /api/batches/estimate và POST /api/batches nhận thêm `kind:"image"` (`modelId` bỏ qua), `config` = ImageBatchConfig, `maxConcurrency` 1-6. Không dùng `fbPage`/`shopeeUrl`. Ước tính: `estimate.kind:"unknown"` (muse2api tiêu hạn mức nick, không tính tiền), thêm `imageCount`, `etaMinutes` (~40 giây/ảnh chia cho số luồng thực tế = min(luồng batch, "Số luồng tối đa" của provider)). `check.summary` dạng "3 prompt × 2 ảnh → 6 ảnh". Batch vẫn ở `awaiting_approval`.
- POST /api/batches/:id/approve: batch ảnh vẫn cần `confirm:true` + `acknowledgeUnknownCost:true`; **từ 30 ảnh trở lên** thêm `confirmLarge:true`, nếu thiếu → 409 `LARGE_BATCH_CONFIRM_REQUIRED` (details `{imageCount, threshold:30}`).
- POST /api/prompt-sets/generate `{ kind:"image", count (1-10), aspectRatio, providerConfigId, brief?, ... }` (không cần `durationSec`/`modelId`): AI (model văn bản vinh1 qua 9Router) viết prompt ẢNH, không có thời lượng/chuyển động. POST /api/prompt-sets nhận `kind:"image"` để đánh dấu bộ prompt nhập tay/file. POST /api/prompt-sets/:id/deploy với bộ prompt ảnh (hoặc body `kind:"image"`) tạo batch ảnh; `run.confirmLarge` cho ≥30 ảnh.
- GET /api/batches?kind=video|image|all và GET /api/jobs?kind=... (mặc định batches=`video`, jobs=`all`, nên client cũ không thấy batch ảnh). Batch/Job có thêm `kind`.
- GET /api/library?kind=video|image|all (mặc định `video`, giữ hành vi cũ). Mỗi item có `kindOf:"video"|"image"`, `aspectRatio`, `prompt` (prompt đã dùng), `batchId`, `batchName`. Chỉ ảnh do provider tạo (không lẫn ảnh tải lên làm tham chiếu).
- GET /api/batches/:id/zip → file ZIP mọi file đã xong của batch (tên `anh-<tên batch>-<ts>.zip`); 404 `BATCH_EMPTY` "Batch chưa có ảnh nào hoàn thành." nếu chưa có. Tải lẻ: GET /api/assets/:id/file?download=1. Chọn tay: POST /api/assets/zip. Xoá có xác nhận ở UI: POST /api/assets/delete, DELETE /api/batches/:id.
- Huỷ/chạy lại dùng nguyên route video: POST /api/jobs/:id/cancel (ảnh đã gửi → 409 `CANCEL_UNSUPPORTED`, muse2api không có API huỷ), POST /api/batches/:id/cancel-pending, POST /api/batches/:id/retry-failed `{confirm:true, acknowledgeUnknownCost:true}`. Chỉ regenerate được prompt + `aspectRatio`.
- Idempotency: restart BVS giữa chừng → job `processing` được poll tiếp bằng task id đã lưu; job `submitting` được gửi lại ĐÚNG key cũ (muse2api trả task cũ, không tạo ảnh thứ hai). Task ảnh quá `options.imageMaxWaitSec` (mặc định 900s) → TIMEOUT rồi thử lại tới `maxAttempts`. Lỗi QUOTA/AUTH/CONTENT_POLICY không thử lại.
- Tool MCP/REST: `video_create_image_batch` (alias `video.create_image_batch`) `{ promptSetId | prompts, aspectRatio?, variantsPerPrompt?, referenceAssetId?, maxConcurrency?, name?, providerConfigId? }` - chỉ tạo batch CHỜ DUYỆT. `video_approve_batch` có thêm `confirmLarge`.
- Muse2api giữ task trong bộ nhớ: nếu muse2api khởi động lại khi đang tạo ảnh, poll trả 404 → sau 20 lần job `failed` `TRACKING_LOST`; bấm "Tạo lại".
- Đưa ảnh sang batch video (image-to-video): làm ở web (nút "Dùng làm ảnh tham chiếu" ở Thư viện đặt `referenceAssetIds=[assetId]`, mode `image-to-video`); không có route riêng vì `BatchConfig.referenceAssetIds` đã nhận mọi asset ảnh.

## Sự kiện realtime (SSE)
- GET /api/events (EventSource, cookie) - event types: `job.status`, `job.progress`, `job.created`, `batch.created`, `batch.approved`, `batch.paused`, `batch.resumed`, `batch.status`, `prompts.progress`, `asset.deleted`, `batch.deleted`, ... data (Event): `{ id, type, batchId, jobId, from, to, message, data, at }` - đúng định dạng của GET /api/jobs/:id/events và /api/batches/:id/events.
  Dùng để làm mới dữ liệu (refetch job/batch liên quan, debounce ~300ms). Video job nào xong là xem được ngay.

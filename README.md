# Batch Video Studio

Ứng dụng độc lập để tạo video AI hàng loạt: phân tích video tham khảo → AI sinh N prompt khác nhau → duyệt → chạy batch qua video provider với hàng đợi bền vững → xem, tải, tạo phiên bản mới, xuất ZIP. Điều khiển được bằng giao diện web, chat AI trong ứng dụng, CLI, và MCP (cho Hermes Agent / Claude Code).

Không phụ thuộc D:\AIEV hay dịch vụ ngoài nào ngoài: ffmpeg/ffprobe, một LLM gateway chuẩn OpenAI (cho phân tích/sinh prompt/chat) và API của video provider (Seedance BytePlus).

## Yêu cầu

- Node.js ≥ 24 (dùng `node:sqlite` và chạy TypeScript trực tiếp - không có bước build server)
- ffmpeg + ffprobe trên PATH (hoặc đặt `FFMPEG_PATH`, `FFPROBE_PATH` trong `.env`)

## Chạy

```bash
cd D:/tool
npm install
cp .env.example .env          # tùy chỉnh nếu cần (cổng, thư mục dữ liệu...)

# Production: một cổng cho cả web + API + worker
npm run build
npm start                     # http://127.0.0.1:7878

# Phát triển (HMR): API :7878 + Vite :5173
npm run dev
```

Lần đầu mở trang web → tạo tài khoản quản trị. Mỗi tài khoản có workspace riêng, sẵn một provider **Mock** (miễn phí, ffmpeg dựng video kiểm thử có chữ "MOCK" - không phải video AI).

Worker chạy chung tiến trình (`WORKER_MODE=inline`). Muốn tách: đặt `WORKER_MODE=off` cho server và chạy `npm run worker` ở tiến trình khác (có thể nhiều worker - lease trong SQLite đảm bảo không nhận trùng job).

## Cấu hình lần đầu (trên giao diện)

1. **Cài đặt → LLM gateway**: base URL chuẩn OpenAI (`.../v1`, ví dụ 9Router `http://127.0.0.1:20128/v1`, OpenRouter, LiteLLM), API key, model chữ, model xem hình (vision), model nghe (tùy chọn - bỏ trống thì KHÔNG phân tích âm thanh và kết quả ghi rõ "chưa phân tích âm thanh").
2. **Provider → Thêm provider → Seedance - BytePlus ModelArk**: API key, model, số luồng, yêu cầu/phút, đơn giá (để ước tính chi phí). Xem `docs/providers/seedance-byteplus.md`.
3. **Kiểm tra kết nối** trên thẻ provider (không tạo video, không tốn phí).

Key được mã hóa AES-256-GCM trong DB bằng khóa chủ `APP_MASTER_KEY` hoặc `data/master.key` (tự sinh). **Sao lưu khóa này** - mất khóa = phải nhập lại các key.

## Luồng làm việc

1. **Phân tích video**: tải 1 hoặc nhiều video → Phân tích. Hệ thống đo bằng ffmpeg (mốc chuyển cảnh thật, khoảng lặng, độ to), lấy khung hình phủ TOÀN BỘ thời lượng (dày ở 3 giây đầu cho hook + tại từng mốc chuyển cảnh), gửi theo đoạn cho model vision, gửi âm thanh theo khúc cho model nghe (nếu cấu hình), rồi tổng hợp JSON có cấu trúc. Ô "Độ phủ phân tích" ghi trung thực số khung đã xem, đã phủ toàn video chưa, âm thanh đã phân tích hay chưa.
2. **Batch Studio**: 4 chế độ - Tạo đơn / Danh sách prompt (mỗi dòng một prompt, hiện "50 dòng → 50 video") / Nhập file TXT·CSV·JSON / Tạo prompt bằng AI (từ các bản phân tích, đúng số lượng, chống trùng, theo giới hạn model).
3. **Duyệt prompt**: sửa, xóa, nhân bản, AI viết lại từng prompt, duyệt/loại, xuất TXT/CSV/JSON.
4. **Kiểm tra + ước tính**: chặn trước khi gọi provider - dòng trống, trùng, quá dài, thời lượng/tỷ lệ/độ phân giải model không hỗ trợ, negative prompt khi model không hỗ trợ, ngân sách.
5. **Tạo batch** → luôn ở trạng thái **Chờ duyệt**. **Duyệt & chạy** yêu cầu xác nhận đúng chi phí ước tính (hoặc tích chấp nhận chi phí không xác định).
6. **Theo dõi**: bảng/lưới job cập nhật realtime (SSE), video nào xong xem được ngay. Tạm dừng, tiếp tục, hủy job chưa chạy, hủy từng job (provider chỉ hủy được khi task còn xếp hàng), tạo lại job lỗi, tạo phiên bản mới (V2, V3... giữ nguyên V1), so sánh phiên bản.
7. **Xuất**: ZIP (video + manifest.json + prompts.csv/txt), CSV/JSON metadata, TXT prompt; Thư viện gom theo batch/phiên.

## Hàng đợi bền vững - đảm bảo gì

- Trạng thái job: `draft → awaiting_approval → queued → waiting_for_capacity → submitting → processing → completed | failed | cancelled`, lưu SQLite (WAL). Tắt/bật lại server không mất hàng đợi; job đang chạy ở provider được theo dõi tiếp.
- Số job chạy đồng thời = min(số luồng của batch, số luồng provider), đếm thật trong DB, dùng chung giữa các worker. Có giới hạn yêu cầu/phút.
- Thử lại có backoff + jitter chỉ với lỗi tạm thời (rate limit, 5xx, tạo thất bại); lỗi xác thực / quota / chính sách nội dung / tham số không thử lại; tối đa `maxAttempts` (mặc định 3).
- Không gửi trùng: provider có idempotency → gửi lại đúng key cũ; provider không có (Seedance) → mất kết nối giữa lúc gửi thì dừng ở `SUBMISSION_UNKNOWN`, không tự gửi lại (tránh trả tiền 2 lần).
- Poll trùng / webhook không tạo trùng asset. Video tải về kho bền vững bằng stream (URL của provider hết hạn sau 24 giờ).
- Phân quyền theo workspace: người khác không xem/tải/hủy được job, batch, asset (trả 404).

## Hermes Agent / AI điều khiển

Cùng một bộ tool `video_*` dùng cho: chat AI trong ứng dụng, MCP server, CLI, REST `POST /api/tools/:name`.

```
video_list_assets  video_analyze  video_get_analysis  video_get_provider_capabilities
video_generate_prompts  video_import_prompts  video_estimate_batch  video_create_batch
video_approve_batch  video_get_batch_status  video_pause_batch  video_resume_batch
video_cancel_job  video_retry_job  video_get_result  video_regenerate  video_export_batch
```

Luật chi phí: `video_create_batch` chỉ tạo batch chờ duyệt. Chat trong ứng dụng **không được** duyệt/chạy việc tốn phí (trừ provider Mock) - người dùng bấm "Duyệt & chạy". Agent ngoài dùng API token phải gửi `confirm:true` + `approvedMaxCost` khớp ước tính. Mọi thao tác ghi audit.

Kết nối Hermes qua MCP: xem `docs/HERMES.md`.

Skill cho chat (thư mục `skills/<id>/SKILL.md`): quảng cáo sản phẩm, người nói review, cinematic thương hiệu, motion graphics. Chế độ Tự động (AI chọn skill/provider trong số đã bật) hoặc Thủ công (dùng đúng skill/provider/model người dùng chọn).

## Kiểm thử

```bash
npm run typecheck      # tsc server + web
npm test               # 24 kiểm thử: batch, khôi phục, bảo mật, Seedance (máy chủ giả), AI (LLM giả), MCP, xuất, SSE
npm run build          # build giao diện
```

Kiểm thử KHÔNG gọi dịch vụ thật (fetch ra ngoài localhost bị chặn). Seedance được kiểm với máy chủ giả theo đúng khuôn tài liệu ModelArk; LLM với máy chủ giả chuẩn OpenAI. Kiểm thử Seedance thật (tốn phí, tự chạy khi có key): `docs/providers/seedance-byteplus.md`.

## Cấu trúc

```
server/src/
  main.ts, workerMain.ts      server (web+API+worker inline) / worker riêng
  http.ts                     REST API + SSE + upload + phục vụ web/dist
  db.ts                       SQLite schema + migrate
  batches.ts                  batch/job: kiểm tra, ước tính, duyệt, phiên bản, ngân sách
  scheduler.ts, worker.ts     hàng đợi bền vững: lease, concurrency, rate limit, retry, poll, tải kết quả
  providers/                  types.ts (interface), registry.ts, mock.ts, seedance.ts
  analysis.ts, media.ts       phân tích video (ffmpeg + vision + audio)
  promptgen.ts, prompts.ts    sinh prompt hàng loạt / nhập-xuất-kiểm TXT CSV JSON
  chat.ts, tools.ts, sessions.ts   chat AI + bộ tool dùng chung + skill
  mcp.ts, cli.ts              MCP server (stdio) + CLI
  exporter.ts, storage.ts     ZIP/CSV/JSON, kho asset (preview, thumbnail, Range)
  auth.ts, secrets.ts         tài khoản, phiên, API token, mã hóa secret
web/                          React + Vite
docs/API.md                   hợp đồng API
skills/                       skill cho chat
```

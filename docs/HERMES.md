# Kết nối Hermes Agent với Batch Video Studio (MCP)

Hermes gọi các tool `video_*` qua MCP server stdio `server/src/mcp.ts`. MCP server KHÔNG đụng DB - nó gọi REST API của server đang chạy bằng API token, nên quyền, ngân sách, luật duyệt chi phí và audit giống hệt giao diện.

## 1. Chạy server

```bash
cd D:/tool && npm start        # http://127.0.0.1:7878
```

## 2. Tạo API token

Giao diện: **Cài đặt → API token → Tạo** (token chỉ hiện một lần). Hoặc CLI:

```bash
node server/src/cli.ts token create <username> hermes
```

## 3. Thêm MCP server vào Hermes

```bash
hermes mcp add bvs --command node --env BVS_URL=http://127.0.0.1:7878 BVS_TOKEN=<token> --args D:/tool/server/src/mcp.ts
hermes mcp test bvs
```

Áp dụng cho profile khác: thêm `-p <profile>` (ví dụ `hermes -p aff-video mcp add ...`). Khởi động lại Hermes/gateway để nạp tool. Tool hiện trong Hermes với tên `mcp_bvs_video_create_batch`, `mcp_bvs_video_get_batch_status`...

Biến tùy chọn: `BVS_WORKSPACE` (chọn workspace), `BVS_EXPORT_DIR` (nơi `video_export_batch` lưu file ZIP/CSV - mặc định `D:/tool/data/exports`).

## 4. Ví dụ câu lệnh tự nhiên

- "Tạo 50 prompt quảng cáo serum 30 giây 9:16, cho tôi duyệt trước khi chạy."
- "Ước tính chi phí 20 video Seedance 10 giây 720p."
- "Batch Y chạy tới đâu rồi? Tạo lại các job lỗi."
- "Xuất batch Y ra ZIP."

Agent sẽ: `video_list_assets` → `video_generate_prompts` → `video_estimate_batch` → `video_create_batch` (chờ duyệt) → dừng và báo chi phí. Duyệt chạy bằng giao diện, hoặc agent gọi `video_approve_batch` với `confirm:true` + `approvedMaxCost` đúng bằng ước tính, chỉ khi người dùng đã đồng ý rõ ràng.

## CLI (không cần MCP)

```bash
export BVS_TOKEN=<token>
node server/src/cli.ts tools
node server/src/cli.ts call video_get_provider_capabilities '{}'
node server/src/cli.ts call video_create_batch '{"prompts":["Cảnh 1","Cảnh 2"],"config":{"durationSec":5}}'
node server/src/cli.ts call video_create_batch @prompts.json
```

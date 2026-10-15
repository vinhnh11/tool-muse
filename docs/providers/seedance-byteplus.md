# Seedance (BytePlus ModelArk) - adapter `seedance-byteplus`

Tài liệu đối chiếu (đọc ngày 15/10/2026):
- Tạo task: https://docs.byteplus.com/en/docs/ModelArk/1520757
- Truy vấn / hủy task: các trang "Retrieve a video generation task" và "Cancel or delete a video generation task" trong cùng mục ModelArk → Video Generation API.

Mã nguồn: `server/src/providers/seedance.ts`. Pipeline chính KHÔNG biết tên provider này - chỉ gọi qua interface `VideoProvider` (`server/src/providers/types.ts`) do `ProviderRegistry` cấp.

## Cấu hình trên giao diện (Provider → Thêm provider)

| Trường | Giá trị |
|---|---|
| Loại | Seedance - BytePlus ModelArk |
| Endpoint | `https://ark.ap-southeast.bytepluses.com/api/v3` (mặc định) |
| API key | Key ModelArk (`Authorization: Bearer`). Mã hóa AES-256-GCM trong DB, không bao giờ trả về giao diện/log. |
| Model ids | Mặc định `dreamina-seedance-2-5-260628`, `dreamina-seedance-2-0-260128`. Model id khác vẫn dùng được nhưng bị gắn "chưa xác minh" với giới hạn an toàn (4-12 giây, 480p/720p). |
| Số luồng tối đa | Mặc định 2. Hệ thống chạy tối đa `min(số luồng của batch, số luồng của provider)`. |
| Yêu cầu/phút | Mặc định 30 - bộ đếm theo cửa sổ 60 giây trong DB, dùng chung giữa nhiều worker. |
| Đơn giá | Tùy chọn: `pricePerSecond` theo độ phân giải và/hoặc `pricePerMillionTokens`. Không nhập → chi phí "không xác định" và người dùng phải tích "Tôi chấp nhận chi phí không xác định" khi duyệt. Hệ thống KHÔNG tự bịa giá. |
| Webhook | Tùy chọn, cần `PUBLIC_BASE_URL`. ModelArk không ký callback nên webhook chỉ "đánh thức" việc poll ngay - kết quả luôn được xác minh lại bằng GET task. |

## Ánh xạ API

| Bước của interface | Gọi ModelArk |
|---|---|
| `submitGeneration` | `POST {endpoint}/contents/generations/tasks` body `{ model, content:[{type:"text",text}, {type:"image_url", image_url:{url}, role:"first_frame"\|"reference_image"}...], ratio, duration (-1 = model tự chọn), resolution, generate_audio, watermark, callback_url? }` → `{ id }` |
| `getGenerationStatus` | `GET {endpoint}/contents/generations/tasks/{id}` → `status: queued\|running\|succeeded\|failed\|cancelled\|expired`, `content.video_url`, `usage.completion_tokens`, `error{code,message}` |
| `cancelGeneration` | `DELETE {endpoint}/contents/generations/tasks/{id}` - **chỉ hủy được task còn `queued`**. Task đang `running` → báo `CANCEL_REJECTED`, không giả vờ đã hủy. |
| `retrieveResult` | Tải `content.video_url` (URL ký, hết hạn 24 giờ) **bằng stream** về kho lưu trữ bền vững, tính sha256, tạo bản xem trước + thumbnail. Không lưu URL tạm, không gửi API key tới URL tải. |
| `estimateCost` | Từ đơn giá người dùng nhập (giây × giá theo độ phân giải). Chi phí thực tế = `completion_tokens × pricePerMillionTokens / 1e6` khi có. |

## Giới hạn model (lấy từ tài liệu - dùng để chặn TRƯỚC khi gọi API)

| Model | Thời lượng | Độ phân giải | Âm thanh | Ảnh tham chiếu |
|---|---|---|---|---|
| dreamina-seedance-2-5-260628 | 4-30 giây hoặc model tự chọn | 480p, 720p, 1080p | có | tối đa 30 |
| dreamina-seedance-2-0-260128 | 4-15 giây hoặc model tự chọn | 480p, 720p, 1080p, 4k | có | tối đa 9 |

Không hỗ trợ negative prompt → giao diện ẩn ô negative và trình kiểm tra báo `NEGATIVE_UNSUPPORTED`.

## Phân loại lỗi → hành vi hàng đợi

| Tình huống | Loại lỗi | Thử lại tự động? |
|---|---|---|
| 401/403 | AUTH | Không |
| 429 RateLimit/RPM/TPM | RATE_LIMIT | Có, backoff lũy thừa + jitter |
| 429/402 quota, số dư, quá hạn thanh toán | QUOTA | Không |
| 400 `*Sensitive*`, `*Policy*` | CONTENT_POLICY | Không |
| 400 tham số khác | INVALID_INPUT | Không |
| 5xx, mạng không tới được | PROVIDER_UNAVAILABLE | Có |
| Task `failed`/`expired` | GENERATION_FAILED | Có (tối đa `maxAttempts`, mặc định 3) |
| Tải video lỗi | DOWNLOAD_FAILED | Có - chỉ tải lại (tối đa 5 lần, backoff), KHÔNG tạo lại video |
| **Mất kết nối giữa lúc POST** | SUBMISSION_UNKNOWN | **Không** - xem dưới |

### Vì sao không tự gửi lại khi mất kết nối lúc tạo task

API tạo task của ModelArk **không có idempotency key**. Nếu kết nối đứt sau khi gửi body, không thể biết BytePlus đã tạo task (và tính tiền) hay chưa. Gửi lại có thể tạo 2 video và trả tiền 2 lần. Vì vậy job chuyển `failed / SUBMISSION_UNKNOWN` kèm hướng dẫn: kiểm tra trên console ModelArk, nếu chắc chắn chưa tạo thì bấm "Tạo lại" (cần xác nhận chi phí). Provider có idempotency (ví dụ Mock) thì hệ thống gửi lại đúng key cũ một cách an toàn.

## Đã kiểm thử thế nào

`server/test/security-seedance.test.ts` dựng một **máy chủ giả** theo đúng khuôn tài liệu (POST/GET/DELETE, 429, lỗi nội dung, URL ký) và kiểm:
khuôn request, chặn 30 giây cho model 2.0, ước tính và chi phí thực tế, xác nhận chi phí khi duyệt, thử lại 429, không thử lại lỗi nội dung, hủy task queued, video chép về kho bền, API key không xuất hiện trong phản hồi API / DB / audit / log / lỗi.

**Chưa kiểm với BytePlus thật** (chưa có API key). Khi có key, chạy kiểm thử thật (TỐN PHÍ - 1 video 4 giây 480p):

```bash
SEEDANCE_API_KEY=... BVS_E2E_ALLOW_COST=1 node --test server/test/e2e/seedance-live.test.ts
```

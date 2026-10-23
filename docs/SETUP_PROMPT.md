# Prompt cài đặt cho AI agent

Cách dùng: clone repo này, mở một AI agent có quyền chạy lệnh trên máy (Claude Code, Codex, Hermes...) trong thư mục repo,
rồi dán nguyên phần trong khung dưới đây. Agent tự cài và chạy; chỉ hỏi bạn những thứ chỉ bạn có (đăng nhập Muse, khoá LLM...).

---

```
Bạn là kỹ sư triển khai. Nhiệm vụ: dựng Batch Video Studio (BVS) trong thư mục repo này cùng muse2api để chạy được y như bản gốc:
tạo video và ảnh hàng loạt bằng Muse, AI viết prompt, và (tuỳ chọn) tự đăng Reels lên Facebook Page. Làm cho tới khi chạy thật và tự kiểm
bằng lệnh, đừng chỉ mô tả. Chỗ nào thiếu thì tự cài/tự sửa. Chỉ hỏi người dùng những thứ bạn không thể tự có (liệt kê ở bước 7).

QUY TẮC AN TOÀN (bắt buộc)
- Không in, không ghi vào chat, không commit bất kỳ khoá/token/cookie nào. Khoá nhập qua giao diện BVS hoặc file .env (đã nằm trong .gitignore).
- Không đăng gì lên Facebook, không tạo video/ảnh thật tốn hạn mức khi chưa được người dùng cho phép. Kiểm tra kết nối chỉ gọi
  "Test"/GET, không tạo nội dung. Nếu cần thử thật thì tối đa 1 ảnh và nói rõ với người dùng.
- Trước khi xoá hoặc ghi đè dữ liệu có sẵn (data/, storage/, .env, file .db), hỏi người dùng. Không dùng lệnh phá huỷ git.
- Không đưa thư mục data/ của muse2api (chứa cookie tài khoản) hay file .env lên git.

BƯỚC 1 - KIỂM TRA MÁY (tự cài nếu thiếu, hỏi trước khi cài thứ lớn)
- Node.js >= 24 (dùng node:sqlite và chạy TypeScript trực tiếp). Kiểm: node -v
- ffmpeg + ffprobe có trong PATH (hoặc đặt FFMPEG_PATH/FFPROBE_PATH trong .env). Kiểm: ffmpeg -version
- Python 3.10+ (cho muse2api). Kiểm: python --version
- Google Chrome hoặc Chromium (muse2api điều khiển trình duyệt thật). Ghi lại đường dẫn tới file chạy được.
- git.

BƯỚC 2 - CÀI VÀ BUILD BVS (thư mục repo này)
1. npm ci
2. Chép .env.example thành .env. Giữ HOST=127.0.0.1, PORT=7878. Đặt DATA_DIR và STORAGE_DIR là thư mục bền vững (vd ./data, ./storage).
   Để trống APP_MASTER_KEY: lần chạy đầu tự sinh data/master.key. DẶN người dùng sao lưu file này: mất nó là mất các khoá đã lưu.
3. npm run typecheck && npm run build. Chạy npm test. Biết trước: có đúng 1 test đỏ cũ
   ("Batch Prompt Generator: đúng 12 prompt...") không liên quan; các test khác phải đạt, đừng sửa test đó.
4. Chạy: npm start (một cổng 7878 cho web + API + worker). Trên Windows chạy nền bằng PowerShell Start-Process -WindowStyle Hidden,
   ghi log ra file, rồi kiểm GET http://127.0.0.1:7878/api/health trả {"ok":true}.
   Viết giúp người dùng một script khởi động idempotent (kiểm cổng đã nghe thì thôi) vào thư mục scripts/ cho đúng hệ điều hành.
5. Tài khoản quản trị: GET /api/auth/setup-status. Nếu needsSetup=true thì để người dùng tự mở http://127.0.0.1:7878 tạo tài khoản
   (hoặc hỏi họ tên đăng nhập và mật khẩu rồi dùng: node server/src/cli.ts user create <tên> <mật khẩu>).

BƯỚC 3 - CÀI muse2api (repo RIÊNG, nằm ngoài repo này)
muse2api bọc web muse.ai thành API chuẩn OpenAI. Nó là dự án của bên thứ ba: https://github.com/czg86389-hub/muse2api
1. Clone vào thư mục NGANG HÀNG với repo này (không nằm trong repo), vd ../muse2api.
2. Tạo venv: python -m venv venv, rồi cài: venv/bin/pip install -r requirements.txt (Windows: venv\Scripts\pip).
3. Chép .env.example thành .env và đặt:
   MUSE2API_HOST=127.0.0.1
   MUSE2API_PORT=18610
   MUSE2API_PUBLIC_BASE=http://127.0.0.1:18610
   MUSE2API_CHROMIUM=<đường dẫn Chrome/Chromium ở bước 1>
   MUSE2API_CDP_PORT=19210
   MUSE2API_IMAGE_TIMEOUT=240
   MUSE2API_VIDEO_TIMEOUT=600
   MUSE2API_CHAT_TIMEOUT=300
   MUSE2API_KEY=  (để trống: lần đầu chạy nó tự sinh khoá mạnh m2a_... và ghi ra log; đọc khoá từ log, đừng in ra chat)
   Số luồng: bản chạy gốc dùng MUSE2API_CONCURRENCY=9 (quy tắc vận hành: mỗi nick Muse làm 3 việc song song, đổi nick sau 10 video).
   Đọc README/app.py của muse2api xem biến này có được hỗ trợ không; nếu không, báo người dùng và dùng mặc định của nó.
4. Chạy nền: venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 18610 (ghi log ra server.log/server.err.log).
   Kiểm GET http://127.0.0.1:18610/healthz trả status ok. Viết script khởi động idempotent tương tự như BVS.
5. Quản trị muse2api dùng header Authorization: Bearer <MUSE2API_KEY> (không phải ?key= cho API /admin/*).
6. Nạp tài khoản Muse: tài khoản của người dùng không đi theo repo. Hướng dẫn họ dùng extension Chrome trong thư mục extension/ của muse2api
   (chrome://extensions -> Developer mode -> Load unpacked), điền địa chỉ http://127.0.0.1:18610 và khoá, đăng nhập muse.ai rồi bấm nạp.
   Cần 1 nick trở lên. Kiểm GET /admin/accounts: nick có ok=true, enabled=true. Lưu ý mỗi nick Free có hạn mức tuần; hết thì job
   báo QUOTA và không tự thử lại.

BƯỚC 4 - NỐI BVS VỚI muse2api (qua API của BVS, đăng nhập bằng tài khoản ở bước 2.5; header X-BVS-Request: 1 cho request ghi)
1. Xem GET /api/providers/types và GET /api/providers. Nếu chưa có provider loại "muse2api", tạo:
   POST /api/providers {"providerType":"muse2api","name":"Muse (muse2api local)","endpoint":"http://127.0.0.1:18610",
   "modelIds":["muse-video"],"maxConcurrency":9,"requestsPerMinute":30,"apiKey":"<MUSE2API_KEY>","enabled":true}
   (khoá lấy từ file .env của muse2api, KHÔNG in ra). Mock đã bị xoá khỏi bản gốc; nếu repo còn nhắc Mock thì bỏ qua, không dùng.
2. POST /api/providers/{id}/test phải trả ok:true; nếu báo pool chưa có tài khoản Muse thì quay lại bước 3.6.
3. Model ảnh dùng chung provider này (muse-image qua /v1/images/tasks). Kiểm GET /v1/models của muse2api có "muse-image".

BƯỚC 5 - LLM GATEWAY (AI viết prompt, caption, dựng tự động)
BVS cần 1 gateway chuẩn OpenAI (/v1/chat/completions). Hỏi người dùng đang dùng cái nào (9Router http://127.0.0.1:20128/v1, OpenRouter,
LiteLLM...), model chữ nào, và khoá (người dùng tự dán vào giao diện hoặc bạn nhận qua biến môi trường, không ghi vào chat/log).
PUT /api/settings/llm {"baseUrl":"...","textModel":"...","apiKey":"..."}. Kiểm bằng cách bấm "Tạo prompt bằng AI" 1 lần với 1 prompt.
Bản gốc dùng model "vinh1" qua 9Router; người khác dùng model của họ. Quy tắc: AI tự sinh prompt tối đa 10; prompt tự nhập/nhập file không giới hạn.

BƯỚC 6 - FACEBOOK (TUỲ CHỌN, chỉ khi người dùng muốn tự đăng Reels)
Chỉ đăng lên Page mà người dùng là admin, dạng Reels, mặc định mỗi Page cách nhau 60 phút, mặc định CẦN DUYỆT trước khi đăng.
Người dùng cần: 1 app Meta, Page access token dài hạn (loại PAGE, không hết hạn) có quyền pages_manage_posts, pages_read_engagement,
pages_show_list và pages_manage_engagement (để bình luận link Shopee). Xem docs/facebook-reels.md để biết cách lấy token từng bước.
Hướng dẫn họ dán token vào tab "Đăng Facebook" của BVS (đừng bắt họ gửi token cho bạn), bấm "Kiểm tra kết nối" (chỉ GET tên Page).
Mỗi batch phải chọn Page đích (hoặc "Không đăng"); thiếu lựa chọn thì coi là không đăng. Video phải 9:16, 3-90 giây, tối thiểu 540x960.

BƯỚC 7 - KIỂM TRA CUỐI VÀ BÀN GIAO
Chạy và báo lại số liệu thật: npm run typecheck, npm run build, npm test; /api/health của BVS; /healthz của muse2api; provider test ok;
số nick Muse hợp lệ; LLM gateway trả lời được. Chưa tạo video/ảnh thật thì nói rõ là chưa thử.
Tuỳ chọn, hỏi người dùng trước: tạo 1 batch rất nhỏ (1 ảnh) để chứng minh chạy end-to-end.
Những thứ chỉ người dùng có và bạn phải hỏi: (a) tài khoản Muse (đăng nhập qua extension), (b) khoá LLM gateway, (c) token Facebook Page nếu dùng,
(d) tên đăng nhập/mật khẩu BVS. Mọi thứ khác bạn tự làm.
Cuối cùng in ngắn gọn: địa chỉ BVS (http://127.0.0.1:7878), cách khởi động/tắt lại cả hai dịch vụ, nơi lưu dữ liệu cần sao lưu
(DATA_DIR, STORAGE_DIR, data/master.key của BVS; data/ của muse2api), và hướng dẫn dùng nhanh: docs/image-batch.md (ảnh),
README.md (video), docs/facebook-reels.md (Facebook).
```

---

## Ghi chú cho người duy trì repo

- Prompt này giả định muse2api là repo bên thứ ba; bản đang chạy của chủ repo có sửa thêm (hạn mức, số luồng) chưa đưa lên đâu cả.
- Cập nhật prompt này mỗi khi đổi cách cài đặt (biến môi trường, đường dẫn, quyền Facebook...).

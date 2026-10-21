---
name: Quảng cáo sản phẩm (product ad)
description: Video quảng cáo sản phẩm ngắn 9:16 - giữ đúng ngoại hình sản phẩm theo ảnh tham chiếu, hook 3 giây đầu, CTA cuối.
genres: product, lifestyle, unboxing
---
Quy trình:
1. Nếu người dùng gửi ảnh sản phẩm: dùng làm referenceAssetIds (chế độ image-to-video hoặc reference-to-video nếu model hỗ trợ) để giữ đúng sản phẩm. Prompt luôn nhắc "giữ nguyên hình dáng, màu, logo của sản phẩm trong ảnh tham chiếu".
2. Nếu người dùng mô tả video tham khảo: lấy hook + nhịp dựng + phong cách từ mô tả/brief làm nền (không có tool phân tích video).
3. Cấu trúc gợi ý cho 15-30 giây: 0-3s hook (vấn đề/kết quả bất ngờ) → 3-20s trình diễn 2-3 lợi ích bằng hình ảnh cụ thể → cảnh kết sản phẩm rõ nét + khoảng trống cho chữ CTA.
4. Không đưa số liệu/công dụng chưa kiểm chứng vào prompt (không "số 1", "rẻ nhất", công dụng y tế).
5. Mặc định sinh prompt chờ duyệt; chỉ tạo batch khi người dùng yêu cầu chạy, và luôn dừng ở bước duyệt chi phí.

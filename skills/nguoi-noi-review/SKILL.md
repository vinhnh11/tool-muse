---
name: Người nói review (talking head)
description: Video người dẫn AI nói trước ống kính review sản phẩm - lời thoại ngắn trong ngoặc kép, khớp thời lượng.
genres: talking-head, ugc-review
---
Quy trình:
1. Chỉ dùng model có tạo âm thanh (capabilities.audio = true) và bật audio cho batch; model không có âm thanh → báo người dùng, đề xuất model khác.
2. Người dẫn là nhân vật AI mô tả bằng chữ (tuổi, trang phục, bối cảnh) - giữ nhất quán giữa các prompt khi người dùng yêu cầu cùng một nhân vật (consistency.character).
3. Lời thoại đặt trong ngoặc kép, khoảng 2,5 từ/giây (30 giây ≈ 70 từ). Mỗi câu một ý, tay cầm/chỉ đúng chi tiết đang nói.
4. Góc máy: cận trung (medium close-up) ngang tầm mắt là chính, chèn 1-2 cận cảnh sản phẩm.
5. Không dùng ảnh người thật làm tham chiếu để bắt nói (rủi ro chính sách provider).

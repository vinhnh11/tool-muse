# Tạo ảnh hàng loạt

Tạo nhiều ảnh bằng Muse Image (qua muse2api) theo đúng quy trình batch video: nhập prompt → duyệt → chạy → xem trong Thư viện → tải về.

## Tạo batch ảnh từng bước

1. Mở **Batch Studio**, ở đầu "Khu vực tạo" bấm **Ảnh** (công tắc Video | Ảnh). Bên phải hiện **Cấu hình ảnh**.
2. Nhập prompt bằng một trong 4 cách:
   - **Tạo đơn**: một prompt.
   - **Danh sách prompt**: mỗi dòng một prompt (không giới hạn số dòng).
   - **Nhập từ file**: `.txt` / `.csv` / `.json` (không giới hạn).
   - **Tạo prompt bằng AI**: AI viết prompt ảnh (tối đa 10 prompt mỗi lần; không có thời lượng/chuyển động).
   Muốn xem/sửa/duyệt từng prompt trước khi chạy: bấm **Tạo bộ prompt để duyệt** (danh sách/file) hoặc dùng bộ prompt AI vừa sinh, duyệt rồi bấm **Triển khai N ảnh**.
3. Chọn cấu hình ảnh (xem bên dưới), tuỳ chọn tải 1 ảnh sản phẩm làm tham chiếu.
4. Bấm **Kiểm tra prompt** / **Ước tính số ảnh**, rồi **Tạo batch ảnh**. Batch ở trạng thái **Chờ duyệt**, chưa gọi Muse.
5. Bấm **Duyệt & chạy** (tick "Tôi hiểu mỗi ảnh tiêu hạn mức tuần của nick Muse"). Từ **30 ảnh trở lên** có thêm hộp xác nhận "Sẽ tạo N ảnh (~X phút)".
6. Theo dõi trong "Batch & ảnh": ảnh nào xong xem được ngay. Huỷ ảnh chưa chạy, "Tạo lại job lỗi", **Tải ZIP ảnh** cả batch.
7. Ảnh tự vào tab **Thư viện** (lọc Video | Ảnh | Tất cả): bấm ảnh để xem lớn + prompt đã dùng, tải từng ảnh, xoá (có xác nhận), chọn nhiều → Tải ZIP. Nút **Dùng làm ảnh tham chiếu** mở Batch Studio (Video) với ảnh đó làm khung đầu (ảnh → video).

## Ý nghĩa các ô

| Ô | Ý nghĩa |
|---|---|
| Tỉ lệ khung hình | 1:1, 4:5, 9:16, 16:9, 3:4. 4:5 muse2api chưa có nhánh riêng nên có thể lệch tỉ lệ hơn. |
| Số ảnh / prompt | 1-4 biến thể cho mỗi prompt. Tổng ảnh = số prompt × số ảnh/prompt (hiện ở dòng Ước tính). |
| Ảnh tham chiếu | Tối đa 1 ảnh sản phẩm gửi kèm mọi prompt của batch. |
| Số ảnh chạy song song | 1-6, mặc định 3. Thực tế = nhỏ nhất của ô này và "Số luồng tối đa" của provider Muse. |

Không có thời lượng, độ phân giải, âm thanh hay negative prompt cho ảnh.

## Ước lượng thời gian

Khoảng **40 giây/ảnh**; chạy **3 ảnh song song** thì ~4,5 phút cho 20 ảnh, ~13 phút cho 60 ảnh. Muốn đạt 3 luồng, vào trang **Provider** → provider Muse → tăng **Số luồng tối đa** lên ≥ 3 (mặc định 2). Chạy quá nhiều luồng dễ bị muse2api từ chối (hàng đợi ảnh tối đa 8) - BVS tự chờ rồi gửi lại.

## Lưu ý quan trọng

- **Nick Muse có hạn mức tuần**: mỗi ảnh tiêu hạn mức, không tính tiền theo ảnh. Hết hạn mức → job lỗi `QUOTA`, không tự thử lại. Theo dõi ở trang quản trị muse2api.
- Ảnh đã gửi cho Muse **không huỷ được** (muse2api không có API huỷ); chỉ huỷ được ảnh chưa gửi.
- Khởi động lại BVS giữa chừng không tạo trùng ảnh: ảnh đang tạo được theo dõi tiếp, ảnh gửi dở được gửi lại với cùng mã nên Muse không tạo ảnh thứ hai.
- Nếu muse2api khởi động lại khi đang tạo ảnh, Muse mất danh sách task: ảnh đó báo lỗi mất theo dõi → bấm **Tạo lại**.
- Ảnh được tải về lưu trong kho BVS (WebP giữ nguyên), không phụ thuộc link tạm của muse2api. Ảnh **không** được đăng Facebook.
- Lỗi tạm thời (hết giờ, hàng đợi đầy) được thử lại tối đa 3 lần; lỗi nội dung bị từ chối chỉ báo lỗi, sửa prompt rồi tạo lại.

Chi tiết API: `docs/API.md` (mục "Ảnh hàng loạt"); điều khiển bằng Hermes: `docs/HERMES.md`.

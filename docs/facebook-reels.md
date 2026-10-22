# Đăng Facebook Reels tự động

Tab "Đăng Facebook" quản lý các Page, hàng đợi duyệt/đăng và cài đặt chung. Mỗi batch chọn MỘT Page đích ("Đăng lên Page"); video xong của batch vào hàng đợi của đúng Page đó.

## Gắn link Shopee

Dùng khi muốn mỗi Reels tự có link sản phẩm: "đăng bài nào gắn link bài đấy".

Cách dùng
- Khi tạo batch, chọn một Page thật, ô "Link Shopee sản phẩm (tuỳ chọn)" sẽ hiện ngay dưới ô Page. Dán link sản phẩm (kể cả link affiliate rút gọn `s.shopee.vn`, `shope.ee`).
- MỘT link cho CẢ batch. Ô này không hiện / không được gửi khi chọn "Không đăng lên Facebook" (server từ chối nếu cố gửi).
- Để trống = hành vi y hệt trước đây (không thêm dòng link, không bình luận).

Quy tắc link (kiểm ở cả giao diện lẫn server)
- Chỉ `https://`. Từ chối `javascript:`, `http://`, link có khoảng trắng, dài quá 500 ký tự, có `user:pass@`.
- Host chỉ gồm: `shopee.vn` (và mọi subdomain `*.shopee.vn`), `shopee.com`, `s.shopee.vn`, `shope.ee`, `vn.shp.ee`, `shp.ee`. `www.shopee.com` và subdomain khác của shopee.com KHÔNG được nhận. Các host giả như `shopee.vn.evil.com`, `evilshopee.vn` bị từ chối.
- Hệ thống KHÔNG gọi mạng tới Shopee và KHÔNG theo redirect: không kiểm tra link còn sống hay trỏ tới đâu.

Link được dùng ở hai chỗ
1. Cuối caption, SAU hashtag, thành một dòng riêng:

        <nội dung caption>

        #tag1 #tag2

        🛒 Mua tại đây: <link>

   Caption tối đa 2200 ký tự. Nếu quá dài thì phần nội dung/hashtag bị cắt, dòng link luôn nguyên vẹn. Link được ghép bằng code SAU khi AI viết caption, AI không nhận link và các URL do AI tự sinh bị loại khi bài có link.
2. Bình luận tự động dưới Reels ngay sau khi đăng thành công: `🛒 Link sản phẩm: <link>`.

Vì sao cần bình luận: link trong mô tả (caption) của Reels có thể không bấm được (hiển thị như chữ thường), nên link cũng được bình luận. Link bình luận thường bấm được.

Mỗi bài mang link của batch lúc video vào hàng đợi (sao chép sang bài). Sửa batch sau đó không đổi link của bài đã vào hàng. Với bài "Chờ duyệt" có nút "Sửa link" để đổi/bỏ link của riêng bài đó (kiểm như trên); bài đã duyệt/đã đăng không sửa được.

## Quyền cần thêm: pages_manage_engagement

Đăng Reels chỉ cần `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Bình luận cần THÊM `pages_manage_engagement` (và người cấp token cần có quyền quản lý Page tương ứng). Token Page cũ thường THIẾU quyền này: bài vẫn đăng bình thường, nhưng bình luận báo "Lỗi bình luận ... thiếu quyền pages_manage_engagement".

Cấp lại token khi thiếu quyền
1. Vào Graph API Explorer (hoặc đăng nhập Facebook Login của app của bạn), chọn app, chọn thêm quyền `pages_manage_engagement` cùng các quyền đăng sẵn có. Token đã cấp không tự có quyền mới, phải tạo token mới.
2. Lấy User token dài hạn, rồi gọi `GET /me/accounts` để lấy Page token (Page token đổi từ user token dài hạn không hết hạn).
3. Dán token mới ở tab Đăng Facebook > Page > Sửa, bấm "Kiểm tra".
4. Quay lại hàng đợi, bấm "Thử bình luận lại" ở các bài bị lỗi bình luận.
Lưu ý: app ở chế độ Development chỉ dùng được với tài khoản có vai trò trong app (Admin/Developer/Tester); app Live cần App Review cho quyền này.

## Hành vi bình luận

- Endpoint: `POST https://graph.facebook.com/v26.0/{video-id}/comments` với `message` (video-id là id nhận được khi bắt đầu upload Reels). Chưa kiểm chứng bằng Page thật (không đăng thật khi phát triển); nếu thực tế khác, chỉ cần sửa một dòng ở `commentOnVideo` trong `server/src/fbreels/graph.ts`.
- Bình luận là bước TÁCH RIÊNG sau khi bài `published`, có trạng thái riêng `comment_status`: `none` (không link) / `pending` (chờ bình luận) / `done` (đã bình luận, lưu `fb_comment_id`) / `failed` (kèm lý do).
- Lỗi bình luận KHÔNG BAO GIỜ làm bài bị đăng lại, đổi trạng thái đã đăng hay tạm dừng Page.
- Lỗi tạm thời (giới hạn tần suất, Facebook lỗi 5xx): thử lại tối đa 3 lần, cách nhau 3 phút rồi 10 phút. Lỗi quyền/token: báo ngay, không thử lại. Lỗi mạng/timeout (không biết bình luận đã lên chưa): báo ngay và KHÔNG tự thử lại để khỏi trùng.
- Nút "Thử bình luận lại" (bài đã đăng + bình luận lỗi) xếp lại bình luận, chạy ở lượt kiểm tra kế (tối đa ~30 giây). Một bài chỉ có tối đa MỘT bình luận thành công; đã có `fb_comment_id` thì không bình luận lại.
- Rủi ro còn lại: nếu bị timeout mà bình luận thật đã lên rồi bạn bấm "Thử bình luận lại" thì có thể trùng; kiểm tra Page trước. Máy sập đúng lúc Facebook vừa trả lời cũng có thể gây bình luận lần hai. Không nên dùng cùng một link bình luận quá dày trên nhiều Reels vì Facebook có thể coi là spam (mã 368).

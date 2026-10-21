import { useState, type ReactNode } from "react";
import { api, asApiError, saveBlob, type Batch, type Job } from "../../api";
import { useDialogs } from "../../components/ConfirmDialog";
import { CostConfirmDialog, type CostAck } from "../../components/CostConfirmDialog";
import { toastApiError, useToast } from "../../components/Toast";
import { emitLocal } from "../../hooks/useEvents";

interface CostRequest {
  title: string;
  description?: ReactNode;
  count: number;
  estimate: number | null;
  currency: string;
  confirmLabel: string;
  run: (ack: CostAck) => Promise<void>;
}

function confirmationDetails(e: unknown): { count?: number; estimate?: number | null } | null {
  const err = asApiError(e);
  if (err.code !== "CONFIRMATION_REQUIRED") return null;
  return (err.details as { count?: number; estimate?: number | null } | null) ?? {};
}

/**
 * Các thao tác job/batch có thể tốn phí - luôn qua hộp xác nhận chi phí.
 * Trả về `dialog` để render một lần trong component dùng hook.
 */
export function useJobActions(currency = "USD") {
  const toast = useToast();
  const dialogs = useDialogs();
  const [req, setReq] = useState<CostRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = (batchId?: string | null) => emitLocal({ type: "local.batch", batchId: batchId ?? null });

  const cancelJob = async (job: Job) => {
    setBusy(`cancel:${job.id}`);
    try {
      const r = await api.cancelJob(job.id);
      if (r.cancelled) toast.success(`Job #${job.seq}: ${r.message}`);
      else toast.info(`Job #${job.seq}`, r.message);
      refresh(job.batchId);
    } catch (e) {
      toastApiError(toast, `Không hủy được job #${job.seq}`, e);
    } finally {
      setBusy(null);
    }
  };

  const cancelJobs = async (jobs: Job[]) => {
    if (!jobs.length) return;
    if (!(await dialogs.confirm({ title: `Hủy ${jobs.length} job đã chọn?`, body: "Job chưa gửi provider sẽ hủy ngay (không tốn phí). Job đang chạy chỉ hủy được nếu provider hỗ trợ.", confirmLabel: "Hủy job", danger: true }))) return;
    setBusy("cancel:bulk");
    let ok = 0;
    const fails: string[] = [];
    for (const j of jobs) {
      try {
        const r = await api.cancelJob(j.id);
        if (r.cancelled) ok++;
        else fails.push(`#${j.seq}: ${r.message}`);
      } catch (e) {
        fails.push(`#${j.seq}: ${asApiError(e).message}`);
      }
    }
    setBusy(null);
    if (ok) toast.success(`Đã hủy ${ok} job`);
    if (fails.length) toast.error(`${fails.length} job không hủy được`, fails.slice(0, 4).join(" · "));
    refresh(jobs[0]?.batchId);
  };

  /** Tạo lại job lỗi/đã hủy: lần gọi đầu không confirm → server trả ước tính → hỏi người dùng */
  const retryJobs = async (jobs: Job[]) => {
    const ids = jobs.filter((j) => j.status === "failed" || j.status === "cancelled").map((j) => j.id);
    if (!ids.length) return toast.info("Chỉ tạo lại được job Lỗi hoặc Đã hủy.");
    setBusy("retry");
    try {
      const r = await api.retryJobs({ jobIds: ids });
      toast.info(r.retried.length ? `Đã xếp hàng tạo lại ${r.retried.length} job` : "Không có job nào cần tạo lại.");
      refresh(jobs[0]?.batchId);
    } catch (e) {
      const d = confirmationDetails(e);
      if (!d) toastApiError(toast, "Không tạo lại được", e);
      else
        setReq({
          title: `Tạo lại ${d.count ?? ids.length} job`,
          description: "Mỗi job được gửi lại provider như một lần thử mới (giữ nguyên phiên bản).",
          count: d.count ?? ids.length,
          estimate: d.estimate ?? null,
          currency,
          confirmLabel: "Tạo lại",
          run: async (ack) => {
            const r = await api.retryJobs({ jobIds: ids, confirm: true, ...ack });
            toast.success(`Đã xếp hàng tạo lại ${r.retried.length} job`, r.skipped.length ? `Bỏ qua ${r.skipped.length} job` : undefined);
            refresh(jobs[0]?.batchId);
          },
        });
    } finally {
      setBusy(null);
    }
  };

  const retryFailed = async (batch: Batch) => {
    setBusy("retry");
    try {
      const r = await api.retryFailed(batch.id, {});
      toast.info(r.retried.length ? `Đã xếp hàng tạo lại ${r.retried.length} job` : "Batch không có job lỗi nào.");
      refresh(batch.id);
    } catch (e) {
      const d = confirmationDetails(e);
      if (!d) toastApiError(toast, "Không tạo lại được", e);
      else
        setReq({
          title: "Tạo lại các job lỗi",
          description: `Batch "${batch.name}" - các job lỗi được gửi lại provider.`,
          count: d.count ?? batch.counts.failed ?? 0,
          estimate: d.estimate ?? null,
          currency: batch.currency || currency,
          confirmLabel: "Tạo lại job lỗi",
          run: async (ack) => {
            const r = await api.retryFailed(batch.id, { confirm: true, ...ack });
            toast.success(`Đã xếp hàng tạo lại ${r.retried.length} job`);
            refresh(batch.id);
          },
        });
    } finally {
      setBusy(null);
    }
  };

  /** Duyệt phiên bản mới (job awaiting_approval) - ước tính = tổng estimatedCost của các job */
  const approveJobs = (jobs: Job[], cur = currency) => {
    const list = jobs.filter((j) => j.status === "awaiting_approval");
    if (!list.length) return;
    const total = list.reduce<number | null>((s, j) => (s === null || j.estimatedCost === null ? null : s + j.estimatedCost), 0);
    setReq({
      title: list.length === 1 ? `Duyệt & chạy job #${list[0]!.seq} (V${list[0]!.version})` : `Duyệt & chạy ${list.length} job`,
      description: "Job sẽ vào hàng đợi và gửi tới provider.",
      count: list.length,
      estimate: total === null ? null : Math.round(total * 10000) / 10000,
      currency: cur,
      confirmLabel: "Duyệt & chạy",
      run: async (ack) => {
        const r = await api.approveJobs({ jobIds: list.map((j) => j.id), confirm: true, ...ack });
        toast.success(`Đã duyệt ${r.approved} job`);
        refresh(list[0]?.batchId);
      },
    });
  };

  const downloadZip = async (assetIds: string[], name = "videos") => {
    if (!assetIds.length) return toast.info("Chưa chọn video nào đã hoàn thành.");
    setBusy("zip");
    try {
      const blob = await api.zip(assetIds);
      saveBlob(blob, `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`);
      toast.success(`Đã tạo ZIP ${assetIds.length} video`);
    } catch (e) {
      toastApiError(toast, "Không tạo được ZIP", e);
    } finally {
      setBusy(null);
    }
  };

  const mergeVideos = async (assetIds: string[], name?: string): Promise<boolean> => {
    if (assetIds.length < 2) {
      toast.info("Chọn ít nhất 2 video để ghép.");
      return false;
    }
    setBusy("merge");
    try {
      const r = await api.mergeAssets(assetIds, name);
      toast.success(`Đã ghép ${assetIds.length} video thành 1`, r.fileName);
      return true;
    } catch (e) {
      toastApiError(toast, "Không ghép được video", e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const autoEdit = async (assetIds: string[], brief?: string): Promise<boolean> => {
    if (assetIds.length < 2) {
      toast.info("Chọn ít nhất 2 video để AI dựng.");
      return false;
    }
    setBusy("autoedit");
    try {
      const r = await api.autoEditAssets(assetIds, brief);
      toast.success(`AI đã dựng ${r.plan.clips.length} clip thành 1 video`, r.asset.fileName);
      return true;
    } catch (e) {
      toastApiError(toast, "AI không dựng được video", e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Dựng nâng cao (Claude Code): chạy nền vài phút, hỏi trạng thái mỗi 10s rồi báo */
  const proEdit = async (assetIds: string[], brief?: string): Promise<boolean> => {
    if (assetIds.length < 2) {
      toast.info("Chọn ít nhất 2 video để dựng.");
      return false;
    }
    try {
      const j = await api.proEditAssets(assetIds, brief);
      toast.info("Claude Code đang dựng video", "Mất khoảng 5-10 phút, xong sẽ tự báo và thêm vào Thư viện.");
      void (async () => {
        for (let i = 0; i < 270; i++) {
          await new Promise((r) => setTimeout(r, 10_000));
          try {
            const s = await api.proEditStatus(j.id);
            if (s.status === "done") {
              toast.success("Dựng nâng cao xong", s.message);
              emitLocal({ type: "local.library" });
              return;
            }
            if (s.status === "failed") {
              toast.error("Dựng nâng cao thất bại", s.error ?? s.message);
              return;
            }
          } catch {
            /* BVS đang bận/khởi động lại: thử lại lần sau */
          }
        }
      })();
      return true;
    } catch (e) {
      toastApiError(toast, "Không bắt đầu được dựng nâng cao", e);
      return false;
    }
  };

  const addToLibrary = async (assetIds: string[], inLibrary = true) => {
    if (!assetIds.length) return toast.info("Chưa chọn video nào đã hoàn thành.");
    try {
      const r = await api.setLibrary(assetIds, inLibrary);
      toast.success(inLibrary ? `Đã thêm ${r.updated} video vào Thư viện` : `Đã bỏ ${r.updated} video khỏi Thư viện`);
      emitLocal({ type: "local.library" });
    } catch (e) {
      toastApiError(toast, "Không cập nhật được Thư viện", e);
    }
  };

  /** Xóa HẲN video đã tạo (file + dữ liệu) - luôn hỏi lại, không hoàn tác được */
  const deleteAssets = async (assetIds: string[], label?: string): Promise<boolean> => {
    if (!assetIds.length) {
      toast.info("Chưa chọn video nào.");
      return false;
    }
    const ok = await dialogs.confirm({
      title: assetIds.length === 1 ? "Xóa vĩnh viễn video này?" : `Xóa vĩnh viễn ${assetIds.length} video?`,
      body: `${label ? `${label}. ` : ""}File video, ảnh thumbnail và dữ liệu liên quan bị xóa khỏi máy - KHÔNG hoàn tác được. Prompt và lịch sử chi phí của job vẫn được giữ.`,
      confirmLabel: "Xóa vĩnh viễn",
      danger: true,
    });
    if (!ok) return false;
    setBusy("delete");
    try {
      const r = await api.deleteAssets(assetIds);
      const mb = Math.round((r.freedBytes / 1048576) * 10) / 10;
      toast.success(`Đã xóa ${r.deleted.length} video (giải phóng ${mb} MB)`, r.skipped.length ? `Bỏ qua ${r.skipped.length}: ${r.skipped[0]!.reason}` : undefined);
      emitLocal({ type: "local.library" });
      refresh(null);
      return true;
    } catch (e) {
      toastApiError(toast, "Không xóa được video", e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Xóa HẲN batch (tùy chọn giữ lại video trong Thư viện) */
  const deleteBatch = async (batch: Batch, keepAssets = false): Promise<boolean> => {
    const done = (batch.counts.completed ?? 0) + (batch.counts.failed ?? 0) + (batch.counts.cancelled ?? 0);
    const ok = await dialogs.confirm({
      title: `Xóa batch "${batch.name}"?`,
      body: keepAssets
        ? `Xóa batch và ${batch.total} job (prompt, lịch sử). Video đã tạo được GIỮ LẠI trong Thư viện. Không hoàn tác được.`
        : `Xóa batch, ${batch.total} job và toàn bộ video đã tạo (${batch.counts.completed ?? 0} video, trong tổng ${done} job đã kết thúc). File bị xóa khỏi máy - KHÔNG hoàn tác được.`,
      confirmLabel: keepAssets ? "Xóa batch, giữ video" : "Xóa batch + video",
      danger: true,
    });
    if (!ok) return false;
    setBusy("delete");
    try {
      const r = await api.deleteBatch(batch.id, keepAssets);
      const mb = Math.round((r.freedBytes / 1048576) * 10) / 10;
      toast.success(`Đã xóa batch: ${r.jobsDeleted} job, ${r.assetsDeleted} video`, r.freedBytes ? `Giải phóng ${mb} MB` : undefined);
      emitLocal({ type: "local.library" });
      refresh(null);
      return true;
    } catch (e) {
      toastApiError(toast, "Không xóa được batch", e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const dialog = req ? (
    <CostConfirmDialog open title={req.title} description={req.description} count={req.count} estimate={req.estimate} currency={req.currency} confirmLabel={req.confirmLabel} onConfirm={req.run} onClose={() => setReq(null)} />
  ) : null;

  return { cancelJob, cancelJobs, retryJobs, retryFailed, approveJobs, downloadZip, mergeVideos, autoEdit, proEdit, addToLibrary, deleteAssets, deleteBatch, busy, dialog };
}

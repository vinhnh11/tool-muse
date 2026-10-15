import { useEffect, useState, type ReactNode } from "react";
import { PlayCircle } from "lucide-react";
import { asApiError, type ApiError } from "../api";
import { fmtCost } from "../labels";
import { Button } from "./Button";
import { ErrorBanner } from "./EmptyState";
import { Checkbox } from "./Field";
import { Modal } from "./Modal";

export interface CostAck {
  approvedMaxCost?: number;
  acknowledgeUnknownCost?: boolean;
}

/**
 * Xác nhận việc có thể tốn phí (tạo lại job lỗi, duyệt phiên bản mới...).
 * Chi phí không xác định → bắt buộc tick "Tôi chấp nhận chi phí không xác định".
 */
export function CostConfirmDialog({
  open,
  title,
  description,
  count,
  estimate,
  currency = "USD",
  confirmLabel = "Xác nhận",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  count: number;
  estimate: number | null;
  currency?: string;
  confirmLabel?: string;
  onConfirm: (ack: CostAck) => Promise<void>;
  onClose: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (open) {
      setAck(false);
      setError(null);
    }
  }, [open]);
  const unknown = estimate === null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(unknown ? { acknowledgeUnknownCost: true } : { approvedMaxCost: estimate ?? 0, acknowledgeUnknownCost: false });
      onClose();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      size="sm"
      title={title}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" icon={<PlayCircle size={16} />} loading={busy} disabled={unknown && !ack} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description ? <div className="confirm-body">{description}</div> : null}
      <dl className="kv">
        <dt>Số video</dt>
        <dd>{count}</dd>
        <dt>Chi phí ước tính</dt>
        <dd className={unknown ? "text-warning" : undefined}>{unknown ? "Không xác định (chưa có đơn giá)" : fmtCost(estimate, currency)}</dd>
      </dl>
      {unknown ? <Checkbox checked={ack} onChange={setAck} label="Tôi chấp nhận chi phí không xác định" /> : null}
      <ErrorBanner error={error} compact />
    </Modal>
  );
}

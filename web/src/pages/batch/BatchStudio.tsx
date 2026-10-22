import { useEffect, useMemo, useRef, useState } from "react";
import { CircleDollarSign, FileText, List, PenLine, Rocket, ShieldCheck, SlidersHorizontal, Sparkles, Wand2 } from "lucide-react";
import { api, asApiError, type ApiError, type BatchCheck, type BatchEstimate, type BatchRequest, type GenerateResult, type ParseResult, type PromptInput } from "../../api";
import { Button } from "../../components/Button";
import { CheckResultView, EstimateView } from "../../components/CheckResult";
import { Banner, ErrorBanner } from "../../components/EmptyState";
import { Field, Input, TextArea } from "../../components/Field";
import { Tabs } from "../../components/Tabs";
import { useToast } from "../../components/Toast";
import { useApi, useDebounced, useLocalStorage } from "../../hooks/useApi";
import { emitLocal, useRealtimeRefetch } from "../../hooks/useEvents";
import { fmtNumber } from "../../labels";
import { useStudio } from "../../state/studio";
import { AiGenerateForm } from "./AiGenerateForm";
import { BatchesSection } from "./BatchesSection";
import { DeployDialog } from "./DeployDialog";
import { FileImport, LineCounter, LIST_PLACEHOLDER, MakeSetButton, type CreateTab } from "./CreateArea";
import { FB_NONE, FbPageSelect, ShopeeUrlField, shopeeError, useFbPages } from "./FbPageSelect";
import { PromptSetPanel } from "./PromptSetPanel";
import { useVideoConfig } from "./useVideoConfig";
import { ReferencePicker, VideoConfigPanel } from "./VideoConfigPanel";

interface FileState {
  name: string;
  size: number;
  text: string;
}

interface Source {
  mode: "single" | "list" | "file" | "ai";
  prompts: PromptInput[];
  lines?: (number | null)[];
  blankLines?: number[];
  promptSetId?: string | null;
}

type Result = { check: BatchCheck | null; estimate: BatchEstimate | null; focus: "check" | "estimate" | "create" };

function useParse(text: string, fileName: string | undefined, format: "txt" | undefined, enabled: boolean) {
  const debounced = useDebounced(text, 400);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!debounced.trim()) {
      setParse(null);
      setError(null);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    api
      .parsePrompts({ text: debounced, fileName, format })
      .then((r) => {
        if (my === seq.current) {
          setParse(r);
          setError(null);
        }
      })
      .catch((e) => my === seq.current && setError(asApiError(e)))
      .finally(() => my === seq.current && setLoading(false));
  }, [debounced, fileName, format, enabled]);
  return { parse: debounced.trim() ? parse : null, error, loading: loading || debounced !== text };
}

export function BatchStudio() {
  const { providers, sessionId, activeSetId, setActiveSetId, setSelectedBatchId, openApproval } = useStudio();
  const toast = useToast();
  const cfg = useVideoConfig(providers);
  const [tab, setTab] = useLocalStorage<CreateTab>("bvs.batch.tab", "list");
  const [singleText, setSingleText] = useLocalStorage<string>("bvs.batch.single", "");
  const [listText, setListText] = useLocalStorage<string>("bvs.batch.list", "");
  const [file, setFile] = useLocalStorage<FileState | null>("bvs.batch.file", null);
  const [useSet, setUseSet] = useLocalStorage<boolean>("bvs.batch.useSet", false);
  const [onlyApproved, setOnlyApproved] = useLocalStorage<boolean>("bvs.batch.onlyApproved", false);
  const [useItemOverrides, setUseItemOverrides] = useLocalStorage<boolean>("bvs.batch.itemOverrides", true);
  const [batchName, setBatchName] = useState("");
  const [busy, setBusy] = useState<"check" | "estimate" | "create" | "makeSet" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<ApiError | { message: string } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // Triển khai bộ prompt (mỗi prompt = 1 video). pendingAuto: sinh xong bằng AI → mở triển khai luôn
  const [deploy, setDeploy] = useState<{ setId: string; auto: boolean } | null>(null);
  const [pendingAuto, setPendingAuto] = useState<string | null>(null);

  const set = useApi(() => (activeSetId ? api.promptSet(activeSetId) : Promise.resolve(null)), [activeSetId]);
  useRealtimeRefetch((ev) => Boolean(activeSetId) && ev.type === "local.promptSet", () => void set.reload(), 100);
  useEffect(() => {
    if (set.error?.status === 404) setActiveSetId(null);
  }, [set.error, setActiveSetId]);

  // Mở bộ prompt mới (từ AI / chat / danh sách) → mặc định dùng cho batch
  const prevSet = useRef(activeSetId);
  useEffect(() => {
    if (activeSetId && activeSetId !== prevSet.current) setUseSet(true);
    prevSet.current = activeSetId;
  }, [activeSetId, setUseSet]);

  const listParse = useParse(listText, undefined, "txt", tab === "list");
  const fileParse = useParse(file?.text ?? "", file?.name, undefined, tab === "file");
  const curParse = tab === "list" ? listParse : fileParse;

  const setSourceActive = Boolean(activeSetId && set.data && (tab === "ai" || useSet));
  const setItemsUsable = useMemo(() => (set.data?.items ?? []).filter((i) => (onlyApproved ? i.approval === "approved" : i.approval !== "rejected")).length, [set.data, onlyApproved]);

  // Tóm tắt nguồn prompt hiện tại (hiển thị ngay, không gọi server)
  const sourceSummary = (() => {
    const v = cfg.state.variantsPerPrompt;
    const fmt = (n: number, what: string) => (v > 1 ? `${fmtNumber(n)} ${what} × ${v} lần → ${fmtNumber(n * v)} video` : `${fmtNumber(n)} ${what} → ${fmtNumber(n)} video`);
    if (setSourceActive && set.data) return { text: fmt(setItemsUsable, onlyApproved ? "prompt đã duyệt" : "prompt"), from: `Bộ prompt “${set.data.name}”` };
    if (tab === "ai") return { text: "Chưa có bộ prompt", from: "Tạo prompt bằng AI" };
    if (tab === "single") return { text: singleText.trim() ? fmt(1, "prompt") : "Chưa nhập prompt", from: "Tạo đơn" };
    const p = curParse.parse;
    return { text: p ? fmt(p.check.uniqueLines.length, "dòng") : "Chưa có prompt", from: tab === "list" ? "Danh sách prompt" : file?.name ?? "Nhập từ file" };
  })();

  const resolveSource = async (): Promise<Source> => {
    const neg = cfg.model?.negativePrompt && cfg.state.negative.trim() ? cfg.state.negative.trim() : null;
    const withNeg = (p: PromptInput): PromptInput => (neg && !p.negative ? { ...p, negative: neg } : p);
    if ((tab === "ai" || useSet) && activeSetId) {
      const s = set.data ?? (await api.promptSet(activeSetId));
      const items = s.items.filter((i) => (onlyApproved ? i.approval === "approved" : i.approval !== "rejected"));
      if (!items.length) throw new Error(onlyApproved ? "Bộ prompt chưa có prompt nào được duyệt - duyệt prompt hoặc tắt “Chỉ dùng prompt đã duyệt”." : "Bộ prompt không còn prompt nào (đã loại hết).");
      return {
        mode: s.source === "ai" ? "ai" : tab === "file" ? "file" : "list",
        promptSetId: s.id,
        prompts: items.map((i) =>
          withNeg({
            prompt: i.prompt,
            title: i.title || undefined,
            negative: i.negative,
            durationSec: useItemOverrides ? i.durationSec : null,
            aspectRatio: useItemOverrides ? i.aspectRatio : null,
            referenceAssetIds: i.referenceAssetIds.length ? i.referenceAssetIds : undefined,
            promptItemId: i.id,
          }),
        ),
        lines: items.map((i) => i.index),
      };
    }
    if (tab === "ai") throw new Error("Hãy tạo bộ prompt bằng AI (hoặc chọn bộ prompt đã có) trước.");
    if (tab === "single") {
      const p = singleText.trim();
      if (!p) throw new Error("Nhập prompt trước.");
      return { mode: "single", prompts: [withNeg({ prompt: p })] };
    }
    const text = tab === "list" ? listText : (file?.text ?? "");
    if (!text.trim()) throw new Error(tab === "list" ? "Danh sách prompt đang trống." : "Chưa chọn file prompt.");
    const parsed = await api.parsePrompts({ text, fileName: tab === "file" ? file?.name : undefined, format: tab === "list" ? "txt" : undefined });
    if (!parsed.items.length) throw new Error(`Không đọc được prompt nào${parsed.errors[0] ? `: ${parsed.errors[0].message}` : "."}`);
    return {
      mode: tab,
      prompts: parsed.items.map((it) => withNeg({ prompt: it.draft.prompt, title: it.draft.title, negative: it.draft.negative ?? null, durationSec: it.draft.durationSec ?? null, aspectRatio: it.draft.aspectRatio ?? null })),
      lines: parsed.items.map((i) => i.line),
      blankLines: parsed.blankLines,
    };
  };

  const buildRequest = (src: Source): BatchRequest => {
    if (!cfg.provider || !cfg.model || !cfg.config) throw new Error("Chọn provider và model ở Cấu hình video.");
    if (cfg.budgetInvalid) throw new Error("Ngân sách không hợp lệ.");
    return {
      name: batchName.trim() || undefined,
      sessionId,
      mode: src.mode,
      promptSetId: src.promptSetId ?? null,
      providerConfigId: cfg.provider.id,
      modelId: cfg.model.modelId,
      config: cfg.config,
      prompts: src.prompts,
      maxConcurrency: cfg.state.maxConcurrency,
      budgetLimit: cfg.budgetLimit,
      blankLines: src.blankLines,
      lines: src.lines,
      fbPage: fb.toRequest(fbPage),
      shopeeUrl: fbPage && fbPage !== FB_NONE && shopeeUrl.trim() ? shopeeUrl.trim() : undefined,
    };
  };

  const scrollToResult = () => setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);

  const runEstimate = async (focus: "check" | "estimate") => {
    setBusy(focus);
    setError(null);
    try {
      const req = buildRequest(await resolveSource());
      const r = await api.estimate(req);
      setResult({ check: r.check, estimate: r.estimate, focus });
      scrollToResult();
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? { message: e.message } : asApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const createBatch = async () => {
    setBusy("create");
    setError(null);
    try {
      const req = buildRequest(await resolveSource());
      const r = await api.createBatch(req);
      setResult({ check: r.check, estimate: r.estimate, focus: "create" });
      setSelectedBatchId(r.batch.id);
      setBatchName("");
      emitLocal({ type: "local.batch", batchId: r.batch.id });
      toast.success(`Đã tạo batch “${r.batch.name}” - chờ duyệt`, r.check.summary);
      openApproval(r.batch.id, r.estimate);
    } catch (e) {
      if (e instanceof Error && !("code" in e)) setError({ message: e.message });
      else {
        const err = asApiError(e);
        setError(err);
        if (err.code === "BATCH_INVALID" && err.details) setResult({ check: err.details as BatchCheck, estimate: null, focus: "create" });
        if (err.code === "BUDGET_EXCEEDED" && err.details) setResult({ check: null, estimate: err.details as BatchEstimate, focus: "create" });
        scrollToResult();
      }
    } finally {
      setBusy(null);
    }
  };

  const makeSet = async () => {
    const text = tab === "list" ? listText : (file?.text ?? "");
    if (!text.trim()) return;
    setBusy("makeSet");
    try {
      const s = await api.createPromptSet({
        name: tab === "file" && file ? file.name : `Danh sách ${new Date().toLocaleString("vi-VN")}`,
        sessionId,
        text,
        fileName: tab === "file" ? file?.name : "danh-sach.txt",
      });
      setActiveSetId(s.id);
      setUseSet(true);
      emitLocal({ type: "local.promptSets" });
      toast.success(`Đã tạo bộ prompt “${s.name}” (${s.counts.total} prompt)`, "Xem, sửa, duyệt từng prompt ở bảng bên dưới.");
    } catch (e) {
      toast.error("Không tạo được bộ prompt", asApiError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const onGenerated = (r: GenerateResult, opts?: { deploy?: boolean }) => {
    setActiveSetId(r.set.id);
    setUseSet(true);
    emitLocal({ type: "local.promptSets" });
    if (opts?.deploy && r.generated > 0) setPendingAuto(r.set.id);
    if (r.shortfall > 0) toast.show({ kind: "warning", title: `AI tạo ${r.generated}/${r.requested} prompt`, detail: r.message }, 9000);
    else toast.success(r.message);
  };

  const cleanList = () => {
    const p = listParse.parse;
    if (!p) return;
    const drop = new Set([...p.blankLines, ...p.check.duplicates.map((d) => d.line)]);
    const lines = listText.split(/\r?\n/);
    setListText(
      lines
        .filter((_, i) => !drop.has(i + 1))
        .join("\n")
        .replace(/\n+$/, ""),
    );
    toast.success(`Đã xóa ${drop.size} dòng trống/trùng`);
  };

  const onFile = async (f: File) => {
    if (f.size > 5 * 1024 * 1024) return toast.error("File quá lớn", "Tối đa 5MB văn bản.");
    const text = await f.text();
    setFile({ name: f.name, size: f.size, text });
  };

  const fb = useFbPages();
  const [fbPage, setFbPage] = useState("");
  const [shopeeUrl, setShopeeUrl] = useState("");
  const hasPage = Boolean(fbPage) && fbPage !== FB_NONE;
  const fbReady = fb.isReady(fbPage) && !(hasPage && shopeeError(shopeeUrl));
  const canAct = Boolean(cfg.provider && cfg.model) && !busy;

  // Bộ prompt vừa sinh đã tải xong → mở triển khai (Mock chạy luôn, provider tính phí vẫn hỏi chi phí)
  useEffect(() => {
    if (pendingAuto && set.data?.id === pendingAuto) {
      setDeploy({ setId: pendingAuto, auto: true });
      setPendingAuto(null);
    }
  }, [pendingAuto, set.data]);

  return (
    <div className="studio">
      <div className="studio-top">
        <section className="card create-card">
          <div className="card-head">
            <div className="card-title">
              <PenLine size={16} aria-hidden /> Khu vực tạo
            </div>
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "single", label: "Tạo đơn", icon: <PenLine size={14} /> },
              { id: "list", label: "Danh sách prompt", icon: <List size={14} /> },
              { id: "file", label: "Nhập từ file", icon: <FileText size={14} /> },
              { id: "ai", label: "Tạo prompt bằng AI", icon: <Sparkles size={14} /> },
            ]}
          />
          <div className="create-body">
            {tab === "single" ? (
              <Field label="Prompt" hint={cfg.model ? `${singleText.length}/${cfg.model.maxPromptChars} ký tự` : undefined} error={cfg.model && singleText.length > cfg.model.maxPromptChars ? `Vượt giới hạn ${cfg.model.maxPromptChars} ký tự của model` : undefined}>
                <TextArea rows={6} value={singleText} onChange={(e) => setSingleText(e.target.value)} placeholder="Mô tả video bạn muốn tạo: chủ thể, hành động, bối cảnh, ánh sáng, chuyển động máy..." />
              </Field>
            ) : null}
            {tab === "list" ? (
              <>
                <TextArea className="mono prompt-textarea" rows={12} value={listText} onChange={(e) => setListText(e.target.value)} placeholder={LIST_PLACEHOLDER} spellCheck={false} aria-label="Danh sách prompt, mỗi dòng một prompt" />
                <LineCounter parse={listParse.parse} loading={listParse.loading} error={listParse.error} variants={cfg.state.variantsPerPrompt} onClean={cleanList} />
                <div className="row-end">
                  <MakeSetButton onClick={() => void makeSet()} busy={busy === "makeSet"} disabled={!listText.trim() || Boolean(busy)} />
                </div>
              </>
            ) : null}
            {tab === "file" ? (
              <>
                <FileImport file={file} onFile={(f) => void onFile(f)} onClear={() => setFile(null)} onEdit={(text) => file && setFile({ ...file, text })} />
                {file ? <LineCounter parse={fileParse.parse} loading={fileParse.loading} error={fileParse.error} variants={cfg.state.variantsPerPrompt} /> : null}
                {file ? (
                  <div className="row-end">
                    <MakeSetButton onClick={() => void makeSet()} busy={busy === "makeSet"} disabled={!file.text.trim() || Boolean(busy)} />
                  </div>
                ) : null}
              </>
            ) : null}
            {tab === "ai" ? <AiGenerateForm cfg={cfg} onGenerated={onGenerated} /> : null}
          </div>
          <div className="create-refs">
            <ReferencePicker cfg={cfg} />
          </div>
        </section>

        <aside className="card config-card">
          <div className="card-head">
            <div className="card-title">
              <SlidersHorizontal size={16} aria-hidden /> Cấu hình video
            </div>
          </div>
          <VideoConfigPanel cfg={cfg} />
          <div className="action-block">
            <div className="source-summary">
              <div className="muted tiny">Nguồn: {sourceSummary.from}</div>
              <div className="source-count">{sourceSummary.text}</div>
            </div>
            <Field label="Tên batch (tùy chọn)">
              <Input value={batchName} onChange={(e) => setBatchName(e.target.value)} placeholder="vd: Serum - đợt 1" />
            </Field>
            <FbPageSelect pages={fb.pages} value={fbPage} onChange={(v) => { setFbPage(v); if (!v || v === FB_NONE) setShopeeUrl(""); }} disabled={Boolean(busy)} />
            {hasPage ? <ShopeeUrlField value={shopeeUrl} onChange={setShopeeUrl} disabled={Boolean(busy)} /> : null}
            <div className="action-buttons">
              <Button icon={<ShieldCheck size={15} />} loading={busy === "check"} disabled={!canAct} onClick={() => void runEstimate("check")}>
                Kiểm tra prompt
              </Button>
              <Button icon={<CircleDollarSign size={15} />} loading={busy === "estimate"} disabled={!canAct} onClick={() => void runEstimate("estimate")}>
                Ước tính chi phí
              </Button>
            </div>
            <Button variant="primary" size="lg" block icon={<Rocket size={16} />} loading={busy === "create"} disabled={!canAct || !fbReady} title={fbReady ? undefined : "Chọn Page đăng Facebook (hoặc “Không đăng lên Facebook”) và kiểm tra link Shopee trước"} onClick={() => void createBatch()}>
              Tạo batch
            </Button>
            <p className="muted tiny">Tạo batch chỉ lưu ở trạng thái “Chờ duyệt” - chưa gọi provider, chưa tốn phí cho tới khi bạn bấm “Duyệt & chạy”.</p>
          </div>
        </aside>
      </div>

      {error || result ? (
        <section className="card result-card" ref={resultRef}>
          <div className="card-head">
            <div className="card-title">
              <Wand2 size={16} aria-hidden /> Kết quả kiểm tra & ước tính
            </div>
            <Button size="sm" variant="ghost" onClick={() => (setResult(null), setError(null))}>
              Ẩn
            </Button>
          </div>
          {error ? <ErrorBanner error={error} title={"code" in error && error.code === "BATCH_INVALID" ? "Chưa tạo batch - danh sách có lỗi" : undefined} /> : null}
          {result ? (
            <div className={`result-grid${result.focus === "estimate" ? " focus-estimate" : ""}`}>
              {result.check ? <CheckResultView check={result.check} /> : null}
              {result.estimate ? <EstimateView estimate={result.estimate} /> : null}
            </div>
          ) : null}
          {result?.check && !result.check.ok && result.focus !== "create" ? <Banner tone="warning">Sửa các dòng lỗi (hoặc bấm “Dọn dòng trống & trùng”) rồi kiểm tra lại trước khi tạo batch.</Banner> : null}
        </section>
      ) : null}

      <PromptSetPanel
        set={set.data}
        loading={set.loading}
        error={set.error && set.error.status !== 404 ? set.error : null}
        reload={set.reload}
        cfg={cfg}
        useSet={useSet}
        setUseSet={setUseSet}
        onlyApproved={onlyApproved}
        setOnlyApproved={setOnlyApproved}
        useItemOverrides={useItemOverrides}
        setUseItemOverrides={setUseItemOverrides}
        onDeploy={() => set.data && setDeploy({ setId: set.data.id, auto: false })}
      />

      {deploy && set.data?.id === deploy.setId ? (
        <DeployDialog set={set.data} cfg={cfg} selection={onlyApproved ? "approved" : "all"} useItemOverrides={useItemOverrides} autoRunFree={deploy.auto} onClose={() => setDeploy(null)} />
      ) : null}

      <BatchesSection />
    </div>
  );
}

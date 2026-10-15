import type { ReactNode } from "react";
import { AudioLines, Camera, CheckCircle2, Clapperboard, Eye, Film, Layers, Lightbulb, Palette, Recycle, Scissors, Timer, XCircle, Zap } from "lucide-react";
import type { Analysis, Asset } from "../api";
import { AnalysisStatusBadge, Badge } from "../components/Badge";
import { ErrorBanner } from "../components/EmptyState";
import { ProgressBar } from "../components/ProgressBar";
import { VideoPlayer } from "../components/VideoPlayer";
import { AUDIO_COVERAGE_TEXT, fmtNumber, fmtSeconds, fmtTimecode } from "../labels";

function colorOf(s: string): string | null {
  const hex = s.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/i)?.[0];
  if (hex) return hex;
  const plain = s.trim();
  if (plain && plain.length < 30 && typeof CSS !== "undefined" && CSS.supports("color", plain)) return plain;
  return null;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="an-section">
      <h4 className="an-title">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Chips({ items, tone = "neutral" }: { items: string[] | undefined; tone?: "neutral" | "info" | "danger" }) {
  const list = (items ?? []).filter((x) => x && x.trim());
  if (!list.length) return <span className="muted small">-</span>;
  return (
    <div className="chip-row">
      {list.map((x, i) => (
        <Badge key={i} tone={tone}>
          {x}
        </Badge>
      ))}
    </div>
  );
}

function Text({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value || !value.trim()) return null;
  return (
    <p className="an-text">
      <span className="an-label">{label}:</span> {value}
    </p>
  );
}

/** Hộp "Độ phủ phân tích" - nói thật đã xem bao nhiêu khung, đã nghe âm thanh chưa */
export function CoverageBox({ a }: { a: Analysis }) {
  const c = a.coverage ?? {};
  const audio = c.audio ? AUDIO_COVERAGE_TEXT[c.audio] : null;
  const hasCoverage = c.framesAnalyzed !== undefined;
  return (
    <div className="coverage">
      <div className="coverage-head">
        <Eye size={16} aria-hidden />
        <strong>Độ phủ phân tích</strong>
        {hasCoverage ? (
          c.wholeVideoCovered ? (
            <Badge tone="success">
              <CheckCircle2 size={12} /> Đã phủ toàn bộ video
            </Badge>
          ) : (
            <Badge tone="warning">
              <XCircle size={12} /> Chưa phủ toàn bộ video
            </Badge>
          )
        ) : null}
      </div>
      {!hasCoverage ? (
        <div className="muted small">{a.status === "completed" ? "Không có dữ liệu độ phủ." : "Độ phủ sẽ hiện khi phân tích xong."}</div>
      ) : (
        <>
          <div className="coverage-grid">
            <div>
              <div className="cov-value">{fmtNumber(c.framesAnalyzed)}</div>
              <div className="cov-label">khung hình đã xem</div>
            </div>
            <div>
              <div className="cov-value">{fmtNumber(c.hookFrames)}</div>
              <div className="cov-label">khung ở hook (giây đầu)</div>
            </div>
            <div>
              <div className="cov-value">{fmtNumber(c.segments)}</div>
              <div className="cov-label">đoạn{c.segmentSec ? ` × ${c.segmentSec}s` : ""}</div>
            </div>
            <div>
              <div className="cov-value">{fmtNumber(c.sceneCutsDetected)}</div>
              <div className="cov-label">mốc chuyển cảnh đo được</div>
            </div>
            <div>
              <div className="cov-value">{fmtSeconds(c.durationSec)}</div>
              <div className="cov-label">thời lượng video</div>
            </div>
          </div>
          <div className={`coverage-audio tone-${audio?.tone ?? "neutral"}`}>
            <AudioLines size={15} aria-hidden />
            <span>{audio?.text ?? "Không rõ trạng thái âm thanh"}</span>
            {c.audio === "analyzed" && c.audioChunks ? <span className="muted small">({c.audioChunks} khúc)</span> : null}
          </div>
          {c.audio === "not_configured" ? (
            <div className="muted small">
              Muốn phân tích lời thoại/nhạc: nhập model nghe ở{" "}
              <a className="link" href="#/settings">
                Cài đặt → LLM
              </a>{" "}
              rồi phân tích lại.
            </div>
          ) : null}
          {c.audioError ? <div className="text-danger small">{c.audioError}</div> : null}
          {c.notes?.length ? (
            <ul className="note-list">
              {c.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function AnalysisDetail({ a, asset, actions }: { a: Analysis; asset: Asset | undefined; actions?: ReactNode }) {
  const r = a.result;
  const m = a.measurements ?? {};
  return (
    <div className="an-detail">
      <div className="an-head">
        <div>
          <h3 className="an-name">{asset?.fileName ?? a.assetId}</h3>
          <div className="muted small">
            {a.models?.vision ? `xem hình: ${a.models.vision}` : ""}
            {a.models?.text ? ` · tổng hợp: ${a.models.text}` : ""}
            {a.models?.audio ? ` · nghe: ${a.models.audio}` : " · chưa có model nghe"}
          </div>
        </div>
        <AnalysisStatusBadge status={a.status} />
        <span className="spacer" />
        {actions}
      </div>

      {a.status === "queued" || a.status === "running" ? (
        <div className="an-progress">
          <ProgressBar value={a.status === "queued" ? null : a.progress} />
          <span className="muted small">
            {a.step ?? "Đang chờ"} {a.status === "running" ? `· ${a.progress}%` : ""}
          </span>
        </div>
      ) : null}
      {a.status === "failed" ? <ErrorBanner error={{ code: a.error?.match(/^[A-Z_]+/)?.[0], message: a.error ?? "Phân tích lỗi" }} title="Phân tích thất bại" /> : null}

      <div className="an-top">
        {asset ? (
          <div className="an-video">
            <VideoPlayer src={asset.urls.preview} poster={asset.urls.thumbnail} compact />
          </div>
        ) : null}
        <CoverageBox a={a} />
      </div>

      {r ? (
        <div className="an-sections">
          <Section icon={<Film size={15} />} title="Nội dung & diễn biến">
            <p>{r.content.summary}</p>
            <Chips items={r.content.subjects} tone="info" />
            {r.content.storyline?.length ? (
              <ol className="storyline">
                {r.content.storyline.map((s, i) => (
                  <li key={i}>
                    <span className="mono storyline-time">
                      {fmtTimecode(s.start)}-{fmtTimecode(s.end)}
                    </span>
                    <span>{s.description}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </Section>
          <Section icon={<Zap size={15} />} title="Hook">
            <Text label="Giây đầu" value={r.hook.first_seconds} />
            <Text label="Kỹ thuật" value={r.hook.technique} />
            <Text label="Vì sao hiệu quả" value={r.hook.why_it_works} />
          </Section>
          <Section icon={<Palette size={15} />} title="Phong cách hình ảnh, ánh sáng, màu">
            <Text label="Tổng thể" value={r.visual_style.look} />
            <Text label="Ánh sáng" value={r.visual_style.lighting} />
            <Text label="Chất liệu" value={r.visual_style.texture} />
            <div className="palette">
              {(r.visual_style.color_palette ?? [])
                .filter((x) => x && x.trim())
                .map((c, i) => {
                  const col = colorOf(c);
                  return (
                    <span key={i} className="swatch-chip">
                      {col ? <span className="swatch" style={{ background: col }} aria-hidden /> : null}
                      {c}
                    </span>
                  );
                })}
            </div>
          </Section>
          <Section icon={<Camera size={15} />} title="Chuyển động máy">
            <div className="an-label">Chuyển động</div>
            <Chips items={r.camera.movements} />
            <div className="an-label">Cỡ cảnh</div>
            <Chips items={r.camera.shot_sizes} />
            <div className="an-label">Góc máy</div>
            <Chips items={r.camera.angles} />
          </Section>
          <Section icon={<Layers size={15} />} title="Bố cục & chuyển cảnh">
            <Text label="Bố cục" value={r.composition_transitions.composition} />
            <div className="an-label">Chuyển cảnh</div>
            <Chips items={r.composition_transitions.transitions} />
          </Section>
          <Section icon={<Scissors size={15} />} title="Nhịp dựng">
            <div className="metric-row">
              <div className="metric">
                <div className="metric-value">{m.cutsPerMinute !== undefined && m.cutsPerMinute !== null ? fmtNumber(Math.round(m.cutsPerMinute * 10) / 10) : "-"}</div>
                <div className="metric-label">cắt/phút</div>
              </div>
              <div className="metric">
                <div className="metric-value">{m.avgShotSec !== undefined && m.avgShotSec !== null ? `${fmtNumber(Math.round(m.avgShotSec * 10) / 10)}s` : "-"}</div>
                <div className="metric-label">độ dài shot TB</div>
              </div>
              <div className="metric">
                <div className="metric-value">{fmtNumber(m.shotCount)}</div>
                <div className="metric-label">số shot</div>
              </div>
            </div>
            <Text label="Cấu trúc" value={r.pacing_storytelling.structure} />
            <Text label="Nhịp" value={r.pacing_storytelling.rhythm} />
          </Section>
          <Section icon={<AudioLines size={15} />} title="Âm thanh">
            {a.coverage.audio && a.coverage.audio !== "analyzed" ? <div className={`coverage-audio tone-${AUDIO_COVERAGE_TEXT[a.coverage.audio].tone}`}>{AUDIO_COVERAGE_TEXT[a.coverage.audio].text}</div> : null}
            <Text label="Lời thoại" value={r.audio.dialogue_summary} />
            <Text label="Nhạc" value={r.audio.music} />
            <Text label="Giọng" value={r.audio.voice} />
            {(r.audio.sound_effects ?? []).filter(Boolean).length ? (
              <>
                <div className="an-label">Hiệu ứng</div>
                <Chips items={r.audio.sound_effects} />
              </>
            ) : null}
            {r.audio.transcript?.length ? (
              <details className="disclosure">
                <summary>Lời thoại chi tiết ({r.audio.transcript.length} câu)</summary>
                <ol className="storyline">
                  {r.audio.transcript.map((t, i) => (
                    <li key={i}>
                      <span className="mono storyline-time">{fmtTimecode(t.start)}</span>
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </Section>
          <Section icon={<Recycle size={15} />} title="Đặc điểm tái sử dụng">
            {r.reusable_traits?.length ? (
              <ul className="bullet">
                {r.reusable_traits.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            ) : (
              <span className="muted small">-</span>
            )}
          </Section>
          <Section icon={<Lightbulb size={15} />} title="Gợi ý prompt">
            <Text label="Thể loại" value={r.generation_hints.genre} />
            <div className="an-label">Nên có</div>
            <Chips items={r.generation_hints.prompt_elements} tone="info" />
            <div className="an-label">Nên tránh</div>
            <Chips items={r.generation_hints.avoid} tone="danger" />
          </Section>
          <Section icon={<Timer size={15} />} title="Thông số đo được (FFmpeg)">
            <p className="small">
              {fmtSeconds(m.durationSec)} · {m.width && m.height ? `${m.width}×${m.height}` : "-"} · {m.fps ? `${Math.round(m.fps)} fps` : "-"} · {m.hasAudio ? "có tiếng" : "không tiếng"}
              {m.integratedLufs !== undefined && m.integratedLufs !== null ? ` · ${m.integratedLufs} LUFS` : ""}
              {m.silenceRatio !== undefined && m.silenceRatio !== null ? ` · im lặng ${Math.round(m.silenceRatio * 100)}%` : ""}
            </p>
          </Section>
        </div>
      ) : a.status === "completed" ? (
        <div className="muted">Không có kết quả.</div>
      ) : null}
      {!r && a.status !== "failed" ? (
        <p className="muted small">
          <Clapperboard size={12} /> Kết quả hiện ngay khi phân tích xong (trang tự cập nhật).
        </p>
      ) : null}
    </div>
  );
}

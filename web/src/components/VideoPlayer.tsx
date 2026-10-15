import { forwardRef, useImperativeHandle, useRef } from "react";
import { Download, Maximize2 } from "lucide-react";

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  element: HTMLVideoElement | null;
}

interface Props {
  src: string;
  poster?: string | null;
  download?: string | null;
  title?: string;
  autoPlay?: boolean;
  compact?: boolean;
}

/** Trình phát video (bản preview phát được trên trình duyệt) + toàn màn hình + tải */
export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ src, poster, download, title, autoPlay, compact }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    play: () => void video.current?.play().catch(() => undefined),
    pause: () => video.current?.pause(),
    seek: (t: number) => {
      if (video.current) video.current.currentTime = t;
    },
    get element() {
      return video.current;
    },
  }));

  const fullscreen = () => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!el) return;
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    else el.webkitEnterFullscreen?.();
  };

  return (
    <div className={`player${compact ? " player-compact" : ""}`} ref={wrap}>
      <video ref={video} key={src} src={src} poster={poster ?? undefined} controls playsInline preload="metadata" autoPlay={autoPlay} aria-label={title ?? "Video"} />
      <div className="player-tools">
        <button type="button" className="btn btn-ghost btn-sm btn-icon-only" onClick={fullscreen} title="Toàn màn hình" aria-label="Toàn màn hình">
          <Maximize2 size={14} />
        </button>
        {download ? (
          <a className="btn btn-ghost btn-sm btn-icon-only" href={download} download title="Tải video" aria-label="Tải video">
            <Download size={14} />
          </a>
        ) : null}
      </div>
    </div>
  );
});

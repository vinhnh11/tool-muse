import { Fragment, type ReactNode } from "react";

/** Markdown tối giản an toàn (không dùng innerHTML): đoạn, gạch đầu dòng, đánh số, **đậm**, `code`, tiêu đề # */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-c${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}

export function MiniMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => {
    if (para.length) {
      const k = blocks.length;
      blocks.push(
        <p key={`p${k}`}>
          {para.map((l, i) => (
            <Fragment key={i}>
              {i ? <br /> : null}
              {inline(l, `p${k}-${i}`)}
            </Fragment>
          ))}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const k = blocks.length;
      const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${k}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={`ol${k}`}>{items}</ol> : <ul key={`ul${k}`}>{items}</ul>);
      list = null;
    }
  };
  for (const raw of lines) {
    if (code) {
      if (raw.trim().startsWith("```")) {
        blocks.push(<pre key={`code${blocks.length}`} className="code-block">{code.join("\n")}</pre>);
        code = null;
      } else code.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const ordered = Boolean(num);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet?.[1] ?? num?.[1] ?? "").trim());
    } else if (head) {
      flushPara();
      flushList();
      blocks.push(<div key={`h${blocks.length}`} className="md-heading">{inline(head[1]!, `h${blocks.length}`)}</div>);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  if (code) blocks.push(<pre key={`code${blocks.length}`} className="code-block">{(code as string[]).join("\n")}</pre>);
  flushPara();
  flushList();
  return <div className="md">{blocks}</div>;
}

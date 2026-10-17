import React from "react";

// A small, safe markdown renderer for the buyer's answers: paragraphs, **bold**, *italic*, `code`,
// numbered/bulleted lists and pipe tables. It builds React elements (never innerHTML).

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-white">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="px-1 rounded bg-white/5 font-mono text-[0.92em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k} className="text-slate-100">{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().match(/^\|?\s*:?-{3,}/)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={key} className="overflow-x-auto rounded-xl border border-[#1e2538]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#111520] text-slate-400">
                {head.map((h, j) => (
                  <th key={j} className="py-2 px-3 font-semibold whitespace-nowrap">{inline(h, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2538]">
              {rows.map((r, ri) => (
                <tr key={ri} className="hover:bg-white/[0.03]">
                  {r.map((c, j) => (
                    <td key={j} className={`py-2 px-3 ${j === 1 ? "text-white" : "text-slate-300 font-mono"}`}>{inline(c, `${key}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(\d+\.|[-*])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*(\d+\.|[-*])\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1.5`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${key}l${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.trim().startsWith("|") && !/^\s*(\d+\.|[-*])\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={`space-y-3 text-sm leading-relaxed text-slate-300 ${className ?? ""}`}>{blocks}</div>;
};

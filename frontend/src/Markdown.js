import React from 'react';

// Renders the markdown the agents write in their replies: headings, bulleted and numbered lists,
// paragraphs with line breaks, and **bold**, *italic*, `code` and [links](https://...). It builds
// React elements and never inserts HTML, so a reply can't inject markup. Anything else shows as
// plain text.

// Inline: `code`, **bold** or __bold__, *italic* or _italic_, [text](http(s) URL).
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|\b_[^_\n]+?_\b)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/;

export function renderInline(text, keyPrefix = 'i') {
  const nodes = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (m[2]) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {renderInline(label, key)}
        </a>,
      );
    }
    rest = rest.slice(m.index + token.length);
  }
  return nodes;
}

const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;

// Splits the text into blocks: headings, lists (consecutive list lines of one kind) and paragraphs
// (consecutive other lines, kept as separate lines).
export function parseBlocks(text) {
  const blocks = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const last = blocks[blocks.length - 1];
    let m;
    if (!line.trim()) {
      blocks.push({ type: 'gap' });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
    } else if ((m = BULLET.exec(line))) {
      if (last && last.type === 'ul') last.items.push(m[1]);
      else blocks.push({ type: 'ul', items: [m[1]] });
    } else if ((m = NUMBERED.exec(line))) {
      if (last && last.type === 'ol') last.items.push(m[2]);
      else blocks.push({ type: 'ol', start: Number(m[1]), items: [m[2]] });
    } else if (last && last.type === 'p') {
      last.lines.push(line);
    } else {
      blocks.push({ type: 'p', lines: [line] });
    }
  }
  return blocks.filter((b, i, all) => b.type !== 'gap' || (i > 0 && i < all.length - 1 && all[i - 1].type !== 'gap'));
}

export default function Markdown({ text }) {
  return (
    <div className="markdown">
      {parseBlocks(text || '').map((block, i) => {
        const key = `b${i}`;
        switch (block.type) {
          case 'heading':
            return <p key={key} className="markdown-heading"><strong>{renderInline(block.text, key)}</strong></p>;
          case 'ul':
            return <ul key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}</ul>;
          case 'ol':
            return (
              <ol key={key} start={block.start}>
                {block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}
              </ol>
            );
          case 'p':
            return (
              <p key={key}>
                {block.lines.map((line, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(line, `${key}-${j}`)}
                  </React.Fragment>
                ))}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

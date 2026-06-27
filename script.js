const STORAGE_KEY = "writing-room-draft";

const sampleDraft = `# A quieter place to write

Start typing markdown here. The line you are editing shows the source. Everything else renders like a clean document.

## What renders

- Headings
- Ordered and unordered lists
- **Bold**, *italic*, and \`inline code\`
- [Links](https://example.com), quotes, rules, and code blocks
- [ ] Draft the opening
- [x] Keep the room calm

> The work gets easier when the surface stops asking for attention.

\`\`\`js
const firstLine = "Begin with the sentence you can actually write.";
\`\`\`
`;

const editor = document.querySelector("#editor");
const draftTitle = document.querySelector("#draftTitle");
const wordCount = document.querySelector("#wordCount");
const readTime = document.querySelector("#readTime");
const clearDraft = document.querySelector("#clearDraft");

let lines = (localStorage.getItem(STORAGE_KEY) || sampleDraft).replace(/\r\n/g, "\n").split("\n");
let activeIndex = 0;
let pendingCursor = null;
let selectionAnchor = null;
let selectionEnd = null;
let dragStartIndex = null;
let undoStack = [];
let redoStack = [];
let pendingUndoTimeout = null;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInline(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return html;
}

function renderSourceInline(value) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  let html = "";
  let match = pattern.exec(value);

  while (match) {
    html += escapeHtml(value.slice(cursor, match.index));
    const token = match[0];

    if (token.startsWith("`")) {
      html += `<span class="md-token">\`</span><code>${escapeHtml(token.slice(1, -1))}</code><span class="md-token">\`</span>`;
    } else if (token.startsWith("**")) {
      html += `<span class="md-token">**</span><strong>${escapeHtml(token.slice(2, -2))}</strong><span class="md-token">**</span>`;
    } else if (token.startsWith("*")) {
      html += `<span class="md-token">*</span><em>${escapeHtml(token.slice(1, -1))}</em><span class="md-token">*</span>`;
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      html += `<span class="md-token">[</span><a href="${escapeHtml(link[2])}" target="_blank" rel="noreferrer">${escapeHtml(link[1])}</a><span class="md-token">](${escapeHtml(link[2])})</span>`;
    }

    cursor = match.index + token.length;
    match = pattern.exec(value);
  }

  html += escapeHtml(value.slice(cursor));
  return html;
}

function renderActiveLine(line, index) {
  const trimmed = line.trim();
  const codeState = lineIsCode(index);

  if (!trimmed) return "";

  if (codeState.fence || codeState.inCode) {
    return escapeHtml(line);
  }

  const leadingSpace = line.match(/^\s*/)?.[0] || "";
  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    return `${escapeHtml(leadingSpace)}<span class="md-token">${heading[1]} </span>${renderSourceInline(heading[2])}`;
  }

  if (trimmed.startsWith(">")) {
    return `${escapeHtml(leadingSpace)}<span class="md-token">&gt; </span>${renderSourceInline(trimmed.replace(/^>\s?/, ""))}`;
  }

  const task = trimmed.match(/^([-*]\s+\[( |x|X)\]\s+)(.+)$/);
  if (task) {
    return `${escapeHtml(leadingSpace)}<span class="md-token">${escapeHtml(task[1])}</span>${renderSourceInline(task[3])}`;
  }

  const unordered = trimmed.match(/^([-*]\s+)(.+)$/);
  if (unordered) {
    return `${escapeHtml(leadingSpace)}<span class="md-token">${escapeHtml(unordered[1])}</span>${renderSourceInline(unordered[2])}`;
  }

  const ordered = trimmed.match(/^(\d+\.\s+)(.+)$/);
  if (ordered) {
    return `${escapeHtml(leadingSpace)}<span class="md-token">${escapeHtml(ordered[1])}</span>${renderSourceInline(ordered[2])}`;
  }

  return renderSourceInline(line);
}

function getMarkdown() {
  return lines.join("\n");
}

function persist() {
  localStorage.setItem(STORAGE_KEY, getMarkdown());
}

function ensureLine() {
  if (!lines.length) lines = [""];
}

function lineIsCode(index) {
  let inCode = false;
  for (let i = 0; i <= index; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("```")) {
      if (i === index) return { fence: true, inCode };
      inCode = !inCode;
    }
  }
  return { fence: false, inCode };
}

function renderLine(line, index) {
  const trimmed = line.trim();
  const codeState = lineIsCode(index);

  if (!trimmed) return '<span class="empty-line"></span>';

  if (codeState.fence) {
    return '<span class="empty-line code-fence-marker"></span>';
  }

  if (codeState.inCode) {
    return `<pre class="code-line"><code>${escapeHtml(line)}</code></pre>`;
  }

  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return `<h${level}>${renderInline(heading[2])}</h${level}>`;
  }

  if (/^---+$/.test(trimmed)) return "<hr>";

  if (trimmed.startsWith(">")) {
    return `<blockquote><p>${renderInline(trimmed.replace(/^>\s?/, ""))}</p></blockquote>`;
  }

  const task = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.+)$/);
  if (task) {
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return `<ul><li><input type="checkbox" disabled${checked}>${renderInline(task[2])}</li></ul>`;
  }

  const unordered = trimmed.match(/^[-*]\s+(.+)$/);
  if (unordered) return `<ul><li>${renderInline(unordered[1])}</li></ul>`;

  const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
  if (ordered) return `<ol><li>${renderInline(ordered[1])}</li></ol>`;

  return `<p>${renderInline(trimmed)}</p>`;
}

function updateMetrics() {
  const plain = getMarkdown()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_[\]()`.-]/g, " ")
    .trim();
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  wordCount.textContent = words.toLocaleString();
  readTime.textContent = Math.max(1, Math.ceil(words / 220)).toString();
}

function updateTitle() {
  const firstHeading = lines
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .find(Boolean);
  draftTitle.textContent = firstHeading || "Untitled draft";
}

function setTextareaHeight(textarea) {
  textarea.style.minHeight = `${Math.max(30, textarea.scrollHeight)}px`;
}

function activeLineClass(line, index) {
  const trimmed = line.trim();
  const codeState = lineIsCode(index);
  const classes = ["active-rich", "source-line"];

  if (codeState.fence) classes.push("active-fence");
  if (codeState.inCode && !codeState.fence) classes.push("active-code");

  const heading = trimmed.match(/^(#{1,3})\s+/);
  if (heading) classes.push("active-heading", `active-heading-${heading[1].length}`);
  if (trimmed.startsWith(">")) classes.push("active-quote");
  if (/^[-*]\s+\[( |x|X)\]\s+/.test(trimmed)) classes.push("active-task");
  if (/^[-*]\s+/.test(trimmed)) classes.push("active-list");
  if (/^\d+\.\s+/.test(trimmed)) classes.push("active-list");

  return classes.join(" ");
}

function getSelectionOffsets(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { start: element.textContent.length, end: element.textContent.length };
  }

  const range = selection.getRangeAt(0);
  const startRange = range.cloneRange();
  startRange.selectNodeContents(element);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = range.cloneRange();
  endRange.selectNodeContents(element);
  endRange.setEnd(range.endContainer, range.endOffset);

  return {
    start: startRange.toString().length,
    end: endRange.toString().length,
  };
}

function setCaretOffset(element, offset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();

  while (node) {
    if (remaining <= node.textContent.length) {
      const range = document.createRange();
      const selection = window.getSelection();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= node.textContent.length;
    node = walker.nextNode();
  }

  const range = document.createRange();
  const selection = window.getSelection();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusActiveLine() {
  const activeLine = editor.querySelector(".active-rich");
  if (!activeLine) return;
  activeLine.focus();
  setTextareaHeight(activeLine);
  const position = pendingCursor ?? activeLine.textContent.length;
  setCaretOffset(activeLine, position);
  pendingCursor = null;
}

function setActiveLine(index, cursor = null) {
  activeIndex = Math.max(0, Math.min(index, lines.length - 1));
  pendingCursor = cursor;
  render();
}

function captureState() {
  return {
    lines: [...lines],
    activeIndex,
    pendingCursor,
    selectionAnchor,
    selectionEnd,
  };
}

function restoreState(state) {
  lines = [...state.lines];
  activeIndex = state.activeIndex;
  pendingCursor = state.pendingCursor;
  selectionAnchor = state.selectionAnchor;
  selectionEnd = state.selectionEnd;
}

function pushUndo() {
  undoStack.push(captureState());
  redoStack = [];
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(captureState());
  restoreState(undoStack.pop());
  render();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(captureState());
  restoreState(redoStack.pop());
  render();
}

function flushPendingUndo() {
  if (pendingUndoTimeout) {
    clearTimeout(pendingUndoTimeout);
    pendingUndoTimeout = null;
    pushUndo();
  }
}

function scheduleUndoSnapshot() {
  clearTimeout(pendingUndoTimeout);
  pendingUndoTimeout = setTimeout(() => {
    pushUndo();
    pendingUndoTimeout = null;
  }, 700);
}

function clearSelection() {
  selectionAnchor = null;
  selectionEnd = null;
  render();
}

function getSelectedRange() {
  if (selectionAnchor === null || selectionEnd === null) return null;
  return {
    start: Math.min(selectionAnchor, selectionEnd),
    end: Math.max(selectionAnchor, selectionEnd),
  };
}

function deleteSelectedBlocks() {
  const range = getSelectedRange();
  if (!range) return;
  flushPendingUndo();
  pushUndo();
  lines.splice(range.start, range.end - range.start + 1);
  ensureLine();
  const newActive = Math.max(0, Math.min(range.start, lines.length - 1));
  selectionAnchor = null;
  selectionEnd = null;
  setActiveLine(newActive, lines[newActive].length);
}

function render() {
  ensureLine();
  editor.innerHTML = "";

  const range = getSelectedRange();
  const hasSelection = range !== null;

  lines.forEach((line, index) => {
    const block = document.createElement("div");
    const codeState = lineIsCode(index);
    const previousCodeState = index > 0 ? lineIsCode(index - 1) : { fence: false, inCode: false };
    const nextCodeState =
      index < lines.length - 1 ? lineIsCode(index + 1) : { fence: false, inCode: false };
    const isCodeLine = codeState.inCode && !codeState.fence;
    const startsCodeBlock =
      isCodeLine && (!previousCodeState.inCode || previousCodeState.fence);
    const endsCodeBlock = isCodeLine && (!nextCodeState.inCode || nextCodeState.fence);
    const isSelected = hasSelection && index >= range.start && index <= range.end;
    const classes = [
      "block",
      index === activeIndex && !hasSelection ? "is-active" : "",
      line.trim() ? "" : "is-empty",
      codeState.fence && index !== activeIndex ? "is-fence-hidden" : "",
      isCodeLine ? "is-code-line" : "",
      startsCodeBlock ? "code-start" : "",
      endsCodeBlock ? "code-end" : "",
      isSelected ? "is-selected" : "",
    ].filter(Boolean);

    block.className = classes.join(" ");
    block.dataset.index = String(index);

    if (index === activeIndex && !hasSelection) {
      const activeLine = document.createElement("div");
      activeLine.className = activeLineClass(line, index);
      activeLine.contentEditable = "true";
      activeLine.spellcheck = !codeState.inCode && !codeState.fence;
      activeLine.dataset.placeholder =
        index === 0 ? "Start with a title, a thought, or a fragment." : "";
      activeLine.innerHTML = renderActiveLine(line, index);
      block.append(activeLine);
    } else {
      const rendered = document.createElement("div");
      rendered.className = "block-render";
      rendered.innerHTML = renderLine(line, index);
      block.append(rendered);
    }

    editor.append(block);
  });

  updateTitle();
  updateMetrics();
  persist();
  if (!hasSelection) {
    focusActiveLine();
    requestAnimationFrame(focusActiveLine);
  }
}

function findWordBoundaries(text, position) {
  if (!text) return { start: 0, end: 0 };

  const pos = Math.max(0, Math.min(position, text.length));
  const wordChar = /[\p{L}\p{N}'-]/u;

  let start = pos;
  while (start > 0 && wordChar.test(text[start - 1])) {
    start -= 1;
  }

  let end = pos;
  while (end < text.length && wordChar.test(text[end])) {
    end += 1;
  }

  return { start, end };
}

function applyInlineMarker(marker) {
  const codeState = lineIsCode(activeIndex);
  if (codeState.fence || codeState.inCode) return;

  const activeLine = editor.querySelector(".active-rich");
  if (!activeLine) return;

  flushPendingUndo();
  pushUndo();

  let { start, end } = getSelectionOffsets(activeLine);

  if (start === end) {
    const bounds = findWordBoundaries(lines[activeIndex], start);
    start = bounds.start;
    end = bounds.end;
  }

  if (start >= end) return;

  const line = lines[activeIndex];
  const selected = line.slice(start, end);

  if (selected.startsWith(marker) && selected.endsWith(marker)) {
    replaceRangeOnActiveLine(start, end, selected.slice(marker.length, -marker.length));
    return;
  }

  const before = line.slice(start - marker.length, start);
  const after = line.slice(end, end + marker.length);
  if (before === marker && after === marker) {
    replaceRangeOnActiveLine(start - marker.length, end + marker.length, selected);
    return;
  }

  replaceRangeOnActiveLine(start, end, `${marker}${selected}${marker}`);
}

function replaceRangeOnActiveLine(start, end, text) {
  const index = activeIndex;
  const before = lines[index].slice(0, start);
  const after = lines[index].slice(end);
  const pasted = text.replace(/\r\n/g, "\n").split("\n");

  if (pasted.length === 1) {
    lines[index] = `${before}${pasted[0]}${after}`;
    pendingCursor = before.length + pasted[0].length;
    render();
    return;
  }

  const replacement = [
    `${before}${pasted[0]}`,
    ...pasted.slice(1, -1),
    `${pasted[pasted.length - 1]}${after}`,
  ];
  lines.splice(index, 1, ...replacement);
  setActiveLine(index + replacement.length - 1, pasted[pasted.length - 1].length);
}

function handleSelectionMouseMove(event) {
  if (dragStartIndex === null) return;
  const block = event.target.closest(".block");
  if (!block) return;
  const index = Number(block.dataset.index);
  if (index !== selectionEnd) {
    selectionEnd = index;
    render();
  }
}

function handleSelectionMouseUp(event) {
  if (dragStartIndex === null) return;

  if (selectionAnchor === selectionEnd) {
    const block = event.target.closest(".block");
    clearSelection();
    if (block) {
      setActiveLine(Number(block.dataset.index));
    }
  }

  dragStartIndex = null;
  document.removeEventListener("mousemove", handleSelectionMouseMove);
  document.removeEventListener("mouseup", handleSelectionMouseUp);
}

editor.addEventListener("mousedown", (event) => {
  const block = event.target.closest(".block");
  if (!block) return;
  const index = Number(block.dataset.index);

  if (event.shiftKey) {
    event.preventDefault();
    if (selectionAnchor === null) selectionAnchor = activeIndex;
    selectionEnd = index;
    render();
    return;
  }

  if (event.target.closest(".active-rich")) return;

  dragStartIndex = index;
  selectionAnchor = index;
  selectionEnd = index;
  document.addEventListener("mousemove", handleSelectionMouseMove);
  document.addEventListener("mouseup", handleSelectionMouseUp);
  render();
});

editor.addEventListener("focus", () => {
  if (selectionAnchor !== null) return;
  if (!editor.querySelector(".active-rich")) setActiveLine(lines.length - 1);
});

editor.addEventListener("input", (event) => {
  if (!event.target.matches(".active-rich")) return;
  const activeLine = event.target;
  lines[activeIndex] = activeLine.textContent.replace(/\n/g, "");
  setTextareaHeight(activeLine);
  updateTitle();
  updateMetrics();
  persist();
  scheduleUndoSnapshot();
});

editor.addEventListener("paste", (event) => {
  const activeLine = event.target.closest(".active-rich");
  if (!activeLine) return;
  const text = event.clipboardData.getData("text");
  event.preventDefault();
  const selection = getSelectionOffsets(activeLine);
  flushPendingUndo();
  pushUndo();
  replaceRangeOnActiveLine(selection.start, selection.end, text);
});

editor.addEventListener("keydown", (event) => {
  const activeLine = event.target.closest(".active-rich");
  const hasSelection = selectionAnchor !== null && selectionEnd !== null;
  const isMeta = event.metaKey || event.ctrlKey;

  if (isMeta && event.key === "z" && !event.shiftKey) {
    if (undoStack.length > 0) {
      event.preventDefault();
      undo();
      return;
    }
  }

  if (isMeta && ((event.key === "z" && event.shiftKey) || event.key === "y")) {
    if (redoStack.length > 0) {
      event.preventDefault();
      redo();
      return;
    }
  }

  if (activeLine && event.shiftKey && isMeta && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    if (selectionAnchor === null) selectionAnchor = activeIndex;
    selectionEnd = event.key === "ArrowUp" ? 0 : lines.length - 1;
    render();
    return;
  }

  if (activeLine && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    if (selectionAnchor === null) selectionAnchor = activeIndex;
    selectionEnd = activeIndex;
    if (event.key === "ArrowUp") {
      selectionEnd = Math.max(0, selectionEnd - 1);
    } else {
      selectionEnd = Math.min(lines.length - 1, selectionEnd + 1);
    }
    render();
    return;
  }

  if (!activeLine) return;

  const index = activeIndex;
  lines[index] = activeLine.textContent.replace(/\n/g, "");
  const { start, end } = getSelectionOffsets(activeLine);

  if ((event.metaKey || event.ctrlKey) && (event.key === "b" || event.key === "B")) {
    event.preventDefault();
    applyInlineMarker("**");
    return;
  }

  if ((event.metaKey || event.ctrlKey) && (event.key === "i" || event.key === "I")) {
    event.preventDefault();
    applyInlineMarker("*");
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    flushPendingUndo();
    pushUndo();
    const before = lines[index].slice(0, start);
    const after = lines[index].slice(end);
    lines[index] = before;
    lines.splice(index + 1, 0, after);
    setActiveLine(index + 1, 0);
    return;
  }

  if (event.key === "Backspace" && start === 0 && end === 0 && index > 0) {
    event.preventDefault();
    flushPendingUndo();
    pushUndo();
    const previousLength = lines[index - 1].length;
    lines[index - 1] += lines[index];
    lines.splice(index, 1);
    setActiveLine(index - 1, previousLength);
    return;
  }

  if (event.key === "Delete" && start === lines[index].length && end === start && index < lines.length - 1) {
    event.preventDefault();
    flushPendingUndo();
    pushUndo();
    lines[index] += lines[index + 1];
    lines.splice(index + 1, 1);
    setActiveLine(index, start);
    return;
  }

  if (event.key === "ArrowUp" && index > 0) {
    event.preventDefault();
    setActiveLine(index - 1);
    return;
  }

  if (event.key === "ArrowDown" && index < lines.length - 1) {
    event.preventDefault();
    setActiveLine(index + 1);
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    flushPendingUndo();
    pushUndo();
    const insertion = "  ";
    lines[index] = `${lines[index].slice(0, start)}${insertion}${lines[index].slice(end)}`;
    setActiveLine(index, start + insertion.length);
  }
});

clearDraft.addEventListener("click", () => {
  flushPendingUndo();
  pushUndo();
  lines = [""];
  selectionAnchor = null;
  selectionEnd = null;
  setActiveLine(0, 0);
});

document.addEventListener(
  "mousedown",
  (event) => {
    if (!editor.contains(event.target)) {
      clearSelection();
    }
  },
  true,
);

document.addEventListener("keydown", (event) => {
  const hasSelection = selectionAnchor !== null && selectionEnd !== null;
  const isMeta = event.metaKey || event.ctrlKey;

  if (isMeta && event.key === "z" && !event.shiftKey) {
    if (undoStack.length > 0) {
      event.preventDefault();
      undo();
      return;
    }
  }

  if (isMeta && ((event.key === "z" && event.shiftKey) || event.key === "y")) {
    if (redoStack.length > 0) {
      event.preventDefault();
      redo();
      return;
    }
  }

  if (!hasSelection) return;

  if (event.key === "Escape") {
    event.preventDefault();
    const target = selectionAnchor;
    clearSelection();
    setActiveLine(target);
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    deleteSelectedBlocks();
    return;
  }

  if (event.shiftKey && isMeta && event.key === "ArrowUp") {
    event.preventDefault();
    selectionEnd = 0;
    render();
    return;
  }

  if (event.shiftKey && isMeta && event.key === "ArrowDown") {
    event.preventDefault();
    selectionEnd = lines.length - 1;
    render();
    return;
  }

  if (event.shiftKey && event.key === "ArrowUp") {
    event.preventDefault();
    selectionEnd = Math.max(0, selectionEnd - 1);
    render();
    return;
  }

  if (event.shiftKey && event.key === "ArrowDown") {
    event.preventDefault();
    selectionEnd = Math.min(lines.length - 1, selectionEnd + 1);
    render();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    const target = Math.min(selectionAnchor, selectionEnd);
    clearSelection();
    setActiveLine(target);
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const target = Math.max(selectionAnchor, selectionEnd);
    clearSelection();
    setActiveLine(target);
    return;
  }

  if (isMeta && (event.key === "a" || event.key === "A")) {
    if (document.activeElement?.matches(".active-rich")) return;
    event.preventDefault();
    selectionAnchor = 0;
    selectionEnd = lines.length - 1;
    render();
  }
});

render();

"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";
import { LINES_PER_CARD } from "@/lib/studio/snippets";

const CodeEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-sm text-[#858585]">Loading editor…</div>
  ),
});

type EditorInstance = Parameters<OnMount>[0];
type FileKey = "html" | "css" | "js";
type Files = Record<FileKey, string>;
type Tone = "info" | "success" | "error";

interface LogEntry {
  id: string;
  time: string;
  text: string;
  tone: Tone;
}

interface ProjectSummary {
  id: number;
  name: string;
  prompt: string;
  updatedAt: string;
}

const FILES: Record<FileKey, { name: string; language: string; label: string }> = {
  html: { name: "index.html", language: "html", label: "HTML" },
  css: { name: "styles.css", language: "css", label: "CSS" },
  js: { name: "script.js", language: "javascript", label: "JavaScript" },
};

const FILE_KEYS: FileKey[] = ["html", "css", "js"];

const STARTER: Files = {
  html:
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title>My page</title>\n' +
    '  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <h1>Hello, Code Studio!</h1>\n' +
    "  <p>Describe a website in the AI panel, or start typing here.</p>\n" +
    '  <script src="script.js"></script>\n</body>\n</html>\n',
  css: "body {\n  font-family: system-ui, sans-serif;\n  margin: 40px;\n}\n",
  js: 'console.log("Hello from script.js");\n',
};

const DEFAULT_PROMPT = "Modern website for my coffee shop called Sunrise Coffee, warm orange colours";

function clamp(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function linesOf(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function joinLines(lines: string[]): string {
  return lines.length ? lines.join("\n") + "\n" : "";
}

function countLines(text: string): number {
  return linesOf(text).length;
}

/**
 * Removes about `count` lines beginning at line index `start`, extending to the next blank line
 * so whole code blocks are removed. This keeps the remaining JavaScript and CSS valid, which is
 * what lets the preview stay wired together while the writer deletes.
 */
function removeLines(text: string, start: number, count: number): string {
  const lines = linesOf(text);
  const from = Math.min(Math.max(0, start), lines.length);
  let to = Math.min(lines.length, from + Math.max(0, count));
  while (to < lines.length && lines[to - 1] !== "") to++;
  lines.splice(from, to - from);
  return joinLines(lines);
}

/** Keeps only the newest `maxLines` lines, snapping the cut to a block boundary. */
function trimTop(text: string, maxLines: number): string {
  const lines = linesOf(text);
  if (lines.length <= maxLines) return text;
  let start = lines.length - maxLines;
  while (start < lines.length && lines[start - 1] !== "") start++;
  return joinLines(lines.slice(start));
}

type Op = { type: "reset"; key: FileKey } | { type: "append"; key: FileKey; line: string };

function applyOps(prev: Files, ops: Op[]): Files {
  const next: Files = { ...prev };
  for (const op of ops) {
    if (op.type === "reset") {
      next[op.key] = "";
      continue;
    }
    const current = next[op.key];
    const base = current === "" || current.endsWith("\n") ? current : current + "\n";
    next[op.key] = base + op.line + "\n";
  }
  return next;
}

/**
 * Wires the three files into one document for the preview: styles.css is inlined where
 * <link href="styles.css"> would be (or into <head>), and script.js is inlined where
 * <script src="script.js"> would be (or at the end of <body>) so it runs after the HTML exists.
 * HTML fragments without <html>/<body> are wrapped in a minimal document.
 */
function buildPreview(files: Files): string {
  const styleTag = `<style>\n${files.css}\n</style>`;
  const scriptTag = `<script>\n${files.js.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  const linkRe = /<link[^>]*href=["']\.?\/?styles\.css["'][^>]*>/i;
  const scriptRe = /<script[^>]*src=["']\.?\/?script\.js["'][^>]*>\s*<\/script>/i;

  let html = files.html;
  const isFragment = !/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html);
  if (isFragment) {
    html =
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
      `<link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n${html}\n` +
      `<script src="script.js"></script>\n</body>\n</html>`;
  }

  if (linkRe.test(html)) {
    html = html.replace(linkRe, () => styleTag);
  } else if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, () => `${styleTag}\n</head>`);
  } else {
    html = styleTag + html;
  }

  if (scriptRe.test(html)) {
    html = html.replace(scriptRe, () => scriptTag);
  } else if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, () => `${scriptTag}\n</body>`);
  } else {
    html = html + scriptTag;
  }
  return html;
}

/** Reads a streamed text response and hands over complete lines as they arrive. */
async function readLines(res: Response, onLines: (lines: string[]) => void): Promise<void> {
  if (!res.body) throw new Error("Empty response from generator");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    if (parts.length) onLines(parts);
  }
  pending += decoder.decode();
  if (pending) onLines([pending]);
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-[#9d9d9d]">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded bg-[#1e1e1e] px-2 py-1 text-sm text-[#cccccc] ring-1 ring-[#3c3c3c] outline-none focus:ring-[#007acc] disabled:opacity-50"
      />
    </label>
  );
}

export default function StudioClient() {
  const [files, setFiles] = useState<Files>(STARTER);
  const filesRef = useRef(files);
  const [active, setActive] = useState<FileKey>("html");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState("Untitled project");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState<null | "website" | "writer">(null);
  const [phase, setPhase] = useState("Idle");
  const [writerLang, setWriterLang] = useState<FileKey | "all">("all");
  const [showPanel, setShowPanel] = useState(true);
  const [burst, setBurst] = useState(200);
  const [deletePercent, setDeletePercent] = useState(50);
  const [maxLines, setMaxLines] = useState(1200);
  const [speed, setSpeed] = useState(12);
  const [stats, setStats] = useState({ cycles: 0, written: 0, deleted: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showPreview, setShowPreview] = useState(true);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showOutput, setShowOutput] = useState(true);
  const [previewMax, setPreviewMax] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState("");
  const [savedAt, setSavedAt] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  // One block counter per language so HTML card N, CSS rule N and JS script N line up.
  const seqRef = useRef<Record<FileKey, number>>({ html: 1, css: 1, js: 1 });
  const previewUrlRef = useRef<string | null>(null);
  const editorRef = useRef<EditorInstance | null>(null);
  const logLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const pushLog = useCallback((text: string, tone: Tone = "info") => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toLocaleTimeString(),
      text,
      tone,
    };
    setLog((prev) => [...prev.slice(-199), entry]);
  }, []);

  useEffect(() => {
    const el = logLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setPreviewDoc(buildPreview(files)),
      busy ? 600 : 120,
    );
    return () => window.clearTimeout(timer);
  }, [files, busy]);

  // While the writer is running, keep the newest line visible in the editor.
  useEffect(() => {
    if (busy !== "writer" || !editorRef.current) return;
    const editor = editorRef.current;
    const count = editor.getModel()?.getLineCount();
    if (count) editor.revealLine(count);
  }, [files, busy]);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      const json = (await res.json()) as { projects?: ProjectSummary[] };
      setProjects(json.projects ?? []);
      return json.projects ?? [];
    } catch {
      return [];
    }
  }, []);

  const openProject = useCallback(
    async (id: number) => {
      const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
      const json = (await res.json()) as {
        project?: { id: number; name: string; prompt: string; html: string; css: string; js: string };
        error?: string;
      };
      if (!res.ok || !json.project) {
        pushLog(json.error ?? "Could not open project.", "error");
        return;
      }
      const p = json.project;
      setFiles({ html: p.html, css: p.css, js: p.js });
      setProjectId(p.id);
      setProjectName(p.name);
      setPrompt(p.prompt || DEFAULT_PROMPT);
      setActive("html");
      pushLog(`Opened "${p.name}".`, "success");
    },
    [pushLog],
  );

  // Load the most recent project on first visit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await refreshProjects();
      if (!cancelled && list.length > 0) await openProject(list[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProjects, openProject]);

  const saveProject = useCallback(async () => {
    const current = filesRef.current;
    const payload = {
      name: projectName.trim() || "Untitled project",
      prompt,
      html: current.html,
      css: current.css,
      js: current.js,
    };
    try {
      const res = await fetch(projectId ? `/api/projects/${projectId}` : "/api/projects", {
        method: projectId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { project?: { id: number }; error?: string };
      if (!res.ok || !json.project) {
        pushLog(json.error ?? "Save failed.", "error");
        return;
      }
      setProjectId(json.project.id);
      setSavedAt(new Date().toLocaleTimeString());
      pushLog(`Saved "${payload.name}".`, "success");
      void refreshProjects();
    } catch {
      pushLog("Save failed: network error.", "error");
    }
  }, [projectId, projectName, prompt, pushLog, refreshProjects]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveProject]);

  const newProject = () => {
    if (busy) return;
    setFiles(STARTER);
    setProjectId(null);
    setProjectName("Untitled project");
    setPrompt(DEFAULT_PROMPT);
    setActive("html");
    setStats({ cycles: 0, written: 0, deleted: 0 });
    seqRef.current = { html: 1, css: 1, js: 1 };
    setSavedAt("");
    pushLog("Started a new project.");
  };

  const deleteProject = async () => {
    if (!projectId || busy) return;
    await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    pushLog("Project deleted.", "info");
    newProject();
    void refreshProjects();
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /** Puts the whole studio in browser full-screen mode (Esc or the button leaves it). */
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      pushLog("Full screen is not available in this browser.", "error");
    }
  };

  /** Opens the wired preview (HTML + CSS + JS) in its own browser tab. */
  const openPreviewTab = () => {
    const blob = new Blob([buildPreview(filesRef.current)], { type: "text/html" });
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    window.open(url, "_blank", "noopener");
  };

  /** Website mode: the generator streams index.html, styles.css and script.js. */
  const buildWebsite = async () => {
    const text = prompt.trim();
    if (busy) return;
    if (!text) {
      pushLog("Describe the website you want first.", "error");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("website");
    setPhase("Designing website…");
    pushLog(`Building website from prompt: "${text.slice(0, 80)}"`);

    const markerMap: Record<string, FileKey> = {
      "index.html": "html",
      "styles.css": "css",
      "script.js": "js",
    };

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "website", prompt: text, delayMs: 4 }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Generator returned ${res.status}`);

      let current: FileKey | null = null;
      await readLines(res, (lines) => {
        const ops: Op[] = [];
        for (const line of lines) {
          if (line.startsWith("@@FILE:")) {
            current = markerMap[line.slice(7).trim()] ?? null;
            if (current) ops.push({ type: "reset", key: current });
          } else if (current) {
            ops.push({ type: "append", key: current, line });
          }
        }
        if (ops.length) setFiles((prev) => applyOps(prev, ops));
      });

      setActive("html");
      seqRef.current = { html: 1, css: 1, js: 1 };
      pushLog("Website ready: index.html, styles.css and script.js. Press Save to keep it.", "success");
    } catch (err) {
      if (controller.signal.aborted) {
        pushLog("Website generation stopped.");
      } else {
        pushLog(`Error: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
      setPhase("Idle");
    }
  };

  /** Streams one snippet burst into `key`, returning how many lines and blocks were written. */
  const writeBurst = async (
    key: FileKey,
    request: { count?: number; blocks?: number },
    topic: string,
    delay: number,
    signal: AbortSignal,
  ): Promise<{ lines: number; blocks: number }> => {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "snippet",
        language: key,
        ...request,
        seq: seqRef.current[key],
        delayMs: delay,
        prompt: topic,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Generator returned ${res.status}`);
    const blocks = Number(res.headers.get("X-Blocks")) || 0;
    let lines = 0;
    await readLines(res, (chunk) => {
      lines += chunk.length;
      setFiles((prev) => applyOps(prev, chunk.map((line) => ({ type: "append" as const, key, line }))));
    });
    seqRef.current[key] += blocks;
    return { lines, blocks };
  };

  /**
   * Non-stop writer: writes a burst, deletes part of that burst, then continues until Stop.
   * - Single language: bursts are measured in lines.
   * - All three: each cycle writes the same N cards to HTML, CSS and JS (section, rule, script),
   *   then removes the same cards from all three, so the preview stays styled and interactive.
   */
  const startWriter = async () => {
    if (busy) return;
    const allMode = writerLang === "all";
    const rotation: FileKey[] = allMode ? FILE_KEYS : [writerLang];
    const size = clamp(burst, 10, 1000);
    const ratio = clamp(deletePercent, 0, 100) / 100;
    const limit = clamp(maxLines, 50, 20000);
    const delay = clamp(speed, 0, 500);
    const topic = prompt.trim() || "app";
    const cardsPerCycle = Math.max(1, Math.round(size / LINES_PER_CARD));

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("writer");
    setActive(rotation[0]);
    setStats({ cycles: 0, written: 0, deleted: 0 });

    if (allMode) {
      // Start from a clean, linked page so the generated cards, their styles and scripts
      // are the only thing in the preview.
      seqRef.current = { html: 1, css: 1, js: 1 };
      const title = topic.charAt(0).toUpperCase() + topic.slice(1);
      setFiles({
        html:
          '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n' +
          '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
          `  <title>${title}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n` +
          `  <h1>${title}</h1>\n\n`,
        css:
          "body {\n  margin: 0;\n  padding: 24px;\n  background: #f4f6fb;\n  font-family: system-ui, sans-serif;\n}\n" +
          "h1 {\n  text-align: center;\n  color: #1f2937;\n}\n\n",
        js: "// Each script below finds its card in index.html and fills in a value.\n\n",
      });
      await sleep(50);
      pushLog(
        `Non-stop writer started: ${cardsPerCycle} cards per cycle (≈${cardsPerCycle * LINES_PER_CARD} lines across HTML, CSS and JS) → delete ${Math.round(ratio * 100)}% → repeat.`,
        "success",
      );
    } else {
      pushLog(
        `Non-stop writer started: ${size} lines → delete ${Math.round(ratio * 100)}% → repeat in ${FILES[rotation[0]].name}.`,
        "success",
      );
    }

    let cycles = 0;
    let written = 0;
    let deleted = 0;

    try {
      while (!controller.signal.aborted) {
        cycles++;

        if (allMode) {
          const startAt: Record<FileKey, number> = { html: 0, css: 0, js: 0 };
          const wrote: Record<FileKey, number> = { html: 0, css: 0, js: 0 };
          for (const key of rotation) {
            if (controller.signal.aborted) break;
            setActive(key);
            setPhase(`Cycle ${cycles}: writing ${cardsPerCycle} cards of ${FILES[key].label}`);
            startAt[key] = countLines(filesRef.current[key]);
            const result = await writeBurst(key, { blocks: cardsPerCycle }, topic, delay, controller.signal);
            wrote[key] = result.lines;
            written += result.lines;
          }
          if (controller.signal.aborted) break;

          const removeCards = Math.floor(cardsPerCycle * ratio);
          setPhase(`Cycle ${cycles}: deleting ${removeCards} cards from all three files`);
          await sleep(350, controller.signal);
          if (controller.signal.aborted) break;

          setFiles((prev) => {
            const next: Files = { ...prev };
            for (const key of rotation) {
              const perCard = wrote[key] / cardsPerCycle;
              const count = Math.round(perCard * removeCards);
              next[key] = trimTop(removeLines(next[key], startAt[key], count), limit);
            }
            return next;
          });
          deleted += Math.round(removeCards * LINES_PER_CARD);
          setStats({ cycles, written, deleted });
          pushLog(
            `Cycle ${cycles}: wrote ${cardsPerCycle} cards (${wrote.html} html, ${wrote.css} css, ${wrote.js} js lines), deleted ${removeCards} cards.`,
          );
          await sleep(350, controller.signal);
          continue;
        }

        const key = rotation[0];
        const startAt = countLines(filesRef.current[key]);
        setPhase(`Cycle ${cycles}: writing ${size} lines of ${FILES[key].label}`);
        const result = await writeBurst(key, { count: size }, topic, delay, controller.signal);
        written += result.lines;

        const removeCount = Math.floor(result.lines * ratio);
        setPhase(`Cycle ${cycles}: deleting ${removeCount} lines`);
        await sleep(350, controller.signal);
        if (controller.signal.aborted) break;

        setFiles((prev) => ({
          ...prev,
          [key]: trimTop(removeLines(prev[key], startAt, removeCount), limit),
        }));
        deleted += removeCount;
        setStats({ cycles, written, deleted });
        pushLog(`Cycle ${cycles} (${FILES[key].name}): wrote ${result.lines} lines, deleted ${removeCount}.`);
        await sleep(350, controller.signal);
      }
      pushLog("Non-stop writer stopped.");
    } catch (err) {
      if (controller.signal.aborted) {
        pushLog("Non-stop writer stopped.");
      } else {
        pushLog(`Writer error: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
      setPhase("Idle");
    }
  };

  const currentText = files[active];
  const meta = FILES[active];
  const totalLines = countLines(currentText);

  const toolbarBtn =
    "rounded px-2 py-1 text-[#cccccc] hover:bg-[#505050] disabled:opacity-50 disabled:hover:bg-transparent";
  const iconBtn = "rounded px-1.5 py-0.5 text-sm text-[#bbbbbb] hover:bg-[#3c3c3c] hover:text-white";

  const activityItem = (
    label: string,
    icon: string,
    on: boolean,
    onClick: () => void,
    extra?: ReactNode,
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={`relative flex h-12 w-12 items-center justify-center text-2xl ${
        on ? "border-l-2 border-white text-white" : "text-[#858585] hover:text-white"
      }`}
    >
      {icon}
      {extra}
    </button>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      {/* Title bar */}
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-[#2b2b2b] bg-[#3c3c3c] px-2 text-[13px]">
        <Link href="/" className="mr-1 px-1 font-semibold text-white hover:text-[#4fc1ff]">
          ◆ Code Studio
        </Link>
        <button type="button" onClick={newProject} disabled={!!busy} className={toolbarBtn}>
          New
        </button>
        <button type="button" onClick={() => void saveProject()} className={toolbarBtn}>
          Save
        </button>
        <button type="button" onClick={openPreviewTab} className={toolbarBtn} title="Open the wired preview in a new browser tab">
          Open in browser
        </button>
        <Link href="/sheet" className={toolbarBtn}>
          Spreadsheet
        </Link>

        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          disabled={!!busy}
          aria-label="Project name"
          className="mx-auto w-[min(40%,420px)] rounded bg-[#2a2a2a] px-3 py-0.5 text-center text-xs text-[#cccccc] ring-1 ring-[#505050] outline-none focus:ring-[#007acc] disabled:opacity-60"
        />

        <span className="mr-2 text-[11px] text-[#b5b5b5]">{savedAt ? `Saved ${savedAt}` : "Ctrl+S saves"}</span>
        <button type="button" onClick={() => setShowOutput((v) => !v)} className={toolbarBtn} title="Toggle output panel">
          ▭ Output
        </button>
        <button type="button" onClick={() => setShowPreview((v) => !v)} className={toolbarBtn} title="Toggle live preview">
          ◫ Preview
        </button>
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className={`${toolbarBtn} font-medium text-white`}
          title={isFullscreen ? "Exit full screen (Esc)" : "Full screen"}
        >
          {isFullscreen ? "🡼 Exit full screen" : "⛶ Full screen"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Activity bar */}
        <nav className="flex w-12 shrink-0 flex-col items-center border-r border-[#2b2b2b] bg-[#333333]">
          {activityItem("Explorer", "🗎", showExplorer, () => setShowExplorer((v) => !v))}
          {activityItem(
            "AI assistant",
            "✦",
            showPanel,
            () => setShowPanel((v) => !v),
            busy ? <span className="absolute right-2 top-2 h-2 w-2 animate-pulse rounded-full bg-[#89d185]" /> : null,
          )}
          {activityItem("Live preview", "▶", showPreview, () => setShowPreview((v) => !v))}
          {activityItem("Output", "☰", showOutput, () => setShowOutput((v) => !v))}
          <div className="mt-auto">
            {activityItem(isFullscreen ? "Exit full screen" : "Full screen", "⛶", isFullscreen, () => void toggleFullscreen())}
          </div>
        </nav>

        {/* Explorer sidebar */}
        {showExplorer && (
          <aside className="flex w-56 shrink-0 flex-col border-r border-[#2b2b2b] bg-[#252526]">
            <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wider text-[#bbbbbb]">
              <span>EXPLORER</span>
              <button type="button" onClick={() => setShowExplorer(false)} className={iconBtn} title="Hide explorer">
                ◀
              </button>
            </div>
            <div className="px-3 pb-1 text-[11px] font-semibold text-[#cccccc]">▾ {projectName.toUpperCase()}</div>
            <ul className="px-1">
              {FILE_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => setActive(key)}
                    className={`flex w-full items-center justify-between rounded px-3 py-1 pl-6 text-left text-[13px] ${
                      active === key ? "bg-[#37373d] text-white" : "hover:bg-[#2a2d2e]"
                    }`}
                  >
                    <span>{FILES[key].name}</span>
                    <span className="text-[10px] text-[#858585]">{countLines(files[key])}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center justify-between px-3 pb-1 text-[11px] font-semibold tracking-wider text-[#bbbbbb]">
              <span>▾ SAVED PROJECTS</span>
              {projectId && (
                <button
                  type="button"
                  onClick={() => void deleteProject()}
                  disabled={!!busy}
                  className="text-[10px] font-normal text-[#f48771] hover:underline disabled:opacity-50"
                >
                  delete
                </button>
              )}
            </div>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1 pb-3">
              {projects.length === 0 && <li className="px-3 py-1 text-xs text-[#858585]">No saved projects yet.</li>}
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void openProject(p.id)}
                    disabled={!!busy}
                    className={`w-full rounded px-3 py-1 text-left text-[13px] disabled:opacity-60 ${
                      projectId === p.id ? "bg-[#37373d] text-white" : "hover:bg-[#2a2d2e]"
                    }`}
                  >
                    <div className="truncate">{p.name}</div>
                    <div className="text-[10px] text-[#858585]">{new Date(p.updatedAt).toLocaleString()}</div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        {/* Editor group + preview + output */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {!(showPreview && previewMax) && (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-9 shrink-0 items-end bg-[#252526]">
                  {FILE_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActive(key)}
                      className={`h-9 border-r border-[#2b2b2b] px-4 text-[13px] ${
                        active === key
                          ? "border-t border-t-[#007acc] bg-[#1e1e1e] text-white"
                          : "bg-[#2d2d2d] text-[#969696] hover:text-white"
                      }`}
                    >
                      {FILES[key].name}
                    </button>
                  ))}
                  <div className="ml-auto flex h-9 items-center gap-1 px-2 text-[11px] text-[#858585]">
                    {busy === "writer" && <span className="text-[#89d185]">● writing</span>}
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <CodeEditor
                    height="100%"
                    path={meta.name}
                    language={meta.language}
                    theme="vs-dark"
                    value={currentText}
                    onChange={(value) => {
                      if (busy) return;
                      setFiles((prev) => ({ ...prev, [active]: value ?? "" }));
                    }}
                    onMount={(editor) => {
                      editorRef.current = editor;
                    }}
                    options={{
                      minimap: { enabled: true },
                      fontSize: 13,
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      smoothScrolling: true,
                      tabSize: 2,
                      readOnly: busy === "writer",
                    }}
                  />
                </div>
              </div>
            )}

            {showPreview ? (
              <div className={`flex min-w-0 flex-col border-l border-[#3c3c3c] ${previewMax ? "flex-1" : "w-[44%]"}`}>
                <div className="flex h-9 shrink-0 items-center gap-1 bg-[#252526] px-2 text-[11px] text-[#bbbbbb]">
                  <button type="button" onClick={() => setShowPreview(false)} className={iconBtn} title="Minimize preview">
                    ▶
                  </button>
                  <span className="font-semibold tracking-wider">LIVE PREVIEW</span>
                  <span className="ml-2 text-[#858585]">{busy ? "updating…" : "html + css + js wired"}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={openPreviewTab} className={iconBtn} title="Open in a new browser tab">
                      ↗
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewMax((v) => !v)}
                      className={iconBtn}
                      title={previewMax ? "Restore editor" : "Maximize preview"}
                    >
                      {previewMax ? "🗗" : "🗖"}
                    </button>
                  </div>
                </div>
                <iframe
                  title="Live preview"
                  srcDoc={previewDoc}
                  sandbox="allow-scripts allow-forms allow-modals"
                  className="min-h-0 flex-1 bg-white"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                className="flex w-7 shrink-0 flex-col items-center gap-2 border-l border-[#3c3c3c] bg-[#252526] pt-2 text-[11px] text-[#bbbbbb] hover:bg-[#2d2d2d] hover:text-white"
                title="Show preview"
              >
                <span className="text-sm">◀</span>
                <span className="[writing-mode:vertical-rl] tracking-wider">PREVIEW</span>
              </button>
            )}
          </div>

          {/* Bottom panel (OUTPUT), like the VS Code terminal/output area */}
          {showOutput && (
            <div className="flex h-40 shrink-0 flex-col border-t border-[#3c3c3c] bg-[#1e1e1e]">
              <div className="flex h-8 shrink-0 items-center gap-4 px-3 text-[11px] font-semibold tracking-wider text-[#bbbbbb]">
                <span className="border-b border-[#e7e7e7] pb-1 text-white">OUTPUT</span>
                <span className="text-[#858585]">{phase}</span>
                <div className="ml-auto flex items-center gap-2 font-normal">
                  <span>cycles {stats.cycles}</span>
                  <span className="text-[#89d185]">+{stats.written}</span>
                  <span className="text-[#f48771]">−{stats.deleted}</span>
                  <button type="button" onClick={() => setLog([])} className={iconBtn} title="Clear output">
                    ⌫
                  </button>
                  <button type="button" onClick={() => setShowOutput(false)} className={iconBtn} title="Hide output">
                    ✕
                  </button>
                </div>
              </div>
              <div ref={logLogRef} className="min-h-0 flex-1 space-y-0.5 overflow-auto px-3 pb-2 font-mono text-[11px]">
                {log.length === 0 && <div className="text-[#858585]">Nothing yet. Build a website or start the writer.</div>}
                {log.map((entry) => (
                  <div
                    key={entry.id}
                    className={
                      entry.tone === "success" ? "text-[#89d185]" : entry.tone === "error" ? "text-[#f48771]" : "text-[#cccccc]"
                    }
                  >
                    <span className="text-[#858585]">[{entry.time}]</span> {entry.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* AI assistant side panel (collapsible) */}
        {!showPanel && (
          <button
            type="button"
            onClick={() => setShowPanel(true)}
            className="flex w-7 shrink-0 flex-col items-center gap-2 border-l border-[#2b2b2b] bg-[#252526] pt-2 text-[11px] text-[#bbbbbb] hover:bg-[#2d2d2d] hover:text-white"
            title="Open AI assistant panel"
          >
            <span className="text-sm">◀</span>
            <span className="[writing-mode:vertical-rl] tracking-wider">AI ASSISTANT</span>
            {busy && <span className="mt-1 h-2 w-2 animate-pulse rounded-full bg-[#89d185]" title={phase} />}
          </button>
        )}

        <aside className={`flex w-[320px] shrink-0 flex-col border-l border-[#2b2b2b] bg-[#252526] ${showPanel ? "" : "hidden"}`}>
          <div className="flex items-center gap-2 px-3 pb-1 pt-2">
            <div className="text-[11px] font-semibold tracking-wider text-[#bbbbbb]">AI ASSISTANT</div>
            <button type="button" onClick={() => setShowPanel(false)} className={`${iconBtn} ml-auto`} title="Minimize panel">
              ▶
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <div className="space-y-2 px-3 pb-3">
              <p className="text-xs text-[#858585]">Describe a website, or let the writer produce code without stopping.</p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={!!busy}
                rows={4}
                placeholder="e.g. A dark portfolio website for a photographer called Lens & Light"
                className="w-full resize-none rounded bg-[#1e1e1e] px-3 py-2 text-sm text-[#cccccc] ring-1 ring-[#3c3c3c] outline-none focus:ring-[#007acc] disabled:opacity-60"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void buildWebsite()}
                  disabled={!!busy}
                  className="flex-1 rounded bg-[#0e639c] px-3 py-2 text-sm font-medium text-white hover:bg-[#1177bb] disabled:opacity-50"
                >
                  ✨ Build attractive website
                </button>
                {busy === "website" && (
                  <button type="button" onClick={stop} className="rounded bg-[#a1260d] px-3 py-2 text-sm text-white">
                    Stop
                  </button>
                )}
              </div>
            </div>

            <div className="border-t border-[#3c3c3c] px-3 pt-3">
              <div className="mb-2 text-[11px] font-semibold tracking-wider text-[#bbbbbb]">NON-STOP WRITER</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 flex flex-col gap-1 text-[11px] text-[#9d9d9d]">
                  Language
                  <select
                    value={writerLang}
                    onChange={(e) => setWriterLang(e.target.value as FileKey | "all")}
                    disabled={!!busy}
                    className="rounded bg-[#1e1e1e] px-2 py-1 text-sm text-[#cccccc] ring-1 ring-[#3c3c3c] outline-none disabled:opacity-50"
                  >
                    <option value="all">All three, wired together (HTML + CSS + JS)</option>
                    {FILE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {FILES[key].label} only
                      </option>
                    ))}
                  </select>
                </label>
                <NumField label="Lines per burst" value={burst} onChange={setBurst} min={10} max={1000} disabled={!!busy} />
                <NumField label="Delete %" value={deletePercent} onChange={setDeletePercent} min={0} max={100} disabled={!!busy} />
                <NumField label="Max file lines" value={maxLines} onChange={setMaxLines} min={50} max={20000} disabled={!!busy} />
                <NumField label="Speed (ms/line)" value={speed} onChange={setSpeed} min={0} max={500} disabled={!!busy} />
              </div>

              <div className="mt-3">
                {busy === "writer" ? (
                  <button type="button" onClick={stop} className="w-full rounded bg-[#a1260d] px-3 py-2 text-sm font-medium text-white hover:bg-[#c42b1c]">
                    ■ Stop writer
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startWriter()}
                    disabled={!!busy}
                    className="w-full rounded bg-[#16825d] px-3 py-2 text-sm font-medium text-white hover:bg-[#1a9b6f] disabled:opacity-50"
                  >
                    ▶ Start non-stop writing
                  </button>
                )}
              </div>

              <div className="my-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                <div className="rounded bg-[#1e1e1e] py-2">
                  <div className="text-base font-semibold text-white">{stats.cycles}</div>
                  cycles
                </div>
                <div className="rounded bg-[#1e1e1e] py-2">
                  <div className="text-base font-semibold text-[#89d185]">{stats.written}</div>
                  written
                </div>
                <div className="rounded bg-[#1e1e1e] py-2">
                  <div className="text-base font-semibold text-[#f48771]">{stats.deleted}</div>
                  deleted
                </div>
              </div>
              <p className="pb-3 text-[11px] leading-relaxed text-[#858585]">
                In "All three" mode every card written in HTML gets a matching CSS rule and a matching script,
                so the preview shows styled, clickable cards as the files grow and shrink.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-4 bg-[#007acc] px-3 text-xs text-white">
        <span className="font-medium">{busy ? `● ${phase}` : "✓ Ready"}</span>
        <span>{projectId ? `project #${projectId}` : "unsaved project"}</span>
        <span className="ml-auto">Ln {totalLines}</span>
        <span>{meta.label}</span>
        <span>{meta.name}</span>
        <span>{isFullscreen ? "Full screen" : "Windowed"}</span>
      </footer>
    </div>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Minus,
  Plus,
  Scan,
  Download,
} from "lucide-react";
import type { SyncPoint } from "./types";
GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  data: Uint8Array | null;
  stale: boolean;
  sync: SyncPoint | null;
  onInverse: (point: SyncPoint) => void;
  onExport?: () => void;
  /** Shown between the toolbar and the pages, such as a note about how the PDF was built. */
  notice?: ReactNode;
}
interface Size {
  width: number;
  height: number;
}
/** A place in the document that survives zooming, resizing and rebuilding. */
interface Anchor {
  page: number;
  fraction: number;
}

export function PdfPreview({
  data,
  stale,
  sync,
  onInverse,
  onExport,
  notice,
}: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [width, setWidth] = useState(500);
  const [nearby, setNearby] = useState<Set<number>>(() => new Set([1]));
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useRef<(HTMLDivElement | null)[]>([]);
  const anchor = useRef<Anchor | null>(null);
  const loaded = useRef<PDFDocumentProxy | null>(null);
  const frame = useRef(0);
  const widest = Math.max(1, ...sizes.map((s) => s.width));
  const factor = fit ? Math.max(0.25, width / widest) : scale;

  function currentAnchor(): Anchor | null {
    const top = scroller.current?.scrollTop ?? 0;
    const index = pages.current.findIndex(
      (node) => node && node.offsetTop + node.offsetHeight > top,
    );
    const node = pages.current[index];
    return node
      ? {
          page: index + 1,
          fraction: Math.max(0, (top - node.offsetTop) / node.offsetHeight),
        }
      : null;
  }
  function goTo(target: number) {
    const node = pages.current[target - 1];
    if (node && scroller.current) scroller.current.scrollTop = node.offsetTop - 16;
    setPage(target);
  }
  function zoom(next: number | "fit") {
    anchor.current = currentAnchor();
    if (next === "fit") setFit(true);
    else {
      setFit(false);
      setScale(Math.max(0.4, Math.min(3, next)));
    }
  }

  useEffect(() => {
    if (!data) {
      setPdf(null);
      setSizes([]);
      return;
    }
    let disposed = false;
    let done = false;
    setError("");
    // Keep the reader's place when a rebuild replaces the document.
    anchor.current = currentAnchor();
    const task = getDocument({
      data: data.slice(),
      // Use only the renderer and text layer; never instantiate PDF scripting.
      enableXfa: false,
      useSystemFonts: true,
      cMapUrl: new URL("/pdf-assets/cmaps/", window.location.href).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("/pdf-assets/standard_fonts/", window.location.href).href,
      wasmUrl: new URL("/pdf-assets/wasm/", window.location.href).href,
      iccUrl: new URL("/pdf-assets/iccs/", window.location.href).href,
    });
    task.promise
      .then(async (doc) => {
        const measured = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, i) => {
            const view = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
            return { width: view.width, height: view.height };
          }),
        );
        done = true;
        if (disposed) {
          void doc.loadingTask.destroy();
          return;
        }
        const previous = loaded.current;
        loaded.current = doc;
        setSizes(measured);
        setPdf(doc);
        setPage((p) => Math.min(p, doc.numPages));
        // The previous document stays on screen until the new one has replaced it.
        if (previous) setTimeout(() => void previous.loadingTask.destroy(), 1000);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      if (!done) void task.destroy();
    };
  }, [data]);
  useEffect(() => () => void loaded.current?.loadingTask.destroy(), []);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const available = entries[0].contentRect.width;
      if (available > 64) {
        anchor.current ??= currentAnchor();
        setWidth(available - 48);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Only pages within about a screen of the view are drawn; others free their canvas.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !pdf) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNearby((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) next.add(number);
            else next.delete(number);
          }
          return next;
        }),
      { root, rootMargin: "150% 0px" },
    );
    pages.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, [pdf, sizes.length]);
  useLayoutEffect(() => {
    const target = anchor.current;
    anchor.current = null;
    const node = target && pages.current[target.page - 1];
    if (node && scroller.current)
      scroller.current.scrollTop = node.offsetTop + target.fraction * node.offsetHeight;
  }, [sizes, factor]);
  useEffect(() => {
    if (!sync || !pdf) return;
    const node = pages.current[sync.page - 1];
    const view = scroller.current;
    if (!node || !view) return;
    view.scrollTop = node.offsetTop + sync.y * factor - view.clientHeight / 2;
    setPage(sync.page);
    // Scrolls for a new sync point only; zooming afterwards keeps its own anchor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, pdf]);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const view = scroller.current;
      if (!view) return;
      const probe = view.scrollTop + view.clientHeight * 0.3;
      let current = 1;
      pages.current.forEach((node, i) => {
        if (node && node.offsetTop <= probe) current = i + 1;
      });
      setPage(current);
    });
  };
  const count = pdf ? sizes.length : 0;
  // A rebuilt PDF can be shorter; forget the pages it no longer has.
  pages.current.length = sizes.length;
  const step = (delta: number) => Math.round((factor + delta) * 10) / 10;
  return (
    <section className="pdf-pane" aria-label="PDF preview">
      <div className="pane-toolbar pdf-controls">
        <div className="toolbar-group">
          <button
            aria-label="Previous page"
            className="icon-button"
            disabled={!pdf || page <= 1}
            onClick={() => goTo(page - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="page-count">
            {pdf ? `${page} / ${count}` : "No PDF yet"}
          </span>
          <button
            aria-label="Next page"
            className="icon-button"
            disabled={!pdf || page >= count}
            onClick={() => goTo(page + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="toolbar-group">
          {stale && data && <span className="stale-pill">Previous build</span>}
          <button
            aria-label="Zoom out"
            className="icon-button"
            disabled={!pdf}
            onClick={() => zoom(step(-0.1))}
          >
            <Minus size={17} />
          </button>
          <span className="zoom-label">
            {fit ? "Fit width" : `${Math.round(scale * 100)}%`}
          </span>
          <button
            aria-label="Zoom in"
            className="icon-button"
            disabled={!pdf}
            onClick={() => zoom(step(0.1))}
          >
            <Plus size={17} />
          </button>
          <button
            aria-label="Fit PDF to width"
            className={`icon-button ${fit ? "selected" : ""}`}
            disabled={!pdf}
            onClick={() => zoom("fit")}
          >
            <Scan size={17} />
          </button>
          {onExport && (
            <>
              <span className="toolbar-divider" />
              <button
                className="icon-button"
                title="Export PDF"
                aria-label="Export PDF"
                disabled={!data}
                onClick={onExport}
              >
                <Download size={17} />
              </button>
            </>
          )}
        </div>
      </div>
      {notice}
      <div className="pdf-scroll" ref={scroller} onScroll={onScroll}>
        {error ? (
          <div className="empty-state">
            <FileText size={28} />
            <h3>Couldn’t display this PDF</h3>
            <p>{error}</p>
          </div>
        ) : pdf ? (
          sizes.map((size, i) => (
            <PdfPage
              key={i}
              pageRef={(node) => {
                pages.current[i] = node;
              }}
              pdf={pdf}
              number={i + 1}
              width={size.width * factor}
              height={size.height * factor}
              factor={factor}
              active={nearby.has(i + 1)}
              sync={sync?.page === i + 1 ? sync : null}
              onInverse={onInverse}
            />
          ))
        ) : (
          <div className="preview-placeholder">
            <div className="paper-ghost">
              <div className="ghost-title" />
              <div className="ghost-subtitle" />
              <div className="ghost-rule" />
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className={`ghost-line line-${i % 3}`} />
              ))}
              <div className="ghost-equation">E = mc²</div>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className={`ghost-line line-${i % 3}`} />
              ))}
            </div>
            <div className="preview-invitation">
              <h3>Your ideas, on paper.</h3>
              <p>Compile your project to see the PDF here.</p>
              <span className="shortcut">
                <kbd>Ctrl</kbd> <kbd>Enter</kbd>
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PdfPage({
  pageRef,
  pdf,
  number,
  width,
  height,
  factor,
  active,
  sync,
  onInverse,
}: {
  pageRef: (node: HTMLDivElement | null) => void;
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  factor: number;
  active: boolean;
  sync: SyncPoint | null;
  onInverse: (point: SyncPoint) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    holder = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setError("");
    void pdf
      .getPage(number)
      .then(async (p) => {
        if (cancelled || !canvas.current || !text.current) return;
        const viewport = p.getViewport({ scale: factor });
        const output = Math.min(window.devicePixelRatio || 1, 2);
        const node = canvas.current;
        node.width = Math.floor(viewport.width * output);
        node.height = Math.floor(viewport.height * output);
        render = p.render({
          canvas: node,
          canvasContext: node.getContext("2d")!,
          viewport,
          transform: [output, 0, 0, output, 0, 0],
        });
        await render.promise;
        if (cancelled || !text.current) return;
        text.current.replaceChildren();
        text.current.style.setProperty("--scale-factor", String(factor));
        layer = new TextLayer({
          textContentSource: await p.getTextContent(),
          container: text.current,
          viewport,
        });
        await layer.render();
      })
      .catch((e) => {
        if (!cancelled && !String(e).includes("RenderingCancelled"))
          setError(String(e));
      });
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, number, factor, active]);
  useEffect(() => {
    if (sync)
      holder.current
        ?.querySelector(".sync-marker")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [sync]);
  return (
    <div
      className="pdf-page"
      data-page={number}
      ref={(node) => {
        holder.current = node;
        pageRef(node);
      }}
      style={{ width, height }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onInverse({
          page: number,
          x: (e.clientX - rect.left) / factor,
          y: (e.clientY - rect.top) / factor,
        });
      }}
      title="Double-click to jump to the source"
    >
      {active && (
        <>
          <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
          <div ref={text} className="textLayer" />
        </>
      )}
      {sync && (
        <div
          className="sync-marker"
          style={{
            top: sync.y * factor,
            left: Math.max(0, sync.x * factor - 6),
          }}
        />
      )}
      {error && <p className="pdf-error">{error}</p>}
    </div>
  );
}

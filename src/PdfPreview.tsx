import { useEffect, useRef, useState } from "react";
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
  onExport: () => void;
}
export function PdfPreview({ data, stale, sync, onInverse, onExport }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [width, setWidth] = useState(500);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!data) {
      setPdf(null);
      return;
    }
    let disposed = false;
    setError("");
    const task = getDocument({
      data: data.slice(),
      // Use only the renderer and text layer; never instantiate PDF scripting.
      enableXfa: false,
      useSystemFonts: true,
      cMapUrl: new URL('/pdf-assets/cmaps/',window.location.href).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('/pdf-assets/standard_fonts/',window.location.href).href,
      wasmUrl: new URL('/pdf-assets/wasm/',window.location.href).href,
      iccUrl: new URL('/pdf-assets/iccs/',window.location.href).href,
    });
    task.promise
      .then((doc) => {
        if (!disposed) {
          setPdf(doc);
          setPage((p) => Math.min(p, doc.numPages));
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [data]);
  useEffect(() => {
    if (scroller.current) {
      const observer = new ResizeObserver((entries) => {
        const available = entries[0].contentRect.width;
        if (available > 64) setWidth(available - 64);
      });
      observer.observe(scroller.current);
      return () => observer.disconnect();
    }
  }, []);
  useEffect(() => {
    if (sync && pdf) {
      setPage(Math.max(1, Math.min(sync.page, pdf.numPages)));
    }
  }, [sync, pdf]);
  return (
    <section className="pdf-pane" aria-label="PDF preview">
      <div className="pane-toolbar pdf-controls">
        <div className="toolbar-group">
          <button
            aria-label="Previous page"
            className="icon-button"
            disabled={!pdf || page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="page-count">
            {pdf ? `${page} / ${pdf.numPages}` : "No PDF yet"}
          </span>
          <button
            aria-label="Next page"
            className="icon-button"
            disabled={!pdf || page >= pdf.numPages}
            onClick={() => setPage((p) => p + 1)}
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
            onClick={() => {
              setFit(false);
              setScale((s) => Math.max(0.4, s - 0.1));
            }}
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
            onClick={() => {
              setFit(false);
              setScale((s) => Math.min(3, s + 0.1));
            }}
          >
            <Plus size={17} />
          </button>
          <button
            aria-label="Fit PDF to width"
            className={`icon-button ${fit ? "selected" : ""}`}
            disabled={!pdf}
            onClick={() => setFit(true)}
          >
            <Scan size={17} />
          </button>
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
        </div>
      </div>
      <div className="pdf-scroll" ref={scroller}>
        {error ? (
          <div className="empty-state">
            <FileText size={28} />
            <h3>Couldn’t display this PDF</h3>
            <p>{error}</p>
          </div>
        ) : pdf ? (
          <PdfPage
            pdf={pdf}
            page={page}
            width={width}
            scale={scale}
            fit={fit}
            sync={sync}
            onInverse={onInverse}
          />
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
  pdf,
  page,
  width,
  scale,
  fit,
  sync,
  onInverse,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  scale: number;
  fit: boolean;
  sync: SyncPoint | null;
  onInverse: (point: SyncPoint) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    holder = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({
    width: 595,
    height: 842,
    scale: 1,
  });
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setError("");
    void pdf
      .getPage(page)
      .then(async (p) => {
        if (cancelled || !canvas.current || !text.current) return;
        const base = p.getViewport({ scale: 1 });
        const s = fit ? Math.max(0.25, width / base.width) : scale;
        const viewport = p.getViewport({ scale: s });
        setDimensions({
          width: viewport.width,
          height: viewport.height,
          scale: s,
        });
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
        text.current.style.setProperty("--scale-factor", String(s));
        layer = new TextLayer({
          textContentSource: await p.getTextContent(),
          container: text.current,
          viewport,
        });
        await layer.render();
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, width, scale, fit]);
  useEffect(() => {
    if (sync?.page === page)
      holder.current
        ?.querySelector(".sync-marker")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [sync, page, dimensions]);
  return (
    <div
      className="pdf-page"
      ref={holder}
      style={{ width: dimensions.width, height: dimensions.height }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onInverse({
          page,
          x: (e.clientX - rect.left) / dimensions.scale,
          y: (e.clientY - rect.top) / dimensions.scale,
        });
      }}
      title="Double-click to jump to the source"
    >
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
      <div ref={text} className="textLayer" />
      {sync?.page === page && (
        <div
          className="sync-marker"
          style={{
            top: sync.y * dimensions.scale,
            left: Math.max(0, sync.x * dimensions.scale - 6),
          }}
        />
      )}
      {error && <p className="pdf-error">{error}</p>}
    </div>
  );
}

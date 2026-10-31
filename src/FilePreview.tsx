import { useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { PdfPreview } from "./PdfPreview";

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Shows a project image or PDF, such as a figure, in place of the text editor. */
export function FilePreview({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState("");
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  useEffect(() => {
    let live = true;
    setBytes(null);
    setError("");
    api
      .readBinary(projectId, path)
      .then((data) => {
        if (live) setBytes(data);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [projectId, path]);
  const url = useMemo(
    () =>
      bytes && extension !== "pdf"
        ? URL.createObjectURL(
            new Blob([bytes.slice()], {
              type: imageTypes[extension] ?? "application/octet-stream",
            }),
          )
        : null,
    [bytes, extension],
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (error)
    return (
      <div className="empty-state">
        <TriangleAlert size={28} />
        <h3>Couldn’t show this file</h3>
        <p>{error}</p>
      </div>
    );
  if (extension === "pdf")
    return (
      <PdfPreview data={bytes} stale={false} sync={null} onInverse={() => {}} />
    );
  return (
    <div className="image-preview" aria-label={`Preview of ${path}`}>
      {url ? (
        <img src={url} alt={path} />
      ) : (
        <Loader2 size={24} className="spin" />
      )}
    </div>
  );
}

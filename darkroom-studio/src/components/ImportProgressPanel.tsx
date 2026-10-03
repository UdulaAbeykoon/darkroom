import { useEffect, useState } from "react";
import type { ImportProgress } from "../lib/catalog";

export default function ImportProgressPanel({ progress, onCancel }: {
  progress: ImportProgress | null;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - (progress?.startedAt ?? now)) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const megabytes = Math.round((progress?.completedBytes ?? 0) / 1024 / 1024);
  const totalMegabytes = Math.round((progress?.totalBytes ?? 0) / 1024 / 1024);
  return <div className="import-progress" role="status" aria-live="polite">
    <div><span className="spinner" /><strong>{progress?.phase ?? "Preparing import"}: {progress?.fileName ?? "photos"}</strong></div>
    <span>{progress?.completed ?? 0} / {progress?.total ?? 0} checked · {progress?.imported ?? 0} saved · {progress?.rejected ?? 0} skipped</span>
    <span>{megabytes} / {totalMegabytes} MB · {elapsed} elapsed</span>
    <progress aria-label="Photos processed" max={progress?.total || 1} value={progress?.completed ?? 0} />
    <button type="button" className="button button--quiet" disabled={stopping} onClick={() => { setStopping(true); onCancel(); }}>
      {stopping ? "Stopping after current photo…" : "Stop import"}
    </button>
  </div>;
}

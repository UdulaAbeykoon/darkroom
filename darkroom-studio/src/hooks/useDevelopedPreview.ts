import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  acquireDevelopedPreview,
  editRevision,
  previewDimensionBucket,
} from "../lib/developedPreview";
import type { PhotoRecord } from "../types";

type DevelopedPreviewOptions = {
  eager?: boolean;
  fallbackUrl?: string;
};

type ResolvedPreview = {
  photoId: string;
  src: string;
};

/**
 * Lazily resolves a cache-backed rendering of the photo's current edit state.
 * The fallback is shown immediately; visible images swap atomically when their
 * developed JPEG is ready.
 */
export function useDevelopedPreview(
  photo: PhotoRecord,
  maxDimension: number,
  options: DevelopedPreviewOptions = {},
) {
  const eager = options.eager ?? false;
  const fallbackUrl =
    options.fallbackUrl ?? photo.thumbnailUrl ?? photo.objectUrl;
  const revision = useMemo(() => editRevision(photo.edits), [photo.edits]);
  const previewDimension = useMemo(
    () => previewDimensionBucket(maxDimension),
    [maxDimension],
  );
  const [element, setElement] = useState<HTMLImageElement | null>(null);
  const [visible, setVisible] = useState(eager);
  const [resolved, setResolved] = useState<ResolvedPreview>({
    photoId: photo.id,
    src: fallbackUrl,
  });

  const imageRef = useCallback((node: HTMLImageElement | null) => {
    setElement(node);
  }, []);

  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "180px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, element]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let lease: ReturnType<typeof acquireDevelopedPreview> | null = null;
    const timer = setTimeout(() => {
      lease = acquireDevelopedPreview(photo, previewDimension);
      void lease.promise.then((url) => {
        if (!active) return;
        setResolved({
          photoId: photo.id,
          src: url ?? fallbackUrl,
        });
      });
    }, eager ? 40 : 140);

    return () => {
      active = false;
      clearTimeout(timer);
      lease?.release();
    };
  }, [
    eager,
    fallbackUrl,
    previewDimension,
    photo.blob,
    photo.renderBlob,
    photo.id,
    photo.size,
    photo.type,
    revision,
    visible,
  ]);

  return {
    imageRef,
    src: resolved.photoId === photo.id ? resolved.src : fallbackUrl,
  };
}

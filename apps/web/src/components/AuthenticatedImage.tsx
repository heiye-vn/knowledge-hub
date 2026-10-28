import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, documentResourcePath, requestBlob } from "../api/client";
import { getUser, subscribeAuth } from "../auth";

export function loadPrivateImage(
  src: string,
  onLoad: (url: string) => void,
  onError: (message: string) => void,
) {
  const controller = new AbortController();
  let objectUrl: string | undefined;
  const path = documentResourcePath(src, "asset");
  if (!path) {
    onError("不支持的图片地址");
    return () => controller.abort();
  }
  void requestBlob(path, { signal: controller.signal })
    .then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      onLoad(objectUrl);
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      onError(
        error instanceof ApiError && error.status === 403
          ? "无权查看此图片"
          : error instanceof ApiError && error.status === 404
            ? "图片不存在或已删除"
            : "图片加载失败，请刷新页面重试",
      );
    });
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

type ImageProps = { src?: string; alt?: string; title?: string }

/** Legacy local RustFS images are HTTP in development; other external images must be HTTPS. */
function allowedExternalImage(src: string): boolean {
  try {
    const url = new URL(src)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
};

function ImageContent({
  src = "",
  alt = "",
  title,
  signedIn,
}: ImageProps & { signedIn: boolean }) {
  const path = documentResourcePath(src, "asset");
  const [objectUrl, setObjectUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!path || !signedIn) return;
    return loadPrivateImage(path, setObjectUrl, setError);
  }, [path, signedIn]);

  const external = allowedExternalImage(src);
  const url = path ? objectUrl : external ? src : undefined;
  if (error || !url) {
    const description =
      error ??
      (path
        ? signedIn
          ? "图片加载中…"
          : "登录后可查看图片"
        : "图片地址不受支持");
    return (
      <span className="kh-image-fallback" role="status">
        {alt ? `${alt}：` : ""}
        {description}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setError("图片无法显示，请刷新页面重试")}
    />
  );
}

export function AuthenticatedImage(props: ImageProps) {
  const user = useSyncExternalStore(subscribeAuth, getUser, getUser);
  // A new source or account must never display the previous account's blob.
  return (
    <ImageContent
      key={`${user?.userId ?? ""}:${props.src}`}
      {...props}
      signedIn={!!user}
    />
  );
}

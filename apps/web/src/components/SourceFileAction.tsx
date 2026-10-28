import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "antd";
import { ApiError, documentResourcePath, requestBlob } from "../api/client";
import { getUser, subscribeAuth } from "../auth";

export async function downloadDocumentSource(
  path: string,
  fileName: string,
  signal?: AbortSignal,
) {
  const source = documentResourcePath(path, "source");
  if (!source) throw new ApiError(400, "不支持的原文件地址");
  const blob = await requestBlob(source, { signal });
  if (signal?.aborted) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start the download before releasing its temporary URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function DownloadAction({
  fileUrl,
  fileName,
}: {
  fileUrl: string;
  fileName: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  return (
    <>
      <Button
        loading={loading}
        disabled={loading}
        onClick={async () => {
          if (inFlight.current) return;
          const controller = new AbortController();
          inFlight.current = controller;
          setLoading(true);
          setError(undefined);
          try {
            await downloadDocumentSource(fileUrl, fileName, controller.signal);
          } catch (cause) {
            if (!controller.signal.aborted)
              setError(
                cause instanceof ApiError
                  ? cause.message
                  : "原文件下载失败，请重试",
              );
          } finally {
            // 始终复位，避免 abort 后按钮卡在 loading；卸载后的 setState 是安全的 no-op。
            inFlight.current = null;
            setLoading(false);
          }
        }}
      >
        下载原文件
      </Button>
      {error ? (
        <span role="alert" className="kh-resource-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function SourceFileAction({
  fileUrl,
  fileName,
}: {
  fileUrl?: string | null;
  fileName: string;
}) {
  const user = useSyncExternalStore(subscribeAuth, getUser, getUser);
  if (!fileUrl) return null;
  if (documentResourcePath(fileUrl, "source")) {
    return (
      <DownloadAction
        key={`${user?.userId ?? ""}:${fileUrl}`}
        fileUrl={fileUrl}
        fileName={fileName}
      />
    );
  }
  // Legacy files remain ordinary links: never attach an Authorization header.
  if (/^(https?:\/\/|\/(?!\/))[^\s\\]+$/i.test(fileUrl)) {
    return (
      <Button href={fileUrl} target="_blank" rel="noopener noreferrer">
        下载原文件
      </Button>
    );
  }
  return <span className="kh-resource-error">原文件地址不受支持</span>;
}

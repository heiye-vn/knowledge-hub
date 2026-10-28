import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Button,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  ClearOutlined,
  DeleteOutlined,
  DownOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { ImportJobs, UPLOAD_ACCEPT } from "../document-imports";
import type { ImportTaskView } from "../types";
import { formatTime } from "../utils";

const states = {
  queued: { label: "排队中", color: "default" },
  processing: { label: "处理中", color: "processing" },
  completed: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
};
const stages: Record<string, string> = {
  queued: "等待处理",
  processing: "处理中",
  uploading: "接收文件",
  validating: "校验文件",
  parsing: "解析文档",
  downloading: "下载解析结果",
  extracting: "提取内容",
  ocr: "文字识别",
  storing: "存储资源",
  saving: "保存文档",
  completed: "导入完成",
  failed: "导入失败",
};
const isActive = (task: ImportTaskView) =>
  task.state === "queued" || task.state === "processing";

export function ImportJobList({
  items,
  loading,
  error,
  retrying,
  onRefresh,
  onRetry,
  onDismiss,
}: {
  items: ImportTaskView[];
  loading: boolean;
  error: string | null;
  retrying: string[];
  onRefresh: () => void;
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  return (
    <section className="kh-imports" aria-label="我的最近导入">
      <Space className="kh-imports-list-head" wrap>
        <Typography.Text type="secondary">
          我的最近导入（最多 20 条）
        </Typography.Text>
        <Button size="small" onClick={onRefresh} loading={loading}>
          刷新任务
        </Button>
        <Typography.Text type="secondary">
          后台处理，可离开页面后返回查看
        </Typography.Text>
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {loading && !items.length ? (
        <div className="kh-imports-loading" role="status">
          <Spin size="small" /> 加载导入任务…
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无导入任务"
        />
      ) : null}
      {items.map((task) => {
        // 后端新增 state 枚举时兜底展示，不让整个列表白屏。
        const meta = states[task.state] ?? {
          label: task.state,
          color: "default",
        };
        const tone = isActive(task) ? "active" : task.state;
        return (
          <article
            key={task.id}
            className={`kh-import-job kh-import-job--${tone}`}
          >
            <Space wrap>
              <Typography.Text strong>{task.fileName}</Typography.Text>
              <Tag color={meta.color}>{meta.label}</Tag>
              <span>阶段：{stages[task.stage] || task.stage || meta.label}</span>
              <Typography.Text type="secondary">
                {formatTime(task.updatedAt)}
              </Typography.Text>
              {task.state === "completed" && task.documentId ? (
                <Link to={`/documents/${task.documentId}`}>查看文档</Link>
              ) : null}
              {task.state === "failed" && onRetry ? (
                <Button
                  size="small"
                  loading={retrying.includes(task.id)}
                  disabled={retrying.includes(task.id)}
                  onClick={() => onRetry(task.id)}
                >
                  重试解析
                </Button>
              ) : null}
              {!isActive(task) && onDismiss ? (
                <Button
                  size="small"
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => onDismiss(task.id)}
                >
                  删除记录
                </Button>
              ) : null}
            </Space>
            {task.error ? (
              <Alert type="error" showIcon title={task.error} />
            ) : null}
            {task.warnings.map((warning, index) => (
              <Alert key={index} type="warning" showIcon title={warning} />
            ))}
          </article>
        );
      })}
    </section>
  );
}

/** Mount with an account key so no job state or pending upload crosses accounts. */
export function DocumentImports({ canUpload }: { canUpload: boolean }) {
  const [jobs] = useState(() => new ImportJobs());
  const state = useSyncExternalStore(
    jobs.subscribe,
    jobs.getSnapshot,
    jobs.getSnapshot,
  );
  // 折叠面板：有进行中/失败任务时自动展开，其余时间只保留一行摘要，
  // 避免大量已完成记录把下面的文档列表一直顶下去。手动展开/收起优先。
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const previousAttention = useRef(0);
  const activeCount = state.items.filter(isActive).length;
  const failedCount = state.items.filter(
    (item) => item.state === "failed",
  ).length;
  const finishedCount = state.items.length - activeCount;
  const attention = activeCount + failedCount;
  useEffect(() => {
    if (!canUpload) return;
    void jobs.start();
    return () => jobs.stop();
  }, [jobs, canUpload]);
  useEffect(() => {
    if (attention > 0 && previousAttention.current === 0) setUserChoice(null);
    previousAttention.current = attention;
  }, [attention]);
  const expanded = userChoice ?? attention > 0;
  if (!canUpload) return null;

  return (
    <div className="kh-imports-widget">
      <Upload
        accept={UPLOAD_ACCEPT}
        multiple={false}
        showUploadList={false}
        disabled={state.submitting}
        className="kh-import-upload-trigger"
        beforeUpload={(file) => {
          void jobs.upload(file);
          return false;
        }}
      >
        <button
          type="button"
          className={`kh-import-upload${state.submitting ? " is-uploading" : ""}`}
          disabled={state.submitting}
        >
          <UploadOutlined className="kh-import-upload-icon" />
          <span className="kh-import-upload-text">
            <strong>
              {state.submitting ? "正在上传，请稍候…" : "上传文件，后台自动解析"}
            </strong>
            <span>
              支持 PDF / DOCX / PPTX / XLSX / TXT / MD 与 PNG / JPG / JPEG /
              WEBP，单个不超过 50MB
            </span>
          </span>
        </button>
      </Upload>
      {state.uploadError ? (
        <Alert
          style={{ marginTop: 8 }}
          type="error"
          showIcon
          title={state.uploadError}
          description={
            state.canRetryUpload
              ? "可重试同一次上传，不会重复创建任务；也可刷新任务确认是否已接收。"
              : undefined
          }
          action={
            state.canRetryUpload ? (
              <Button
                size="small"
                disabled={state.submitting}
                onClick={() => void jobs.retryUpload()}
              >
                重试上传
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="kh-imports-panel">
        <div className="kh-imports-header">
          <button
            type="button"
            className="kh-imports-toggle"
            aria-expanded={expanded}
            onClick={() => setUserChoice(!expanded)}
          >
            <DownOutlined
              className={`kh-imports-caret${expanded ? " is-open" : ""}`}
            />
            <span className="kh-imports-title">
              {expanded ? "收起导入记录" : "展开导入记录"}
            </span>
          </button>
          <div className="kh-imports-chips" aria-live="polite">
            <span className="kh-imports-chip">共 {state.items.length} 条</span>
            {activeCount ? (
              <span className="kh-imports-chip is-processing">
                <span className="kh-imports-dot" aria-hidden="true" />
                处理中 {activeCount}
              </span>
            ) : null}
            {failedCount ? (
              <span className="kh-imports-chip is-failed">
                失败 {failedCount}
              </span>
            ) : null}
            {!state.items.length ? (
              <span className="kh-imports-chip">
                后台处理，可离开页面后返回查看
              </span>
            ) : null}
          </div>
          <div className="kh-imports-actions">
            <Popconfirm
              title="清空已完成和失败的导入记录？"
              description="仅隐藏记录，不会删除已生成的文档。"
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void jobs.dismissAll()}
            >
              <Button
                size="small"
                danger
                icon={<ClearOutlined />}
                disabled={finishedCount === 0}
              >
                清空记录
              </Button>
            </Popconfirm>
          </div>
        </div>
        {expanded ? (
          <div className="kh-imports-body">
            <ImportJobList
              items={state.items}
              loading={state.loading}
              error={state.error}
              retrying={state.retrying}
              onRefresh={() => void jobs.refresh()}
              onRetry={canUpload ? (id) => void jobs.retry(id) : undefined}
              onDismiss={(id) => void jobs.dismiss(id)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

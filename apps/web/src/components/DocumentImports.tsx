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
  Tooltip,
  Typography,
  Upload,
} from "antd";
import {
  ClearOutlined,
  DeleteOutlined,
  DownOutlined,
  FileAddOutlined,
  ReloadOutlined,
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

export type ImportJobsController = {
  jobs: ImportJobs;
  state: ReturnType<ImportJobs["getSnapshot"]>;
  activeCount: number;
  failedCount: number;
  finishedCount: number;
};

/**
 * 托管文档导入任务状态，便于左侧录入栏与右侧导入记录面板共享同一份任务流。
 * 调用方按账号 key 挂载以保证跨账号状态彻底隔离。
 */
export function useImportJobs(
  enabled: boolean,
  onCompleted?: () => void,
): ImportJobsController {
  const [jobs] = useState(() => new ImportJobs());
  const state = useSyncExternalStore(
    jobs.subscribe,
    jobs.getSnapshot,
    jobs.getSnapshot,
  );
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  // 监测是否有任务从非 completed 转为 completed，自动刷新左侧文档列表
  const knownCompletedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled || state.loading) return;
    const completedIds = state.items
      .filter((item) => item.state === "completed")
      .map((item) => item.id);
    if (knownCompletedRef.current === null) {
      knownCompletedRef.current = new Set(completedIds);
      return;
    }
    const prev = knownCompletedRef.current;
    const hasNewCompleted = completedIds.some((id) => !prev.has(id));
    knownCompletedRef.current = new Set(completedIds);
    if (hasNewCompleted) {
      onCompletedRef.current?.();
    }
  }, [enabled, state.items, state.loading]);

  useEffect(() => {
    if (!enabled) return;
    void jobs.start();
    return () => jobs.stop();
  }, [jobs, enabled]);

  const activeCount = state.items.filter(isActive).length;
  const failedCount = state.items.filter(
    (item) => item.state === "failed",
  ).length;
  const finishedCount = state.items.length - activeCount;

  return { jobs, state, activeCount, failedCount, finishedCount };
}

export function ImportJobList({
  items,
  loading,
  error,
  retrying,
  onRefresh,
  onRetry,
  onDismiss,
  compact = false,
}: {
  items: ImportTaskView[];
  loading: boolean;
  error: string | null;
  retrying: string[];
  onRefresh: () => void;
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
  /** 侧边面板紧凑布局：隐藏内部重复标题栏，每条任务按上下两行排布 */
  compact?: boolean;
}) {
  return (
    <section
      className={`kh-imports${compact ? " kh-imports--compact" : ""}`}
      aria-label="我的最近导入"
    >
      {!compact ? (
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
      ) : null}
      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          style={{ marginBottom: 10 }}
        />
      ) : null}
      {loading && !items.length ? (
        <div className="kh-imports-loading" role="status">
          <Spin size="small" /> 加载导入任务…
        </div>
      ) : null}
      {!loading && !items.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            compact ? (
              <span className="kh-imports-empty-copy">
                暂无导入任务
                <small>在左侧上传文件后，这里会实时跟踪解析进度</small>
              </span>
            ) : (
              "暂无导入任务"
            )
          }
        />
      ) : null}
      {items.map((task) => {
        // 后端新增 state 枚举时兜底展示，不让整个列表白屏。
        const meta = states[task.state] ?? {
          label: task.state,
          color: "default",
        };
        const tone = isActive(task) ? "active" : task.state;
        const stageText = stages[task.stage] || task.stage || meta.label;
        return (
          <article
            key={task.id}
            className={`kh-import-job kh-import-job--${tone}`}
          >
            {compact ? (
              <>
                <div className="kh-import-job-top">
                  <Typography.Text strong className="kh-import-job-name">
                    {task.fileName}
                  </Typography.Text>
                  <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                    {meta.label}
                  </Tag>
                </div>
                <div className="kh-import-job-meta">
                  <span>阶段：{stageText}</span>
                  <span>{formatTime(task.updatedAt)}</span>
                </div>
                <div className="kh-import-job-ops">
                  {task.state === "completed" && task.documentId ? (
                    <Link to={`/documents/${task.documentId}`}>查看文档</Link>
                  ) : null}
                  {task.state === "failed" && onRetry ? (
                    <Button
                      size="small"
                      loading={retrying.includes(task.id)}
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
                </div>
              </>
            ) : (
              <Space wrap>
                <Typography.Text strong>{task.fileName}</Typography.Text>
                <Tag color={meta.color}>{meta.label}</Tag>
                <span>阶段：{stageText}</span>
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
            )}
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

/** 左侧顶部混合录入栏：上传文件为主入口，在线新建文档为轻量次入口 */
export function DocumentImportBar({
  controller,
  onCreateClick,
}: {
  controller: ImportJobsController;
  onCreateClick?: () => void;
}) {
  const { jobs, state } = controller;
  return (
    <div className="kh-import-bar">
      <div className="kh-import-entry-row">
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
                {state.submitting
                  ? "正在上传，请稍候…"
                  : "上传文件，后台自动解析"}
              </strong>
              <span>
                支持 PDF / DOCX / PPTX / XLSX / TXT / MD 与 PNG / JPG / JPEG /
                WEBP，单个不超过 50MB
              </span>
            </span>
          </button>
        </Upload>
        {onCreateClick ? (
          <button
            type="button"
            className="kh-import-create-card"
            onClick={onCreateClick}
          >
            <FileAddOutlined className="kh-import-create-icon" />
            <span className="kh-import-create-text">
              <strong>在线新建文档</strong>
              <span>编写 FAQ / 规范 / 纠偏补丁</span>
            </span>
          </button>
        ) : null}
      </div>
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
    </div>
  );
}

/** 右侧独立的「导入记录」面板：常驻展示后台解析进度，不挤压左侧文档列表 */
export function DocumentImportsSidebar({
  controller,
  canRetry = true,
}: {
  controller: ImportJobsController;
  canRetry?: boolean;
}) {
  const { jobs, state, activeCount, failedCount, finishedCount } = controller;
  return (
    <aside className="kh-docs-imports-aside" aria-label="文档导入记录面板">
      <div className="kh-docs-imports-head">
        <div className="kh-docs-imports-title-row">
          <h3>导入记录</h3>
          <div className="kh-docs-imports-head-ops">
            <Tooltip title="刷新任务">
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                loading={state.loading}
                aria-label="刷新任务"
                onClick={() => void jobs.refresh()}
              />
            </Tooltip>
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
                type="text"
                danger
                icon={<ClearOutlined />}
                disabled={finishedCount === 0}
              >
                清空
              </Button>
            </Popconfirm>
          </div>
        </div>
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
            <span className="kh-imports-chip">后台解析，可离开页面查看</span>
          ) : null}
        </div>
      </div>

      <div className="kh-docs-imports-scroll">
        <ImportJobList
          compact
          items={state.items}
          loading={state.loading}
          error={state.error}
          retrying={state.retrying}
          onRefresh={() => void jobs.refresh()}
          onRetry={canRetry ? (id) => void jobs.retry(id) : undefined}
          onDismiss={(id) => void jobs.dismiss(id)}
        />
      </div>
    </aside>
  );
}

/** 兼容组合组件：单栏折叠形态（保留供独立复用与单测覆盖） */
export function DocumentImports({
  canUpload,
  onCreateClick,
}: {
  canUpload: boolean;
  onCreateClick?: () => void;
}) {
  const controller = useImportJobs(canUpload);
  const { jobs, state, activeCount, failedCount, finishedCount } = controller;
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const previousAttention = useRef(0);
  const attention = activeCount + failedCount;
  useEffect(() => {
    if (attention > 0 && previousAttention.current === 0) setUserChoice(null);
    previousAttention.current = attention;
  }, [attention]);
  const expanded = userChoice ?? attention > 0;
  if (!canUpload) return null;

  return (
    <div className="kh-imports-widget">
      <DocumentImportBar controller={controller} onCreateClick={onCreateClick} />
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

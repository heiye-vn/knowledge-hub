import { documentApi } from "./api";
import type { ImportTaskView } from "./types";

export const UPLOAD_ACCEPT =
  ".pdf,.docx,.pptx,.xlsx,.txt,.md,.png,.jpg,.jpeg,.webp";
export function validateUploadFile(file: {
  name: string;
  size: number;
}): string | null {
  if (!/\.(pdf|docx|pptx|xlsx|txt|md|png|jpe?g|webp)$/i.test(file.name)) {
    return "不支持此文件类型，请选择 PDF、DOCX、PPTX、XLSX、TXT、MD 或 PNG/JPG/JPEG/WEBP 图片";
  }
  return file.size > 50 * 1024 * 1024 ? "文件不能超过 50MB" : null;
}

interface ImportSnapshot {
  items: ImportTaskView[];
  loading: boolean;
  error: string | null;
  submitting: boolean;
  uploadError: string | null;
  canRetryUpload: boolean;
  retrying: string[];
}
type ImportApi = Pick<
  typeof documentApi,
  | "imports"
  | "importTask"
  | "retryImport"
  | "uploadParse"
  | "dismissImport"
  | "dismissImports"
>;
const isActive = (task: ImportTaskView) =>
  task.state === "queued" || task.state === "processing";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试";

/** Page-owned memory only. stop() releases uploads, requests and polling on account change/unmount. */
export class ImportJobs {
  private readonly api: ImportApi;
  private snapshot: ImportSnapshot = {
    items: [],
    loading: false,
    error: null,
    submitting: false,
    uploadError: null,
    canRetryUpload: false,
    retrying: [],
  };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private active = false;
  private polling = false;
  private pendingForm: FormData | null = null;

  constructor(api: ImportApi = documentApi) {
    this.api = api;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ImportSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private current(generation: number) {
    return this.active && generation === this.generation;
  }
  private signal(timeout = 20000) {
    return AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(timeout),
    ]);
  }
  private upsert(task: ImportTaskView) {
    const exists = this.snapshot.items.some((item) => item.id === task.id);
    const items = exists
      ? this.snapshot.items.map((item) => (item.id === task.id ? task : item))
      : [task, ...this.snapshot.items];
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.update({ items: items.slice(0, 20) });
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      !this.active ||
      this.polling ||
      this.snapshot.loading ||
      this.snapshot.error ||
      !this.snapshot.items.some(isActive)
    )
      return;
    this.timer = setTimeout(() => void this.poll(), 3000);
  }
  private async poll() {
    const generation = this.generation;
    this.polling = true;
    try {
      // 单次列表请求代替逐任务轮询，最多 20 个活跃任务也只发 1 个请求。
      const result = await this.api.imports(this.signal());
      if (!this.current(generation)) return;
      // 保留本地刚上传、还没出现在列表响应里的进行中任务。
      const known = new Set(result.items.map((item) => item.id));
      const pending = this.snapshot.items.filter(
        (item) => isActive(item) && !known.has(item.id),
      );
      this.update({
        items: [...pending, ...result.items]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20),
      });
    } catch (error) {
      if (this.current(generation))
        this.update({
          error: `任务状态更新失败：${errorText(error)}。自动更新已暂停，请刷新任务。`,
        });
    } finally {
      if (this.current(generation)) {
        this.polling = false;
        this.schedule();
      }
    }
  }
  async start() {
    this.active = true;
    this.generation++;
    this.controller = new AbortController();
    this.polling = false;
    this.update({
      loading: false,
      submitting: false,
      retrying: [],
      canRetryUpload: false,
      uploadError: null,
    });
    await this.refresh();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.controller.abort();
    clearTimeout(this.timer);
    this.pendingForm = null;
  }
  async refresh() {
    if (!this.active || this.snapshot.loading) return;
    const generation = this.generation;
    const initialItems = this.snapshot.items;
    this.update({ loading: true, error: null });
    clearTimeout(this.timer);
    try {
      const result = await this.api.imports(this.signal());
      if (!this.current(generation)) return;
      // Keep uploads/retries that arrived while the history request was in flight.
      const changed = this.snapshot.items.filter(
        (item) => !initialItems.includes(item),
      );
      this.update({ items: result.items.slice(0, 20) });
      changed.forEach((item) => this.upsert(item));
    } catch (error) {
      if (this.current(generation))
        this.update({ error: `任务加载失败：${errorText(error)}` });
    } finally {
      if (this.current(generation)) {
        this.update({ loading: false });
        this.schedule();
      }
    }
  }
  async upload(file: File, metadata: Record<string, string> = {}) {
    if (!this.active || this.snapshot.submitting) return;
    const invalid = validateUploadFile(file);
    if (invalid) {
      this.update({ uploadError: invalid, canRetryUpload: false });
      this.pendingForm = null;
      return;
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(metadata)) {
      if (key !== "file" && key !== "requestId") form.append(key, value);
    }
    form.append("file", file);
    form.append("requestId", crypto.randomUUID());
    this.pendingForm = form;
    await this.retryUpload();
  }
  async retryUpload() {
    if (!this.active || this.snapshot.submitting || !this.pendingForm) return;
    const generation = this.generation;
    this.update({ submitting: true, uploadError: null, canRetryUpload: false });
    try {
      const task = await this.api.uploadParse(
        this.pendingForm,
        this.signal(300000),
      );
      if (!this.current(generation)) return;
      this.upsert(task);
      this.pendingForm = null;
    } catch (error) {
      if (this.current(generation))
        this.update({
          uploadError: `上传失败：${errorText(error)}`,
          canRetryUpload: true,
        });
    } finally {
      if (this.current(generation)) {
        this.update({ submitting: false });
        this.schedule();
      }
    }
  }
  async retry(id: string) {
    if (
      !this.active ||
      this.snapshot.retrying.includes(id) ||
      !this.snapshot.items.some(
        (item) => item.id === id && item.state === "failed",
      )
    )
      return;
    const generation = this.generation;
    this.update({ retrying: [...this.snapshot.retrying, id] });
    try {
      const task = await this.api.retryImport(id, this.signal());
      if (this.current(generation)) this.upsert(task);
    } catch (error) {
      if (this.current(generation))
        this.update({ error: `重试失败：${errorText(error)}` });
    } finally {
      if (this.current(generation)) {
        this.update({
          retrying: this.snapshot.retrying.filter((value) => value !== id),
        });
        this.schedule();
      }
    }
  }

  /** 从列表隐藏单条已结束记录（服务端软隐藏，不删文档）。 */
  async dismiss(id: string) {
    if (!this.active) return;
    const generation = this.generation;
    try {
      await this.api.dismissImport(id);
      if (!this.current(generation)) return;
      this.update({
        items: this.snapshot.items.filter((item) => item.id !== id),
      });
    } catch (error) {
      if (this.current(generation))
        this.update({ error: `删除记录失败：${errorText(error)}` });
    }
  }

  /** 隐藏全部已完成/失败记录，进行中的任务保留在列表里。 */
  async dismissAll() {
    if (!this.active) return;
    const generation = this.generation;
    try {
      await this.api.dismissImports();
      if (!this.current(generation)) return;
      this.update({ items: this.snapshot.items.filter(isActive) });
    } catch (error) {
      if (this.current(generation))
        this.update({ error: `清空记录失败：${errorText(error)}` });
    }
  }
}

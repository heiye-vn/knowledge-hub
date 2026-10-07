/** 返给前端的溯源条目（摘录，不含整块正文） */
export interface ChatSource {
  /** 资料编号，与回答中的 [n] 对应 */
  index: number;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  excerpt: string;
  score: number;
}

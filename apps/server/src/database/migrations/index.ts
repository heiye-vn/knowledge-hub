import { Baseline1780000000000 } from './1780000000000-baseline.js';
import { IndexOutbox1790000001000 } from './1790000001000-index-outbox.js';

/**
 * 迁移清单：新增迁移必须在此登记（运行时与 CLI 共用同一份列表），
 * 顺序按 timestamp 升序。
 */
export const MIGRATIONS = [
  Baseline1780000000000,
  IndexOutbox1790000001000,
];

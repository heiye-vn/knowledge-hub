/**
 * Knowledge Hub 品牌标 · K 字母标（反白版）
 *
 * 设计来源：design/brand/README.md（字母标规范：1024 画布主体占 68%、
 * 竖干占字面宽 24%、双臂等厚、所有笔画端点水平/垂直切、方块不加描边）。
 *
 * 顶栏 28px 属规范里的「小尺寸场景」：底部青铜金纸边在此尺寸不可见，
 * 按规范省略，仅保留「深墨蓝方块 + 负形 K」；方块圆角按 512 主版比例折算
 * 为 rx=2.4（32 网格）。与登录页位图 kbase-A（骨白方块 + 深蓝 K）
 * 为正负反转的同一骨架，品牌触点统一。
 *
 * 尺寸表现：28px 下 K 笔画约 2.9px、方块边界清晰；48/64px 细节完整。
 */
export function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect width="32" height="32" rx="2.4" fill="#1B2A41" />
      {/* 负形 K：竖干 x∈[9.25,12.55]，双臂法向厚度 3.21 等宽，腰部交汇于 (15,16) */}
      <path
        fill="#FFFFFF"
        d="M9.25 5.1h3.3v8.8l6.25-8.8h3.95L15 16l7.75 10.9h-3.95l-6.25-8.8v8.8h-3.3z"
      />
    </svg>
  )
}

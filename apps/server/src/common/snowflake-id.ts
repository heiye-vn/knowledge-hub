import SnowflakeId from 'snowflake-id';
// 兼容 ESM 与 CJS 的 default 导出结构差异
const SnowflakeConstructor =
  (SnowflakeId as unknown as { default?: typeof SnowflakeId }).default ??
  SnowflakeId;
const snowflake = new SnowflakeConstructor({
  mid: Number(process.env.SNOWFLAKE_WORKER_ID ?? 1),
  offset: Number(process.env.SNOWFLAKE_OFFSET ?? 1704067200000),
});
/** 生成雪花 ID（string），对应 Java long / Postgres BIGINT */
export function nextSnowflakeId(): string {
  return snowflake.generate();
}

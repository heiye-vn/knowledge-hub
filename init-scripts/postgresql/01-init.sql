-- 启用 pgvector 向量检索扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    -- 上传源文件元数据（在线创建的文档为 NULL）
    file_url VARCHAR,
    object_key VARCHAR,
    file_name VARCHAR,
    file_size BIGINT,
    file_extension VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 文档正文表（与 kh_document 一对一，document_id 同时是主键与外键）
-- 前身：MongoDB document_content 集合；2026-09-20 切换单 PostgreSQL 时并入
CREATE TABLE IF NOT EXISTS kh_document_content (
    document_id BIGINT PRIMARY KEY REFERENCES kh_document(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    content_length INT NOT NULL DEFAULT 0,
    content_summary VARCHAR NOT NULL DEFAULT '',
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 表与字段注释
COMMENT ON TABLE kh_document IS '文档元数据表';
COMMENT ON COLUMN kh_document.id IS '文档主键ID';
COMMENT ON COLUMN kh_document.title IS '文档标题';
COMMENT ON COLUMN kh_document.summary IS '文档摘要/简介';
COMMENT ON COLUMN kh_document.category_id IS '所属知识库分类ID';
COMMENT ON COLUMN kh_document.team_id IS '所属团队/空间ID';
COMMENT ON COLUMN kh_document.author_id IS '作者/创建者ID';
COMMENT ON COLUMN kh_document.cover_image IS '封面图片存储路径或URL';
COMMENT ON COLUMN kh_document.tags IS '标签列表（逗号分隔或JSON字符串）';
COMMENT ON COLUMN kh_document.status IS '文档状态（0: 草稿, 1: 已发布, 2: 已归档）';
COMMENT ON COLUMN kh_document.remark IS '备注说明';
COMMENT ON COLUMN kh_document.view_count IS '浏览/阅读次数';
COMMENT ON COLUMN kh_document.like_count IS '点赞次数';
COMMENT ON COLUMN kh_document.comment_count IS '评论次数';
COMMENT ON COLUMN kh_document.favourite_count IS '收藏次数';
COMMENT ON COLUMN kh_document.word_count IS '文档正文字数统计';
COMMENT ON COLUMN kh_document.publish_time IS '正式发布时间';
COMMENT ON COLUMN kh_document.is_public IS '是否公开（false: 私有/空间内, true: 全局公开）';
COMMENT ON COLUMN kh_document.file_url IS '源文件直链 URL（bucket 匿名只读时可直访；预签名模式下仅作参考，运行时用 object_key 动态签名）';
COMMENT ON COLUMN kh_document.object_key IS 'RustFS 对象 Key（如 documents/2026/09/17/xxx.pdf），删除清理与重解析的依据';
COMMENT ON COLUMN kh_document.file_name IS '上传时的原始文件名';
COMMENT ON COLUMN kh_document.file_size IS '源文件大小（字节）';
COMMENT ON COLUMN kh_document.file_extension IS '源文件扩展名（小写，不含点）';
COMMENT ON COLUMN kh_document.created_at IS '记录创建时间';
COMMENT ON COLUMN kh_document.updated_at IS '记录最后更新时间';
COMMENT ON COLUMN kh_document.create_by IS '创建操作人ID';
COMMENT ON COLUMN kh_document.update_by IS '最后更新操作人ID';
COMMENT ON COLUMN kh_document.deleted IS '逻辑删除标记（false: 正常, true: 已删除）';
COMMENT ON TABLE kh_document_content IS '文档正文表（Markdown 全文，与 kh_document 一对一）';
COMMENT ON COLUMN kh_document_content.document_id IS '文档ID（kh_document.id，主键兼外键，ON DELETE CASCADE）';
COMMENT ON COLUMN kh_document_content.content IS 'Markdown 正文';
COMMENT ON COLUMN kh_document_content.content_length IS '正文字符数';
COMMENT ON COLUMN kh_document_content.content_summary IS '正文摘要/预览（未显式传 summary 时取正文前 200 字）';
COMMENT ON COLUMN kh_document_content.version IS '版本号（每次正文变更 +1）';
COMMENT ON COLUMN kh_document_content.created_at IS '记录创建时间';
COMMENT ON COLUMN kh_document_content.updated_at IS '记录最后更新时间';
COMMENT ON COLUMN kh_document_content.deleted IS '逻辑删除标记（与 kh_document.deleted 同步置位）';

-- ---------------------------------------------------------------------------
-- 存量库升级（幂等）：
-- 1) 为 2026-09-19 之前初始化的 kh_document 补文件元数据列；
-- 2) 2026-09-20 切换单 PostgreSQL：删 Mongo 关联列 content_id，新增 kh_document_content。
--    新初始化的库走上方 CREATE TABLE 已是目标态，此段幂等跳过。
-- ---------------------------------------------------------------------------
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS file_url VARCHAR;
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS object_key VARCHAR;
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS file_name VARCHAR;
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS file_extension VARCHAR;
ALTER TABLE kh_document DROP COLUMN IF EXISTS content_id;

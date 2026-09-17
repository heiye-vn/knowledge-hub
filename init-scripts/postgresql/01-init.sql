-- 启用 pgvector 向量检索扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
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
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 表与字段注释
COMMENT ON TABLE kh_document IS '文档元数据表';
COMMENT ON COLUMN kh_document.id IS '文档主键ID';
COMMENT ON COLUMN kh_document.title IS '文档标题';
COMMENT ON COLUMN kh_document.content_id IS 'MongoDB 文档正文记录主键ID (document_content._id)';
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
COMMENT ON COLUMN kh_document.created_at IS '记录创建时间';
COMMENT ON COLUMN kh_document.updated_at IS '记录最后更新时间';
COMMENT ON COLUMN kh_document.create_by IS '创建操作人ID';
COMMENT ON COLUMN kh_document.update_by IS '最后更新操作人ID';
COMMENT ON COLUMN kh_document.deleted IS '逻辑删除标记（false: 正常, true: 已删除）';

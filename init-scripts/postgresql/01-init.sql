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
COMMENT ON COLUMN kh_document.status IS '文档状态（0: 草稿, 1: 已发布, 2: 已归档, 3: 待审核）';
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

-- ---------------------------------------------------------------------------
-- 文档发布审核记录
-- 一次「提交审核」一行；review_result 为 NULL 表示待审，通过 / 驳回后回填。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh_document_review (
    id BIGINT PRIMARY KEY,                          -- 审核记录 ID（雪花）
    document_id BIGINT NOT NULL,                    -- 被审文档 ID → kh_document.id
    reviewer_id BIGINT,                             -- 审核人 ID；待审时为 NULL
    reviewer_name VARCHAR,                          -- 审核人姓名
    review_result SMALLINT,                         -- NULL=待审 1=通过 2=驳回
    review_comment VARCHAR,                         -- 审核意见（驳回必填）
    before_status SMALLINT NOT NULL,                -- 提审前文档状态（0 草稿 / 1 已发布）
    reviewed_at TIMESTAMP,                          -- 审核完成时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 提交审核时间
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 按文档查审核历史
CREATE INDEX IF NOT EXISTS idx_kh_document_review_document_id
    ON kh_document_review(document_id);

-- 🔴 修基线实现缺陷：其「同一文档只能有一条待审」只在应用层判空，并发提审会插进两条。
-- 这里用部分唯一索引把约束下沉到数据库：一个文档最多一条 review_result IS NULL 的记录。
-- 顺带覆盖待办列表的查询模式（部分索引只装待审行，历史越久越不吃亏）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_kh_document_review_pending
    ON kh_document_review(document_id) WHERE review_result IS NULL;

COMMENT ON TABLE kh_document_review IS '文档发布审核记录表';
COMMENT ON COLUMN kh_document_review.id IS '审核记录主键ID（雪花）';
COMMENT ON COLUMN kh_document_review.document_id IS '被审文档ID（kh_document.id）';
COMMENT ON COLUMN kh_document_review.reviewer_id IS '审核人ID（待审时为 NULL，接入鉴权后从登录态取）';
COMMENT ON COLUMN kh_document_review.reviewer_name IS '审核人姓名';
COMMENT ON COLUMN kh_document_review.review_result IS '审核结果（NULL: 待审, 1: 通过, 2: 驳回）';
COMMENT ON COLUMN kh_document_review.review_comment IS '审核意见（驳回时必填）';
COMMENT ON COLUMN kh_document_review.before_status IS '提交审核前的文档状态（区分首次提审与已发布改稿重审）';
COMMENT ON COLUMN kh_document_review.reviewed_at IS '审核完成时间';
COMMENT ON COLUMN kh_document_review.created_at IS '提交审核时间';
COMMENT ON COLUMN kh_document_review.updated_at IS '记录最后更新时间';

-- ---------------------------------------------------------------------------
-- 用户 / 角色 / 用户-角色关联（feat-v7 鉴权）
-- 用户与角色多对多，kh_user_role 承接；角色用 role_code 编码标识。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh_user (
    id BIGINT PRIMARY KEY,                          -- 用户 ID（雪花）
    username VARCHAR(50) NOT NULL,                  -- 登录用户名
    password VARCHAR(255) NOT NULL,                 -- 密码（bcrypt 哈希）
    email VARCHAR(100),                             -- 邮箱（可选）
    real_name VARCHAR(50),                          -- 真实姓名 / 显示名
    avatar VARCHAR(500),                            -- 头像 URL
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    last_login_at TIMESTAMP,                        -- 最后登录时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 创建时间
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 更新时间
    deleted BOOLEAN NOT NULL DEFAULT false          -- 软删除标记
);

-- 用户名唯一（仅约束未删除用户，软删后允许同名重建）
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_username
    ON kh_user(username) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS kh_role (
    id BIGINT PRIMARY KEY,                          -- 角色 ID（雪花）
    role_name VARCHAR(50) NOT NULL,                 -- 角色名称（展示用）
    role_code VARCHAR(50) NOT NULL UNIQUE,          -- 角色编码（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER）
    description VARCHAR(200),                       -- 角色描述
    status SMALLINT NOT NULL DEFAULT 1              -- 0 禁用 1 启用
);

CREATE TABLE IF NOT EXISTS kh_user_role (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- 用户 ID
    role_id BIGINT NOT NULL REFERENCES kh_role(id), -- 角色 ID
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 分配时间
    UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_user_role_user_id ON kh_user_role(user_id);

COMMENT ON TABLE kh_user IS '用户表';
COMMENT ON COLUMN kh_user.id IS '用户主键ID（雪花）';
COMMENT ON COLUMN kh_user.username IS '登录用户名（未删除范围内唯一）';
COMMENT ON COLUMN kh_user.password IS '密码哈希（bcrypt, cost=10）';
COMMENT ON COLUMN kh_user.status IS '账户状态（0: 禁用, 1: 启用）';
COMMENT ON COLUMN kh_user.last_login_at IS '最后登录时间（登录成功时更新）';
COMMENT ON COLUMN kh_user.deleted IS '逻辑删除标记';
COMMENT ON TABLE kh_role IS '角色表';
COMMENT ON COLUMN kh_role.role_code IS '角色编码（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER）';
COMMENT ON TABLE kh_user_role IS '用户-角色关联表（多对多）';

-- 预置角色
INSERT INTO kh_role (id, role_name, role_code, description) VALUES
    (2000000000000000001, '管理员', 'ROLE_ADMIN', '系统管理'),
    (2000000000000000002, '审核员', 'ROLE_REVIEWER', '文档审核'),
    (2000000000000000003, '普通用户', 'ROLE_USER', '默认角色')
ON CONFLICT (id) DO NOTHING;

-- 测试账号（密码均为 123456，仅本地开发环境使用）
INSERT INTO kh_user (id, username, password, email, real_name, status) VALUES
    (1000000000000000001, 'admin', '$2b$10$ACMLz4miGMa4XMxyWiCEu.1ps/.BrcFLDeah73H2Kxulo6bqil6aK', 'admin@company.com', '系统管理员', 1),
    (1000000000000000002, 'reviewer', '$2b$10$ACMLz4miGMa4XMxyWiCEu.1ps/.BrcFLDeah73H2Kxulo6bqil6aK', 'reviewer@company.com', '审核员张三', 1),
    (1000000000000000003, 'user', '$2b$10$ACMLz4miGMa4XMxyWiCEu.1ps/.BrcFLDeah73H2Kxulo6bqil6aK', 'user@company.com', '普通用户李四', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_user_role (id, user_id, role_id) VALUES
    (3000000000000000001, 1000000000000000001, 2000000000000000001),  -- admin → 管理员
    (3000000000000000002, 1000000000000000001, 2000000000000000002),  -- admin → 审核员
    (3000000000000000003, 1000000000000000002, 2000000000000000002),  -- reviewer → 审核员
    (3000000000000000004, 1000000000000000003, 2000000000000000003)   -- user → 普通用户
ON CONFLICT (id) DO NOTHING;

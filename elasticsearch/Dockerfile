# Elasticsearch + IK 中文分词（RAG 向量与混合检索底座）
#
# 版本强约束：ES 与 analysis-ik 版本必须严格一致，否则插件加载失败会导致节点无法启动。
FROM elasticsearch:8.17.0

# 安装 IK 分词插件（版本与上方 ES 严格对齐）
RUN elasticsearch-plugin install --batch \
    https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-8.17.0.zip

```bash
curl -s -X POST http://localhost:3000/documents/upload/parse \
  -F 'file=@./申论总结课.pptx' \
  -F 'authorId=10001' \
  -F 'createBy=10001' | jq
```

```bash
DOC_ID='337052971286138880'
curl -s "http://localhost:3000/documents/${DOC_ID}" | jq
```

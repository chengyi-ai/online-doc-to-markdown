## 改动内容

<!-- 解决了什么问题，改了哪些文件。关联 issue：Closes #N。不要贴私有文档链接或文档内容。 -->

## 测试

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `python tools/validate_repo.py`
- [ ] `python -m unittest discover -s tests`
- [ ] 行为改动已补测试（不依赖外网）
- [ ] 用户可见变化已同步 `README.md`

## 安全自查

- [ ] 没有放宽主机白名单、跳转限制或登录 / 权限判断
- [ ] 没有在服务端保存、记录或转发文档内容，没有暴露 Token / Cookie
- [ ] 转换结果忠实于原文

## 风险与回滚

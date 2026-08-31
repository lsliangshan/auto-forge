# 城事通

“城事通”是 AutoForge 的个人政务网址导航工作流。宿主根据 `getConfig()` 动态匹配业务，工作流通过通用的 `{ key, input }` 参数读取 `BUSINESS_URLS` 中对应的配置并打开官方业务页面。

当前业务：

- `beijing-work-residence-permit`：查询、办理、续签、申请、变更北京工作居住证。
- `retirement-age-calculator`：根据出生日期计算退休年龄。

新增业务时，需要同步更新 `BUSINESS_URLS`、`workflow.json` 的输入与输出枚举、权限域名、激活示例和单元测试。

工作流只打开映射中的网址，不负责登录、填写、点击或提交页面表单。

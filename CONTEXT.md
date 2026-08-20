# AutoForge

AutoForge 是在受控权限下构建并运行本地工作流的桌面环境。

## Language

**HTTPS URL 模式**：
工作流声明浏览器访问范围的字符串模式；它可以包含主机和路径 glob，但只覆盖 HTTPS URL。运行时实际权限请求仍使用精确 origin。
_Avoid_: 通配 origin、正则权限


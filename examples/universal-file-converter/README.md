# 万象转换

“万象转换”是 AutoForge 的本地文件格式转换工作流。它接收聊天附件或开发者页面选择的文件，并将其转换为明确指定的目标格式；文件内容只在本机 Main 进程和受控转换组件中处理。

支持的目标格式：PNG、JPEG、WebP、AVIF、TIFF、BMP、GIF、ICO、ICNS、PDF、XLSX、MP3、WAV、M4A、AAC、FLAC、OGG、Opus、MP4、WebM、MOV。

首发平台为 macOS arm64 和 macOS x64。Windows 不在首发支持矩阵，生产转换入口会在读取发布元数据或访问网络索引前拒绝；仓库保留的 Windows signed-inventory 安全测试不代表 Windows 可发布或可运行。

仓库内默认 bootstrap 关闭组件下载且不携带生产根公钥。本地 fixture 通过不等于生产发布验收；正式启用仍需要生产 Ed25519 根、公 HTTPS 索引/CDN、八个 macOS pack 坐标、许可证审查、真实平台运行、签名与公证证据。

# 个人账簿 H5

一个基于原生 HTML、CSS 和 JavaScript 实现的移动端个人账簿原型，无需安装依赖或构建。

## 已实现功能

- 添加收入、支出账目，包含金额、日期、标签和可选备注
- 使用 Supabase Auth 完成邮箱注册、登录、会话恢复与退出
- 从 Supabase PostgreSQL 读取、新增和删除账目
- 已实现账目更新数据函数，为后续编辑界面预留
- 登录后可将旧版 `localStorage` 账目一次性迁移到当前账户
- 首页展示本月收入、支出、结余和最近明细
- 按日期范围、标签查询明细
- 按本周、本月、本年或自定义日期统计收支
- 按标签汇总，并用比例条展示
- 记账、查账、我的三页底部导航
- 深色模式及本地主题记忆
- 适配移动端安全区域，也支持桌面浏览器预览

## 运行方式

直接使用浏览器打开 `index.html` 即可。也可以在当前目录启动任意静态文件服务器，例如 VS Code Live Server。

## 文件结构

```text
├── index.html        页面结构
├── style.css         响应式界面与深色主题
├── app.js            认证、Supabase CRUD、迁移、查询与统计逻辑
├── 软件设计文档.md    功能与页面设计依据
└── 需求分析文档.md    项目需求依据
```

## 数据说明

账户由 Supabase Auth 管理，账目保存在 Supabase 的 `public.entries` 表。前端只使用 Publishable Key，数据隔离依赖已经启用的 Row Level Security（RLS）。`entries` 表需要包含以下字段：

`id`、`user_id`、`type`、`amount`、`entry_date`、`tag`、`note`、`created_at`、`updated_at`。

旧版本地账目只作为迁移源读取。用户登录后若检测到旧数据，页面会先询问是否迁移；只有批量写入 Supabase 全部成功后，才会删除 `personal-ledger.entries.v1` 中的旧数据。深色主题偏好仍保存在本地。

## Supabase 前置条件

- Authentication 已启用 Email 登录方式
- `public.entries` 已启用 RLS
- authenticated 用户只能查询、新增、修改和删除 `user_id = auth.uid()` 的记录
- 已为 `user_id, entry_date` 建立索引
- 本地开发时通过 Live Server 运行，并在 Authentication URL Configuration 中配置正确地址

找回密码和账目编辑界面尚未实现。

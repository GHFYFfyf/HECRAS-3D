# HECRAS-3D

## DeepSeek 水文标签判别接入

项目已接入 DeepSeek（OpenAI 兼容接口）用于水文标签判别，输入包含：

- 上游非恒定流量曲线（按 1 小时重采样）
- 项目空间范围中心点（原始坐标）
- 项目大致经纬度（自动转换为 EPSG:4326 的 `center_wgs84`）

### 1. 配置环境变量

复制 [`.env.example`](.env.example) 为 `.env`（或直接在 shell 导出变量），至少配置：

- `DEEPSEEK_API_KEY`

可选配置：

- `DEEPSEEK_MODEL`，默认 `deepseek-chat`
- `DEEPSEEK_BASE_URL`，默认 `https://api.deepseek.com`
- `HYDRO_SUMMARY_TEMPERATURE`，控制 AI 概括温度，默认 `0.65`
- `HYDRO_LABEL_DEFAULT_MODE`，可选 `rule` / `ai` / `hybrid`，默认 `hybrid`

说明：

- 也兼容旧变量：`HYDRO_LABEL_MODEL_API_KEY`、`HYDRO_LABEL_MODEL_NAME`、`HYDRO_LABEL_MODEL_BASE_URL`

### 2. 触发判别

#### 新建项目

创建项目后会自动执行一次标签判别，默认模式由 `HYDRO_LABEL_DEFAULT_MODE` 控制。

#### 手动重判

接口：`POST /api/projects/{project_id}/hydro-label/judge`

参数：

- `force`：是否强制重算
- `mode`：可选 `rule` / `ai` / `hybrid`，不传时使用默认模式

示例：

```bash
curl -X POST "http://127.0.0.1:8001/api/projects/1/hydro-label/judge?force=true&mode=ai"
```

返回里 `label_source` 可用于判断是否来自 AI（例如 `ai`）或规则回退（例如 `rule-fallback`）。
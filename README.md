# Digital Human - 实时语音数字人

基于火山引擎豆包端到端实时语音大模型，支持 LiveTalking 数字人渲染。

## 功能

- 实时语音对话（端到端，无需 ASR/TTS 分离）
- WebSocket 双向音频流
- 可选的 LiveTalking 数字人渲染集成

## 快速开始

### 1. 安装依赖

```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 填入你的火山引擎凭证：
- `DOUBAO_APP_ID` - 控制台 APP ID
- `DOUBAO_ACCESS_KEY` - 控制台 Access Token

### 3. 启动服务

```bash
python server.py
```

服务默认运行在 `ws://localhost:8888`

## 前端客户端

`s2s-client/` 目录包含 Web 前端，详见其中的说明。

## API

### WebSocket `/ws/chat`

- 发送：float32 PCM 音频 (24kHz)
- 接收：float32 PCM 音频 (24kHz) + JSON 状态消息

### HTTP `/health`

健康检查接口。

## LiveTalking 集成（可选）

在 `.env` 中配置：

```
LIVETALKING_ENABLED=true
LIVETALKING_URL=http://localhost:8010
LIVETALKING_SESSION_ID=0
```

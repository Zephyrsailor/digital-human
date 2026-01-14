"""
Doubao Realtime S2S Server
基于火山引擎端到端实时语音大模型
支持 LiveTalking 数字人渲染
"""
import asyncio
import logging
import json
import uuid
import os
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from doubao_engine import DoubaoRealtimeEngine, parse_response
from livetalking_bridge import LiveTalkingBridge

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("S2S-Server")

app = FastAPI(title="Doubao Realtime S2S Server")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 配置
FRONTEND_SAMPLE_RATE = 24000  # 前端采样率
DOUBAO_INPUT_SAMPLE_RATE = 16000  # 豆包输入采样率
DOUBAO_OUTPUT_SAMPLE_RATE = 24000  # 豆包输出采样率

# LiveTalking 配置
LIVETALKING_ENABLED = os.getenv("LIVETALKING_ENABLED", "false").lower() == "true"
LIVETALKING_URL = os.getenv("LIVETALKING_URL", "http://localhost:8010")
LIVETALKING_SESSION_ID = int(os.getenv("LIVETALKING_SESSION_ID", "0"))


def resample_audio(audio_data: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """重采样音频"""
    if from_rate == to_rate:
        return audio_data

    ratio = to_rate / from_rate
    new_length = int(len(audio_data) * ratio)

    # 简单线性插值重采样
    indices = np.linspace(0, len(audio_data) - 1, new_length)
    resampled = np.interp(indices, np.arange(len(audio_data)), audio_data)

    return resampled.astype(audio_data.dtype)


def float32_to_int16(audio_float32: np.ndarray) -> bytes:
    """将 float32 PCM 转换为 int16 PCM"""
    # 限幅到 [-1, 1]
    audio_clipped = np.clip(audio_float32, -1.0, 1.0)
    # 转换为 int16
    audio_int16 = (audio_clipped * 32767).astype(np.int16)
    return audio_int16.tobytes()


def int16_to_float32(audio_int16_bytes: bytes) -> np.ndarray:
    """将 int16 PCM 转换为 float32"""
    audio_int16 = np.frombuffer(audio_int16_bytes, dtype=np.int16)
    audio_float32 = audio_int16.astype(np.float32) / 32767.0
    return audio_float32


@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())
    logger.info(f"New connection: {session_id}")

    # 创建 Doubao 引擎
    engine = DoubaoRealtimeEngine()

    # LiveTalking 桥接（稍后根据客户端消息创建）
    livetalking_bridge = None
    livetalking_session_id = LIVETALKING_SESSION_ID  # 默认使用环境变量

    async def setup_livetalking(lt_session_id: int):
        """设置 LiveTalking 桥接"""
        nonlocal livetalking_bridge
        if livetalking_bridge:
            await livetalking_bridge.close()
        livetalking_bridge = LiveTalkingBridge(
            livetalking_url=LIVETALKING_URL,
            session_id=lt_session_id
        )
        await livetalking_bridge.connect()
        logger.info(f"[{session_id}] LiveTalking bridge connected, lt_session: {lt_session_id}")

    # 如果环境变量启用且有默认 session_id，立即创建桥接
    if LIVETALKING_ENABLED and LIVETALKING_SESSION_ID > 0:
        await setup_livetalking(LIVETALKING_SESSION_ID)

    try:
        # 连接到豆包服务
        await engine.connect()

        # 发送就绪状态
        await websocket.send_json({
            "type": "status",
            "message": "ready",
            "sessionId": session_id
        })

        # 如果 LiveTalking 未启用，直接问好；否则等待 bridge 设置后再问好
        if not LIVETALKING_ENABLED:
            await engine.say_hello()

        # 启动接收任务
        async def receive_from_doubao():
            """从豆包接收响应并转发给前端"""
            while engine.is_connected:
                try:
                    response = await engine.receive_response()
                    if response is None:
                        await asyncio.sleep(0.01)
                        continue

                    msg_type = response.get('message_type', '')
                    event = response.get('event', 0)
                    payload = response.get('payload_msg')

                    # 处理音频数据
                    if msg_type == 'SERVER_ACK' and isinstance(payload, bytes):
                        # 豆包返回的是 float32 PCM 24kHz，直接转发给前端
                        await websocket.send_bytes(payload)

                        # 同时转发给 LiveTalking 进行数字人渲染
                        if livetalking_bridge:
                            await livetalking_bridge.send_audio(payload)

                    # 处理状态事件
                    elif msg_type == 'SERVER_FULL_RESPONSE':
                        if event == 450:  # 用户开始说话，清空播放缓存
                            await websocket.send_json({
                                "type": "status",
                                "message": "user_speaking"
                            })
                            # 通知 LiveTalking 中断当前播放
                            if livetalking_bridge:
                                await livetalking_bridge.interrupt()

                        elif event == 459:  # 用户说话结束
                            await websocket.send_json({
                                "type": "status",
                                "message": "processing"
                            })
                        elif event == 359:  # TTS 结束
                            await websocket.send_json({
                                "type": "status",
                                "message": "done"
                            })
                            # 刷新 LiveTalking 缓冲区
                            if livetalking_bridge:
                                await livetalking_bridge.flush()

                        elif event in [152, 153]:  # 会话结束
                            logger.info(f"[{session_id}] Session finished")
                            break

                    elif msg_type == 'SERVER_ERROR':
                        logger.error(f"[{session_id}] Server error: {payload}")
                        await websocket.send_json({
                            "type": "error",
                            "message": str(payload)
                        })

                except Exception as e:
                    logger.error(f"[{session_id}] Receive error: {e}")
                    break

        # 启动后台接收任务
        receive_task = asyncio.create_task(receive_from_doubao())

        # 主循环：接收前端音频并转发
        try:
            while True:
                message = await websocket.receive()

                if "bytes" in message:
                    # 收到音频数据
                    audio_bytes = message["bytes"]

                    # Debug: 打印收到的音频数据大小
                    if len(audio_bytes) > 0:
                        logger.debug(f"[{session_id}] Received audio: {len(audio_bytes)} bytes")

                    # 前端发送的是 float32 24kHz
                    audio_float32 = np.frombuffer(audio_bytes, dtype=np.float32)

                    # 重采样到 16kHz
                    audio_resampled = resample_audio(
                        audio_float32,
                        FRONTEND_SAMPLE_RATE,
                        DOUBAO_INPUT_SAMPLE_RATE
                    )

                    # 转换为 int16 (豆包需要 16bit PCM)
                    audio_int16_bytes = float32_to_int16(audio_resampled)

                    # 发送给豆包
                    await engine.send_audio(audio_int16_bytes)

                elif "text" in message:
                    # 处理控制消息
                    try:
                        data = json.loads(message["text"])
                        cmd = data.get("command")

                        if cmd == "clear_history":
                            # 重新连接以清除历史
                            await engine.close()
                            await engine.connect()
                            await websocket.send_json({
                                "type": "status",
                                "message": "history_cleared"
                            })

                        elif cmd == "interrupt":
                            # 发送中断信号
                            if livetalking_bridge:
                                await livetalking_bridge.interrupt()

                        elif cmd == "set_livetalking_session":
                            # 设置 LiveTalking session ID
                            lt_session_id = data.get("sessionId", 0)
                            if lt_session_id > 0:
                                await setup_livetalking(lt_session_id)
                                await websocket.send_json({
                                    "type": "status",
                                    "message": "livetalking_ready",
                                    "sessionId": lt_session_id
                                })
                                # Bridge 设置好后再主动问好
                                await engine.say_hello()

                    except json.JSONDecodeError:
                        pass

        except WebSocketDisconnect:
            logger.info(f"Client disconnected: {session_id}")
        finally:
            receive_task.cancel()
            try:
                await receive_task
            except asyncio.CancelledError:
                pass

    except Exception as e:
        logger.error(f"[{session_id}] Error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except:
            pass

    finally:
        await engine.close()
        if livetalking_bridge:
            await livetalking_bridge.close()
        try:
            await websocket.close()
        except:
            pass


@app.get("/health")
async def health_check():
    return {"status": "ok", "engine": "doubao-realtime"}


if __name__ == "__main__":
    import os
    ssl_keyfile = "./ssl/server.key"
    ssl_certfile = "./ssl/server.crt"

    if os.path.exists(ssl_keyfile) and os.path.exists(ssl_certfile):
        logger.info("Starting with SSL (wss://)")
        uvicorn.run(app, host="0.0.0.0", port=8888,
                    ssl_keyfile=ssl_keyfile, ssl_certfile=ssl_certfile)
    else:
        logger.info("Starting without SSL (ws://)")
        uvicorn.run(app, host="0.0.0.0", port=8888)

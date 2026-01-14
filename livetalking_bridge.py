"""
LiveTalking Bridge
将 S2S 音频流桥接到 LiveTalking 进行数字人渲染
"""
import asyncio
import aiohttp
import numpy as np
from typing import Optional
import resampy
import struct
import logging

logger = logging.getLogger("LiveTalkingBridge")


class LiveTalkingBridge:
    """
    将音频数据发送到 LiveTalking 服务进行数字人渲染
    使用 HTTP POST 发送流式音频块
    """

    def __init__(
        self,
        livetalking_url: str = "http://localhost:8010",
        session_id: int = 0,
    ):
        self.livetalking_url = livetalking_url.rstrip("/")
        self.session_id = session_id
        self.session: Optional[aiohttp.ClientSession] = None
        self.is_connected = False

        # 音频配置
        self.input_sample_rate = 24000  # S2S 输出采样率 (豆包返回 24kHz float32)
        self.output_sample_rate = 16000  # LiveTalking 需要的采样率
        self.chunk_samples = 320  # 20ms @ 16kHz

        # 音频缓冲区（用于分块）
        self.audio_buffer = np.array([], dtype=np.float32)

    async def connect(self) -> bool:
        """连接到 LiveTalking 服务"""
        try:
            self.session = aiohttp.ClientSession()
            # LiveTalking 没有 /health 端点，尝试 /is_speaking 或直接假设可用
            logger.info(f"[LiveTalkingBridge] Ready to send to {self.livetalking_url}")
            self.is_connected = True
            return True
        except Exception as e:
            logger.error(f"[LiveTalkingBridge] Connection failed: {e}")
            return False

    async def send_audio(self, audio_data: bytes) -> None:
        """
        发送音频数据到 LiveTalking

        Args:
            audio_data: 24kHz float32 PCM 音频数据 (从豆包返回的格式)
        """
        if not self.session or not self.is_connected:
            return

        # 解析输入音频 (24kHz float32)
        audio_float32 = np.frombuffer(audio_data, dtype=np.float32)

        if len(audio_float32) == 0:
            return

        # 重采样到 16kHz
        audio_16k = resampy.resample(audio_float32, self.input_sample_rate, self.output_sample_rate)

        # 添加到缓冲区
        self.audio_buffer = np.concatenate([self.audio_buffer, audio_16k])

        # 分块发送 (每块 320 samples = 20ms @ 16kHz)
        while len(self.audio_buffer) >= self.chunk_samples:
            chunk = self.audio_buffer[:self.chunk_samples]
            self.audio_buffer = self.audio_buffer[self.chunk_samples:]

            # 发送到 LiveTalking
            await self._send_chunk(chunk)

    async def _send_chunk(self, chunk: np.ndarray) -> None:
        """发送单个音频块到 LiveTalking 的 /audiostream 接口"""
        if not self.session:
            return

        try:
            # LiveTalking put_audio_frame 需要 float32 数据
            chunk_bytes = chunk.astype(np.float32).tobytes()

            # POST 到 LiveTalking 的流式音频接口
            async with self.session.post(
                f"{self.livetalking_url}/audiostream",
                data=chunk_bytes,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Session-ID": str(self.session_id),
                }
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning(f"[LiveTalkingBridge] Send audio failed: {resp.status} - {text}")

        except Exception as e:
            logger.error(f"[LiveTalkingBridge] Send audio error: {e}")

    async def flush(self) -> None:
        """刷新缓冲区中剩余的音频"""
        if len(self.audio_buffer) > 0:
            # 补零到完整的 chunk
            padding = self.chunk_samples - len(self.audio_buffer)
            if padding > 0:
                self.audio_buffer = np.concatenate([
                    self.audio_buffer,
                    np.zeros(padding, dtype=np.float32)
                ])
            await self._send_chunk(self.audio_buffer)
            self.audio_buffer = np.array([], dtype=np.float32)

    async def interrupt(self) -> None:
        """中断当前播放（用户开始说话时调用）"""
        if not self.session or not self.is_connected:
            return

        try:
            async with self.session.post(
                f"{self.livetalking_url}/interrupt_talk",
                json={"sessionid": self.session_id}
            ) as resp:
                if resp.status == 200:
                    logger.info("[LiveTalkingBridge] Interrupted playback")
        except Exception as e:
            logger.error(f"[LiveTalkingBridge] Interrupt error: {e}")

        # 清空缓冲区
        self.audio_buffer = np.array([], dtype=np.float32)

    async def close(self) -> None:
        """关闭连接"""
        self.is_connected = False
        if self.session:
            await self.session.close()
            self.session = None
        logger.info("[LiveTalkingBridge] Connection closed")


class LiveTalkingWebSocketBridge:
    """
    通过 WebSocket 连接 LiveTalking（更低延迟）
    """

    def __init__(
        self,
        livetalking_ws_url: str = "ws://localhost:8010/ws/audio",
        session_id: int = 0,
    ):
        self.ws_url = livetalking_ws_url
        self.session_id = session_id
        self.ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self.session: Optional[aiohttp.ClientSession] = None

        # 音频配置
        self.input_sample_rate = 24000
        self.output_sample_rate = 16000
        self.chunk_samples = 320

        self.audio_buffer = np.array([], dtype=np.float32)

    async def connect(self) -> bool:
        """建立 WebSocket 连接"""
        try:
            self.session = aiohttp.ClientSession()
            self.ws = await self.session.ws_connect(
                self.ws_url,
                headers={"X-Session-ID": str(self.session_id)}
            )
            logger.info(f"[LiveTalkingBridge] WebSocket connected to {self.ws_url}")
            return True
        except Exception as e:
            logger.error(f"[LiveTalkingBridge] WebSocket connection failed: {e}")
            return False

    async def send_audio(self, audio_data: bytes) -> None:
        """发送音频数据"""
        if not self.ws:
            return

        audio_float32 = np.frombuffer(audio_data, dtype=np.float32)

        if len(audio_float32) > 0:
            audio_16k = resampy.resample(audio_float32, self.input_sample_rate, self.output_sample_rate)
            self.audio_buffer = np.concatenate([self.audio_buffer, audio_16k])

            while len(self.audio_buffer) >= self.chunk_samples:
                chunk = self.audio_buffer[:self.chunk_samples]
                self.audio_buffer = self.audio_buffer[self.chunk_samples:]

                chunk_bytes = chunk.astype(np.float32).tobytes()
                await self.ws.send_bytes(chunk_bytes)

    async def interrupt(self) -> None:
        """中断当前播放"""
        if self.ws:
            await self.ws.send_json({"type": "interrupt"})
        self.audio_buffer = np.array([], dtype=np.float32)

    async def close(self) -> None:
        """关闭连接"""
        if self.ws:
            await self.ws.close()
        if self.session:
            await self.session.close()
        logger.info("[LiveTalkingBridge] WebSocket closed")

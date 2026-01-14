"""
Doubao Realtime Dialog Engine
基于火山引擎端到端实时语音大模型 SDK
"""
import os
import gzip
import json
import uuid
import asyncio
import queue
import struct
from typing import AsyncGenerator, Optional, Dict, Any, List
from dataclasses import dataclass

import websockets

# Load .env file
try:
    from dotenv import load_dotenv
    from pathlib import Path

    # 尝试从当前目录和脚本目录加载 .env
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
        print(f"[DoubaoEngine] Loaded .env from {env_path}")
    else:
        load_dotenv()  # 尝试默认路径
        print("[DoubaoEngine] Loaded .env from default path")
except ImportError:
    print("[DoubaoEngine] python-dotenv not installed, using environment variables directly")

# Protocol constants
PROTOCOL_VERSION = 0b0001
DEFAULT_HEADER_SIZE = 0b0001

# Message Types
CLIENT_FULL_REQUEST = 0b0001
CLIENT_AUDIO_ONLY_REQUEST = 0b0010
SERVER_FULL_RESPONSE = 0b1001
SERVER_ACK = 0b1011
SERVER_ERROR_RESPONSE = 0b1111

# Message Type Specific Flags
NO_SEQUENCE = 0b0000
POS_SEQUENCE = 0b0001
NEG_SEQUENCE = 0b0010
MSG_WITH_EVENT = 0b0100

# Message Serialization
NO_SERIALIZATION = 0b0000
JSON_SERIALIZATION = 0b0001
GZIP_COMPRESSION = 0b0001

# Event codes
EVENT_START_CONNECTION = 1
EVENT_FINISH_CONNECTION = 2
EVENT_START_SESSION = 100
EVENT_FINISH_SESSION = 102
EVENT_TASK_REQUEST = 200
EVENT_SAY_HELLO = 300
EVENT_TTS_RESPONSE = 350
EVENT_TTS_ENDED = 359
EVENT_CLEAR_AUDIO = 450
EVENT_USER_SPEECH_ENDED = 459
EVENT_CHAT_TEXT_QUERY = 501
EVENT_SESSION_FINISHED = 152
EVENT_SESSION_FINISHED_2 = 153


def generate_header(
    message_type=CLIENT_FULL_REQUEST,
    message_type_specific_flags=MSG_WITH_EVENT,
    serial_method=JSON_SERIALIZATION,
    compression_type=GZIP_COMPRESSION,
):
    """生成协议头"""
    header = bytearray()
    header_size = 1
    header.append((PROTOCOL_VERSION << 4) | header_size)
    header.append((message_type << 4) | message_type_specific_flags)
    header.append((serial_method << 4) | compression_type)
    header.append(0x00)  # reserved
    return header


def parse_response(res):
    """解析服务器响应"""
    if isinstance(res, str):
        return {}

    protocol_version = res[0] >> 4
    header_size = res[0] & 0x0f
    message_type = res[1] >> 4
    message_type_specific_flags = res[1] & 0x0f
    serialization_method = res[2] >> 4
    message_compression = res[2] & 0x0f

    payload = res[header_size * 4:]
    result = {}
    payload_msg = None
    start = 0

    if message_type == SERVER_FULL_RESPONSE or message_type == SERVER_ACK:
        result['message_type'] = 'SERVER_FULL_RESPONSE' if message_type == SERVER_FULL_RESPONSE else 'SERVER_ACK'

        if message_type_specific_flags & NEG_SEQUENCE > 0:
            result['seq'] = int.from_bytes(payload[:4], "big", signed=False)
            start += 4
        if message_type_specific_flags & MSG_WITH_EVENT > 0:
            result['event'] = int.from_bytes(payload[:4], "big", signed=False)
            start += 4

        payload = payload[start:]
        session_id_size = int.from_bytes(payload[:4], "big", signed=True)
        session_id = payload[4:session_id_size+4]
        result['session_id'] = str(session_id)
        payload = payload[4 + session_id_size:]
        payload_size = int.from_bytes(payload[:4], "big", signed=False)
        payload_msg = payload[4:]

    elif message_type == SERVER_ERROR_RESPONSE:
        code = int.from_bytes(payload[:4], "big", signed=False)
        result['code'] = code
        result['message_type'] = 'SERVER_ERROR'
        payload_size = int.from_bytes(payload[4:8], "big", signed=False)
        payload_msg = payload[8:]

    if payload_msg is None:
        return result

    # 解压缩（仅当标记为GZIP时）
    if message_compression == GZIP_COMPRESSION:
        payload_msg = gzip.decompress(payload_msg)

    # 反序列化
    if serialization_method == JSON_SERIALIZATION:
        payload_msg = json.loads(str(payload_msg, "utf-8"))
    elif serialization_method == NO_SERIALIZATION:
        # 保持原始二进制数据（音频数据）
        pass
    else:
        payload_msg = str(payload_msg, "utf-8")

    result['payload_msg'] = payload_msg
    return result


class DoubaoRealtimeEngine:
    """豆包端到端实时语音对话引擎"""

    def __init__(
        self,
        app_id: Optional[str] = None,
        access_key: Optional[str] = None,
        speaker: str = "zh_female_xiaohe_jupiter_bigtts",  # 使用女声
        bot_name: str = "小金",
        system_role: str = "你是上海海纳金赋水的AI客服小金，声音甜美亲切，性格热情友好。你的职责是为客户提供优质的咨询服务，回答要简洁专业，语气温和有礼。",
        greeting: str = "您好，我是上海海纳金赋水的小金，很高兴为您服务，请问有什么可以帮您的？",
    ):
        self.app_id = app_id or os.getenv("DOUBAO_APP_ID", "")
        self.access_key = access_key or os.getenv("DOUBAO_ACCESS_KEY", "")
        self.speaker = speaker
        self.bot_name = bot_name
        self.system_role = system_role
        self.greeting = greeting

        self.base_url = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
        self.ws = None
        self.session_id = ""
        self.is_connected = False

        # 音频配置
        self.input_sample_rate = 16000  # 输入 16kHz
        self.output_sample_rate = 24000  # 输出 24kHz

        print(f"[DoubaoEngine] Initialized with speaker: {speaker}")

    def _get_headers(self) -> Dict[str, str]:
        """获取 WebSocket 连接头"""
        return {
            "X-Api-App-ID": self.app_id,
            "X-Api-Access-Key": self.access_key,
            "X-Api-Resource-Id": "volc.speech.dialog",
            "X-Api-App-Key": "PlgvMymc7f3tQnJ6",
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }

    def _get_session_config(self) -> Dict[str, Any]:
        """获取会话配置"""
        return {
            "asr": {
                "extra": {
                    "end_smooth_window_ms": 1500,
                },
            },
            "tts": {
                "speaker": self.speaker,
                "audio_config": {
                    "channel": 1,
                    "format": "pcm",
                    "sample_rate": self.output_sample_rate
                },
            },
            "dialog": {
                "bot_name": self.bot_name,
                "system_role": self.system_role,
                "speaking_style": "说话风格简洁明了，语速适中，语调自然。",
                "location": {
                    "city": "北京",
                },
                "extra": {
                    "strict_audit": False,
                    "recv_timeout": 120,  # 增加到120秒
                    "input_mod": "audio"
                }
            }
        }

    async def connect(self) -> None:
        """建立 WebSocket 连接"""
        self.session_id = str(uuid.uuid4())
        headers = self._get_headers()

        # Debug: 打印凭证（部分隐藏）
        app_id = headers.get("X-Api-App-ID", "")
        access_key = headers.get("X-Api-Access-Key", "")
        print(f"[DoubaoEngine] App-ID: {app_id[:8]}...{app_id[-4:] if len(app_id) > 12 else app_id}")
        print(f"[DoubaoEngine] Access-Key: {access_key[:8]}...{access_key[-4:] if len(access_key) > 12 else access_key}")
        print(f"[DoubaoEngine] Connecting to {self.base_url}")
        self.ws = await websockets.connect(
            self.base_url,
            extra_headers=headers,
            ping_interval=None
        )

        logid = self.ws.response_headers.get("X-Tt-Logid", "")
        print(f"[DoubaoEngine] Connected, logid: {logid}")

        # StartConnection
        await self._send_start_connection()
        response = await self.ws.recv()
        print(f"[DoubaoEngine] StartConnection response: {parse_response(response)}")

        # StartSession
        await self._send_start_session()
        response = await self.ws.recv()
        print(f"[DoubaoEngine] StartSession response: {parse_response(response)}")

        self.is_connected = True

    async def _send_start_connection(self) -> None:
        """发送 StartConnection 请求"""
        request = bytearray(generate_header())
        request.extend(int(EVENT_START_CONNECTION).to_bytes(4, 'big'))
        payload_bytes = gzip.compress(b'{}')
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)
        await self.ws.send(request)

    async def _send_start_session(self) -> None:
        """发送 StartSession 请求"""
        config = self._get_session_config()
        payload_bytes = gzip.compress(json.dumps(config).encode())

        request = bytearray(generate_header())
        request.extend(int(EVENT_START_SESSION).to_bytes(4, 'big'))
        request.extend(len(self.session_id).to_bytes(4, 'big'))
        request.extend(self.session_id.encode())
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)
        await self.ws.send(request)

    async def say_hello(self) -> None:
        """发送问候语，让AI主动开口"""
        if not self.ws or not self.is_connected:
            return

        payload = {
            "content": self.greeting,
        }
        request = bytearray(generate_header())
        request.extend(int(300).to_bytes(4, 'big'))  # EVENT_SAY_HELLO

        payload_bytes = gzip.compress(json.dumps(payload).encode())
        request.extend(len(self.session_id).to_bytes(4, 'big'))
        request.extend(self.session_id.encode())
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)

        await self.ws.send(request)
        print(f"[DoubaoEngine] Say hello: {self.greeting}")

    async def send_audio(self, audio_bytes: bytes) -> None:
        """发送音频数据"""
        if not self.ws or not self.is_connected:
            return

        request = bytearray(generate_header(
            message_type=CLIENT_AUDIO_ONLY_REQUEST,
            serial_method=NO_SERIALIZATION
        ))
        request.extend(int(EVENT_TASK_REQUEST).to_bytes(4, 'big'))
        request.extend(len(self.session_id).to_bytes(4, 'big'))
        request.extend(self.session_id.encode())

        payload_bytes = gzip.compress(audio_bytes)
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)

        await self.ws.send(request)

    async def receive_response(self) -> Optional[Dict[str, Any]]:
        """接收服务器响应"""
        if not self.ws:
            return None
        try:
            response = await asyncio.wait_for(self.ws.recv(), timeout=0.1)
            return parse_response(response)
        except asyncio.TimeoutError:
            return None
        except Exception as e:
            print(f"[DoubaoEngine] Receive error: {e}")
            return None

    async def finish_session(self) -> None:
        """结束会话"""
        if not self.ws:
            return

        request = bytearray(generate_header())
        request.extend(int(EVENT_FINISH_SESSION).to_bytes(4, 'big'))
        payload_bytes = gzip.compress(b'{}')
        request.extend(len(self.session_id).to_bytes(4, 'big'))
        request.extend(self.session_id.encode())
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)
        await self.ws.send(request)

    async def finish_connection(self) -> None:
        """结束连接"""
        if not self.ws:
            return

        request = bytearray(generate_header())
        request.extend(int(EVENT_FINISH_CONNECTION).to_bytes(4, 'big'))
        payload_bytes = gzip.compress(b'{}')
        request.extend(len(payload_bytes).to_bytes(4, 'big'))
        request.extend(payload_bytes)
        await self.ws.send(request)

    async def close(self) -> None:
        """关闭连接"""
        self.is_connected = False
        if self.ws:
            try:
                await self.finish_session()
                await self.finish_connection()
            except:
                pass
            await self.ws.close()
            self.ws = None
        print("[DoubaoEngine] Connection closed")


class DoubaoSessionManager:
    """管理多个用户会话的 Doubao 引擎"""

    def __init__(self):
        self.sessions: Dict[str, DoubaoRealtimeEngine] = {}

    async def create_session(
        self,
        session_id: str,
        speaker: str = "zh_male_yunzhou_jupiter_bigtts",
        system_role: str = "你是一个有帮助的AI助手，回答简洁明了。",
    ) -> DoubaoRealtimeEngine:
        """为用户创建新会话"""
        engine = DoubaoRealtimeEngine(
            speaker=speaker,
            system_role=system_role,
        )
        await engine.connect()
        self.sessions[session_id] = engine
        return engine

    def get_session(self, session_id: str) -> Optional[DoubaoRealtimeEngine]:
        """获取现有会话"""
        return self.sessions.get(session_id)

    async def close_session(self, session_id: str) -> None:
        """关闭并移除会话"""
        if session_id in self.sessions:
            await self.sessions[session_id].close()
            del self.sessions[session_id]

    async def close_all(self) -> None:
        """关闭所有会话"""
        for session_id in list(self.sessions.keys()):
            await self.close_session(session_id)

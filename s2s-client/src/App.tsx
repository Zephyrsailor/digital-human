import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioManager } from './utils/audio-manager';
import type { ConnectionStatus } from './utils/audio-manager';
import { LiveTalkingWebRTC } from './utils/livetalking-webrtc';
import { useTransparentVideo } from './hooks/useTransparentVideo';
import './index.css';

// LiveTalking 配置 (通过环境变量)
const LIVETALKING_ENABLED = import.meta.env.VITE_LIVETALKING_ENABLED === 'true';
const LIVETALKING_URL = import.meta.env.VITE_LIVETALKING_URL || 'http://localhost:8010';

// SVG Icons
const PhoneIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
    <path fillRule="evenodd" d="M1.5 4.5a3 3 0 013-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 01-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 006.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 011.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 01-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5z" clipRule="evenodd" />
  </svg>
);

const HangUpIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
    <path d="M1.5 12c0-1.467.37-2.85 1.02-4.06.122-.227.37-.344.612-.264l3.464 1.155c.244.081.39.323.347.575-.24 1.384-.24 2.804 0 4.188.043.252-.103.494-.347.575l-3.464 1.155c-.242.08-.49-.037-.612-.264A9.96 9.96 0 011.5 12zm19.98-4.06c.65 1.21 1.02 2.593 1.02 4.06 0 1.467-.37 2.85-1.02 4.06-.122.227-.37.344-.612.264l-3.464-1.155a.474.474 0 01-.347-.575c.24-1.384.24-2.804 0-4.188a.474.474 0 01.347-.575l3.464-1.155c.242-.08.49.037.612.264zM12 4.5c1.467 0 2.85.37 4.06 1.02.227.122.344.37.264.612l-1.155 3.464a.474.474 0 01-.575.347 8.067 8.067 0 00-4.188 0 .474.474 0 01-.575-.347L8.676 6.132c-.08-.242.037-.49.264-.612A9.96 9.96 0 0112 4.5z" />
    <path d="M12 15a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0112 15zm-3.75 1.5a.75.75 0 01.75.75v3a.75.75 0 01-1.5 0v-3a.75.75 0 01.75-.75zm7.5 0a.75.75 0 01.75.75v3a.75.75 0 01-1.5 0v-3a.75.75 0 01.75-.75z" />
  </svg>
);

const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
    <path d="M8.25 4.5a3.75 3.75 0 117.5 0v8.25a3.75 3.75 0 11-7.5 0V4.5z" />
    <path d="M6 10.5a.75.75 0 01.75.75v1.5a5.25 5.25 0 1010.5 0v-1.5a.75.75 0 011.5 0v1.5a6.751 6.751 0 01-6 6.709v2.291h3a.75.75 0 010 1.5h-7.5a.75.75 0 010-1.5h3v-2.291a6.751 6.751 0 01-6-6.709v-1.5A.75.75 0 016 10.5z" />
  </svg>
);

const MicOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
    <path d="M8.25 4.5a3.75 3.75 0 017.5 0v.847l-7.5 5.625V4.5z" />
    <path d="M3.22 3.22a.75.75 0 011.06 0l16.5 16.5a.75.75 0 11-1.06 1.06l-3.09-3.09a6.73 6.73 0 01-3.88 1.27v2.29h3a.75.75 0 010 1.5h-7.5a.75.75 0 010-1.5h3v-2.29a6.751 6.751 0 01-6-6.71v-1.5a.75.75 0 011.5 0v1.5a5.25 5.25 0 007.31 4.82l-1.42-1.42a3.75 3.75 0 01-4.39-3.65V9.97L3.22 4.28a.75.75 0 010-1.06z" />
    <path d="M16.5 10.5a.75.75 0 01.75.75v1.5a5.23 5.23 0 01-.67 2.56l-1.09-1.09c.17-.46.26-.95.26-1.47v-1.5a.75.75 0 01.75-.75z" />
  </svg>
);

const SpeakerIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
    <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 001.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06zM18.584 5.106a.75.75 0 011.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 11-1.06-1.06 8.25 8.25 0 000-11.668.75.75 0 010-1.06z" />
    <path d="M15.932 7.757a.75.75 0 011.061 0 6 6 0 010 8.486.75.75 0 01-1.06-1.061 4.5 4.5 0 000-6.364.75.75 0 010-1.06z" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
    <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 001.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06zM17.78 9.22a.75.75 0 10-1.06 1.06L18.44 12l-1.72 1.72a.75.75 0 001.06 1.06l1.72-1.72 1.72 1.72a.75.75 0 101.06-1.06L20.56 12l1.72-1.72a.75.75 0 00-1.06-1.06l-1.72 1.72-1.72-1.72z" />
  </svg>
);

// 音频波形动画组件
const AudioWaveform = () => (
  <div className="flex items-end justify-center gap-1 h-8">
    {[0, 1, 2, 3].map((i) => (
      <div
        key={i}
        className="w-1.5 bg-white rounded-full animate-pulse"
        style={{
          height: '100%',
          animation: `waveform 0.8s ease-in-out infinite`,
          animationDelay: `${i * 0.15}s`,
        }}
      />
    ))}
    <style>{`
      @keyframes waveform {
        0%, 100% { transform: scaleY(0.3); }
        50% { transform: scaleY(1); }
      }
    `}</style>
  </div>
);

function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [audioManager, setAudioManager] = useState<AudioManager | null>(null);
  const [micActive, setMicActive] = useState(true);
  const [speakerActive, setSpeakerActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // LiveTalking 状态
  const [liveTalkingConnected, setLiveTalkingConnected] = useState(false);
  const liveTalkingRef = useRef<LiveTalkingWebRTC | null>(null);

  // WebGL 透明视频渲染
  const {
    canvasRef,
    videoRef,
    isWebGLActive,
    isSideBySide,
    startRendering,
    stopRendering,
  } = useTransparentVideo({
    enabled: LIVETALKING_ENABLED,
  });

  const handleStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  const handleAudioActivity = useCallback(() => {
    // 可以用于显示音频活动指示
  }, []);

  const handleError = useCallback((err: string) => {
    setError(err);
    setTimeout(() => setError(null), 5000);
  }, []);

  // 组件卸载时清理（只在卸载时执行，不依赖任何状态）
  useEffect(() => {
    return () => {
      // 注意：这里使用 ref 而不是 state，因为 cleanup 在卸载时需要访问最新值
      liveTalkingRef.current?.close();
    };
  }, []); // 空依赖，只在组件卸载时执行

  const startCall = async () => {
    setConnectionStatus('connecting');
    setError(null);

    let liveTalkingSessionId = 0;

    // 如果启用了 LiveTalking，先建立 WebRTC 连接获取视频
    if (LIVETALKING_ENABLED) {
      try {
        const livetalking = new LiveTalkingWebRTC({
          serverUrl: LIVETALKING_URL,
          onVideoTrack: (stream) => {
            console.log('[App] Received video stream');
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play().then(() => {
                // 视频开始播放后启动 WebGL 渲染
                startRendering();
              }).catch(console.error);
            }
          },
          onAudioTrack: () => {
            // LiveTalking 的音频我们不播放，因为我们用 S2S 的音频
            console.log('[App] Received audio track (ignored, using S2S audio)');
          },
          onConnectionStateChange: (state) => {
            console.log('[App] LiveTalking state:', state);
            setLiveTalkingConnected(state === 'connected');
          },
          onError: (err) => {
            console.error('[App] LiveTalking error:', err);
          }
        });

        liveTalkingSessionId = await livetalking.connect();
        liveTalkingRef.current = livetalking;
        console.log('[App] LiveTalking connected, sessionId:', liveTalkingSessionId);
      } catch (e) {
        console.error('[App] LiveTalking connection failed:', e);
        // LiveTalking 连接失败不阻止 S2S 连接
      }
    }

    const manager = new AudioManager({
      onStatusChange: handleStatusChange,
      onAudioActivity: handleAudioActivity,
      onError: handleError,
    });

    try {
      const wsHost = import.meta.env.VITE_WS_HOST || window.location.hostname;
      const wsPort = import.meta.env.VITE_WS_PORT || '8888';
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      await manager.initialize(`${wsProtocol}://${wsHost}:${wsPort}/ws/chat`);

      // 如果有 LiveTalking session，通知服务器
      if (liveTalkingSessionId > 0) {
        manager.setLiveTalkingSession(liveTalkingSessionId);
      }

      await manager.startRecording();
      setAudioManager(manager);
    } catch (e) {
      console.error(e);
      setError('连接失败，请检查服务是否运行');
      setConnectionStatus('disconnected');
    }
  };

  const endCall = () => {
    audioManager?.stop();
    setAudioManager(null);
    setConnectionStatus('disconnected');

    // 停止 WebGL 渲染
    stopRendering();

    // 关闭 LiveTalking 连接
    if (liveTalkingRef.current) {
      liveTalkingRef.current.close();
      liveTalkingRef.current = null;
    }
    setLiveTalkingConnected(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const toggleMic = () => {
    if (!audioManager) return;

    if (micActive) {
      audioManager.stopRecording();
    } else {
      audioManager.resumeRecording();
    }
    setMicActive(!micActive);
  };

  const toggleSpeaker = () => {
    // TODO: 实现静音功能
    setSpeakerActive(!speakerActive);
  };

  const isConnected = connectionStatus === 'ready' || connectionStatus === 'processing';
  const isRinging = connectionStatus === 'disconnected' || connectionStatus === 'connecting';

  return (
    <div className="flex flex-col items-center justify-center min-h-screen w-screen bg-gradient-to-br from-[#2a1f3d] via-[#1a1525] to-[#0d0a12] text-white relative overflow-hidden font-sans">
      {/* 背景模糊效果 */}
      <div className="absolute inset-0 bg-[url('/avatar.png')] bg-center bg-cover opacity-20 blur-3xl scale-110" />

      {/* Error Toast */}
      {error && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 bg-red-500/90 text-white px-6 py-3 rounded-xl shadow-lg">
          {error}
        </div>
      )}

      {/* 主内容 */}
      <div className="relative z-10 flex flex-col items-center justify-center flex-1 w-full max-w-lg px-6">

        {/* 状态提示 - 仅在来电时显示 */}
        {isRinging && (
          <div className="mb-6 text-center">
            <p className="text-lg text-gray-300">
              {connectionStatus === 'connecting' ? '正在连接...' : '邀请你语音通话...'}
            </p>
          </div>
        )}

        {/* 头像/视频 */}
        <div className="mb-4">
          <div className={`relative transition-all duration-500 ${isConnected ? 'scale-100' : 'scale-95'}`}>
            {/* LiveTalking 数字人 - 隐藏的视频源 */}
            {LIVETALKING_ENABLED && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="hidden"
              />
            )}

            {/* WebGL Canvas 显示透明视频 - 始终渲染，通过 display 控制显示 */}
            {LIVETALKING_ENABLED && (
              <canvas
                ref={canvasRef}
                className="w-72 h-72 rounded-2xl shadow-2xl"
                style={{
                  background: 'transparent',
                  display: isWebGLActive ? 'block' : 'none',
                }}
              />
            )}

            {/* 静态头像 (LiveTalking 未连接或 WebGL 未激活时显示) */}
            {(!LIVETALKING_ENABLED || !isWebGLActive) && (
              <img
                src="/avatar.png"
                alt="小金"
                className="w-36 h-36 rounded-2xl object-cover shadow-2xl border-2 border-white/20"
              />
            )}

            {connectionStatus === 'processing' && (
              <div className="absolute inset-0 rounded-2xl border-2 border-white/50 animate-ping" />
            )}

            {/* 状态叠加层 - 正在回复，可打断 */}
            {isConnected && connectionStatus === 'processing' && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/40 backdrop-blur-sm px-4 py-2 rounded-lg">
                <span className="text-base text-white/80">说话或点击打断</span>
              </div>
            )}

            {/* 调试信息 */}
            {LIVETALKING_ENABLED && isWebGLActive && (
              <div className="absolute bottom-2 right-2 text-xs text-white/50 bg-black/30 px-1 rounded">
                {isSideBySide ? 'Alpha' : 'RGB'}
              </div>
            )}
          </div>
        </div>

        {/* 名字 */}
        <h2 className="text-2xl font-medium mb-6">小金</h2>

        {/* 状态提示 - 在名字和按钮之间 */}
        {isConnected && (
          <div className="flex flex-col items-center gap-2 mb-8">
            {connectionStatus === 'ready' && (
              <>
                <AudioWaveform />
                <span className="text-sm text-white/70">正在听...</span>
              </>
            )}
            {connectionStatus === 'processing' && (
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部控制栏 */}
      <div className="relative z-10 w-full max-w-lg px-6 pb-12">
        {isRinging ? (
          /* 未接通状态：挂断 + 接听 */
          <div className="flex items-center justify-between px-8">
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => window.close()}
                className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500 hover:bg-red-400 transition-all shadow-lg active:scale-95"
              >
                <HangUpIcon />
              </button>
              <span className="text-sm text-gray-400">挂断</span>
            </div>

            <div className="flex flex-col items-center gap-2">
              <button
                onClick={startCall}
                disabled={connectionStatus === 'connecting'}
                className={`flex items-center justify-center w-16 h-16 rounded-full bg-green-500 hover:bg-green-400 transition-all shadow-lg active:scale-95 ${
                  connectionStatus === 'connecting' ? 'opacity-50 cursor-not-allowed animate-pulse' : ''
                }`}
              >
                <PhoneIcon />
              </button>
              <span className="text-sm text-gray-400">
                {connectionStatus === 'connecting' ? '连接中...' : '接听'}
              </span>
            </div>
          </div>
        ) : (
          /* 通话中状态：麦克风 + 挂断 + 静音 */
          <div className="flex items-center justify-between px-4">
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={toggleMic}
                className={`flex items-center justify-center w-14 h-14 rounded-full transition-all ${
                  micActive
                    ? 'bg-white/20 hover:bg-white/30 text-white'
                    : 'bg-white text-gray-800'
                }`}
              >
                {micActive ? <MicIcon /> : <MicOffIcon />}
              </button>
              <span className="text-sm text-gray-400">
                {micActive ? '麦克风已开' : '麦克风已关'}
              </span>
            </div>

            <div className="flex flex-col items-center gap-2">
              <button
                onClick={endCall}
                className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500 hover:bg-red-400 transition-all shadow-lg active:scale-95"
              >
                <HangUpIcon />
              </button>
              <span className="text-sm text-gray-400">挂断</span>
            </div>

            <div className="flex flex-col items-center gap-2">
              <button
                onClick={toggleSpeaker}
                className={`flex items-center justify-center w-14 h-14 rounded-full transition-all ${
                  speakerActive
                    ? 'bg-white/20 hover:bg-white/30 text-white'
                    : 'bg-white text-gray-800'
                }`}
              >
                {speakerActive ? <SpeakerIcon /> : <SpeakerOffIcon />}
              </button>
              <span className="text-sm text-gray-400">
                {speakerActive ? '扬声器' : '静音'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

/**
 * LiveTalking WebRTC Manager
 * 管理与 LiveTalking 数字人服务的 WebRTC 连接
 */

export interface LiveTalkingConfig {
    serverUrl: string;  // LiveTalking 服务地址，如 http://localhost:8010
    onVideoTrack?: (stream: MediaStream) => void;
    onAudioTrack?: (stream: MediaStream) => void;
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
    onError?: (error: string) => void;
}

export class LiveTalkingWebRTC {
    private config: LiveTalkingConfig;
    private peerConnection: RTCPeerConnection | null = null;
    private sessionId: number = 0;

    constructor(config: LiveTalkingConfig) {
        this.config = config;
    }

    /**
     * 建立 WebRTC 连接
     * @returns LiveTalking session ID
     */
    async connect(): Promise<number> {
        try {
            // 创建 PeerConnection
            this.peerConnection = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.miwifi.com:3478' },
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            });

            // 监听连接状态变化
            this.peerConnection.onconnectionstatechange = () => {
                const state = this.peerConnection?.connectionState;
                console.log('[LiveTalking] Connection state:', state);
                if (state) {
                    this.config.onConnectionStateChange?.(state);
                }
            };

            // 监听媒体轨道
            this.peerConnection.ontrack = (event) => {
                console.log('[LiveTalking] Received track:', event.track.kind);
                const stream = event.streams[0];
                if (event.track.kind === 'video') {
                    this.config.onVideoTrack?.(stream);
                } else if (event.track.kind === 'audio') {
                    this.config.onAudioTrack?.(stream);
                }
            };

            // 添加 transceivers 以接收音视频
            this.peerConnection.addTransceiver('video', { direction: 'recvonly' });
            this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            // 创建 offer
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            // 等待 ICE gathering 完成
            await this.waitForIceGathering();

            // 发送 offer 到 LiveTalking 服务
            const response = await fetch(`${this.config.serverUrl}/offer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sdp: this.peerConnection.localDescription?.sdp,
                    type: this.peerConnection.localDescription?.type,
                }),
            });

            if (!response.ok) {
                throw new Error(`LiveTalking offer failed: ${response.status}`);
            }

            const data = await response.json();

            if (data.code === -1) {
                throw new Error(data.msg || 'LiveTalking connection failed');
            }

            // 设置远程描述
            await this.peerConnection.setRemoteDescription(
                new RTCSessionDescription({
                    sdp: data.sdp,
                    type: data.type,
                })
            );

            this.sessionId = data.sessionid;
            console.log('[LiveTalking] Connected, sessionId:', this.sessionId);

            return this.sessionId;

        } catch (error) {
            console.error('[LiveTalking] Connection error:', error);
            this.config.onError?.(String(error));
            throw error;
        }
    }

    /**
     * 等待 ICE gathering 完成
     */
    private waitForIceGathering(): Promise<void> {
        return new Promise((resolve) => {
            if (this.peerConnection?.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            const checkState = () => {
                if (this.peerConnection?.iceGatheringState === 'complete') {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            };

            this.peerConnection?.addEventListener('icegatheringstatechange', checkState);

            // 超时处理
            setTimeout(() => {
                this.peerConnection?.removeEventListener('icegatheringstatechange', checkState);
                resolve();
            }, 3000);
        });
    }

    /**
     * 获取当前 session ID
     */
    getSessionId(): number {
        return this.sessionId;
    }

    /**
     * 中断当前播放
     */
    async interrupt(): Promise<void> {
        if (this.sessionId === 0) return;

        try {
            await fetch(`${this.config.serverUrl}/interrupt_talk`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionid: this.sessionId,
                }),
            });
        } catch (error) {
            console.error('[LiveTalking] Interrupt error:', error);
        }
    }

    /**
     * 关闭连接
     */
    close(): void {
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        this.sessionId = 0;
        console.log('[LiveTalking] Connection closed');
    }
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'ready' | 'processing' | 'error';

export interface AudioManagerCallbacks {
    onStatusChange?: (status: ConnectionStatus) => void;
    onAudioActivity?: (level: number) => void;
    onError?: (error: string) => void;
}

export class AudioManager {
    private audioContext: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private stream: MediaStream | null = null;
    private websocket: WebSocket | null = null;
    private callbacks: AudioManagerCallbacks = {};

    private status: ConnectionStatus = 'disconnected';
    private isRecording = false;

    constructor(callbacks?: AudioManagerCallbacks) {
        if (callbacks) {
            this.callbacks = callbacks;
        }
    }

    private setStatus(status: ConnectionStatus) {
        this.status = status;
        this.callbacks.onStatusChange?.(status);
    }

    async initialize(wsUrl: string): Promise<void> {
        this.setStatus('connecting');

        try {
            // 初始化 AudioContext（24kHz 采样率，匹配豆包输出）
            this.audioContext = new AudioContext({ sampleRate: 24000 });

            // 检查 AudioWorklet 支持
            if (!this.audioContext.audioWorklet) {
                throw new Error('AudioWorklet not supported in this browser');
            }
            await this.audioContext.audioWorklet.addModule('/worklets/audio-processor.js');

            // 连接 WebSocket
            await this.connectWebSocket(wsUrl);

        } catch (error) {
            this.setStatus('error');
            throw error;
        }
    }

    private connectWebSocket(wsUrl: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.websocket = new WebSocket(wsUrl);
            this.websocket.binaryType = 'arraybuffer';

            const timeout = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, 300000);  // 5 分钟超时

            this.websocket.onopen = () => {
                console.log('WebSocket connected');
            };

            this.websocket.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    // 收到音频数据，发送给 Worklet 播放
                    this.handleAudioData(event.data);
                } else {
                    // 收到 JSON 消息
                    try {
                        const data = JSON.parse(event.data);
                        this.handleJsonMessage(data);

                        // 收到 ready 状态表示连接成功
                        if (data.type === 'status' && data.message === 'ready') {
                            clearTimeout(timeout);
                            this.setStatus('ready');
                            resolve();
                        }
                    } catch (e) {
                        console.error('Failed to parse message:', e);
                    }
                }
            };

            this.websocket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.setStatus('error');
                this.callbacks.onError?.('WebSocket connection failed');
                clearTimeout(timeout);
                reject(error);
            };

            this.websocket.onclose = () => {
                console.log('WebSocket closed');
                this.setStatus('disconnected');
            };
        });
    }

    private handleJsonMessage(data: { type: string; message: string; sessionId?: string }) {
        if (data.type === 'status') {
            switch (data.message) {
                case 'ready':
                    this.setStatus('ready');
                    break;
                case 'user_speaking':
                    // 用户开始说话，清空播放缓冲
                    if (this.workletNode) {
                        this.workletNode.port.postMessage({ type: 'clear' });
                    }
                    this.setStatus('ready');
                    break;
                case 'processing':
                    this.setStatus('processing');
                    break;
                case 'done':
                    this.setStatus('ready');
                    break;
                case 'history_cleared':
                    console.log('Conversation history cleared');
                    break;
            }
        } else if (data.type === 'error') {
            this.setStatus('error');
            this.callbacks.onError?.(data.message);
        }
    }

    private handleAudioData(data: ArrayBuffer) {
        if (!this.workletNode) return;

        // 收到音频数据说明数字人开始说话，切换到 processing 状态
        if (this.status === 'ready') {
            this.setStatus('processing');
        }

        // 转换为 Float32Array 并发送给 Worklet 播放
        const float32Data = new Float32Array(data);
        this.workletNode.port.postMessage({ type: 'buffer', buffer: float32Data });
    }

    async startRecording(): Promise<void> {
        console.log('[AudioManager] startRecording called');

        if (!this.audioContext || !this.websocket) {
            throw new Error('AudioManager not initialized');
        }

        if (this.audioContext.state === 'suspended') {
            console.log('[AudioManager] Resuming suspended AudioContext');
            await this.audioContext.resume();
        }

        console.log('[AudioManager] Requesting microphone access...');
        // 获取麦克风
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 24000,
            }
        });

        // 创建音频节点
        const source = this.audioContext.createMediaStreamSource(this.stream);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');

        // 处理麦克风输入
        let audioChunkCount = 0;
        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === 'input') {
                const inputData = event.data.buffer as Float32Array;

                // 计算 RMS 用于可视化
                let sum = 0;
                for (let i = 0; i < inputData.length; i += 10) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / (inputData.length / 10));
                this.callbacks.onAudioActivity?.(rms);

                // 发送到 WebSocket（服务端会做 VAD）
                if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.isRecording) {
                    this.websocket.send(inputData.buffer);
                    audioChunkCount++;
                    // 每100个chunk打印一次
                    if (audioChunkCount % 100 === 0) {
                        console.log(`[AudioManager] Sent ${audioChunkCount} audio chunks, rms: ${rms.toFixed(4)}`);
                    }
                }
            }
        };

        // 连接音频图：Source -> Worklet -> Destination
        source.connect(this.workletNode);
        this.workletNode.connect(this.audioContext.destination);

        this.isRecording = true;
        console.log('[AudioManager] Recording started, isRecording:', this.isRecording);
    }

    stopRecording(): void {
        this.isRecording = false;
    }

    resumeRecording(): void {
        this.isRecording = true;
    }

    // 发送控制命令
    sendCommand(command: string): void {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({ command }));
        }
    }

    clearHistory(): void {
        this.sendCommand('clear_history');
    }

    interrupt(): void {
        this.sendCommand('interrupt');
        // 清空播放缓冲
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'clear' });
        }
    }

    forceProcess(): void {
        this.sendCommand('force_process');
    }

    // 设置 LiveTalking session ID
    setLiveTalkingSession(sessionId: number): void {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({
                command: 'set_livetalking_session',
                sessionId: sessionId
            }));
        }
    }

    stop(): void {
        this.isRecording = false;

        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }

        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }

        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.setStatus('disconnected');
    }

    getStatus(): ConnectionStatus {
        return this.status;
    }
}

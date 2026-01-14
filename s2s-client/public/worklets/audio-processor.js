class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 使用环形缓冲区，预分配 5 秒的空间 (24000 * 5)
        this.bufferSize = 24000 * 5;
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.availableSamples = 0;

        this.port.onmessage = (e) => {
            if (e.data.type === 'buffer') {
                const newData = e.data.buffer;
                // 写入环形缓冲区
                for (let i = 0; i < newData.length; i++) {
                    if (this.availableSamples < this.bufferSize) {
                        this.buffer[this.writeIndex] = newData[i];
                        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
                        this.availableSamples++;
                    }
                    // 如果缓冲区满了，丢弃旧数据
                }
            } else if (e.data.type === 'clear') {
                this.writeIndex = 0;
                this.readIndex = 0;
                this.availableSamples = 0;
            }
        };
    }

    process(inputs, outputs, parameters) {
        // 1. Handle Input (Recording)
        const input = inputs[0];
        if (input && input.length > 0) {
            const inputChannel = input[0];
            if (inputChannel && inputChannel.length > 0) {
                // 发送到主线程（主线程发送到 WebSocket）
                this.port.postMessage({ type: 'input', buffer: inputChannel });
            }
        }

        // 2. Handle Output (Playback)
        const output = outputs[0];
        if (output && output.length > 0) {
            const outputChannel = output[0];

            // 从环形缓冲区读取
            for (let i = 0; i < outputChannel.length; i++) {
                if (this.availableSamples > 0) {
                    outputChannel[i] = this.buffer[this.readIndex];
                    this.readIndex = (this.readIndex + 1) % this.bufferSize;
                    this.availableSamples--;
                } else {
                    outputChannel[i] = 0; // 静音
                }
            }

            // 复制到其他通道（立体声）
            for (let ch = 1; ch < output.length; ch++) {
                output[ch].set(outputChannel);
            }
        }

        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);

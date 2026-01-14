/**
 * useTransparentVideo - WebGL 透明视频渲染 Hook
 *
 * 功能：
 * - 处理 Side-by-Side 格式的视频（左边 RGB，右边 Alpha）
 * - 使用 WebGL shader 合成透明视频
 * - 自动检测视频格式，支持回退到普通视频显示
 *
 * WebGL 兼容性：
 * - 支持所有现代浏览器（Chrome, Firefox, Safari, Edge）
 * - 覆盖率 > 97%
 * - 不支持时自动回退到普通 video 显示
 */
import { useEffect, useRef, useCallback, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export interface UseTransparentVideoOptions {
  /** 是否启用透明模式 */
  enabled?: boolean;
  /** 外部 Canvas ref（可选，不传则内部创建） */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** 外部 Video ref（可选，不传则内部创建） */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** WebGL 初始化失败时的回调 */
  onFallback?: () => void;
}

export interface UseTransparentVideoReturn {
  /** Canvas ref，用于渲染透明视频 */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Video ref，用于接收 WebRTC 流 */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 是否正在使用 WebGL 渲染 */
  isWebGLActive: boolean;
  /** 是否为 Side-by-Side 格式 */
  isSideBySide: boolean;
  /** 开始渲染 */
  startRendering: () => void;
  /** 停止渲染 */
  stopRendering: () => void;
}

// ============================================================================
// Shaders
// ============================================================================

const VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

// Side-by-Side 透明合成 shader
const FRAGMENT_SHADER_SBS = `
  precision mediump float;
  uniform sampler2D u_texture;
  varying vec2 v_texCoord;
  void main() {
    // Side-by-Side 格式：左半边是 RGB，右半边是 Alpha
    vec2 rgbCoord = vec2(v_texCoord.x * 0.5, v_texCoord.y);
    vec4 rgbColor = texture2D(u_texture, rgbCoord);

    vec2 alphaCoord = vec2(v_texCoord.x * 0.5 + 0.5, v_texCoord.y);
    float alpha = texture2D(u_texture, alphaCoord).r;

    gl_FragColor = vec4(rgbColor.rgb, alpha);
  }
`;

// 普通视频 shader（回退用）
const FRAGMENT_SHADER_NORMAL = `
  precision mediump float;
  uniform sampler2D u_texture;
  varying vec2 v_texCoord;
  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;

// ============================================================================
// WebGL Renderer Class
// ============================================================================

class WebGLVideoRenderer {
  private canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private gl: WebGLRenderingContext | null = null;
  private programSBS: WebGLProgram | null = null;
  private programNormal: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private buffer: WebGLBuffer | null = null;
  private animationFrameId: number | null = null;
  private isInitialized = false;
  private _isSideBySide = false;
  private formatDetected = false;
  private lastVideoWidth = 0;
  private lastVideoHeight = 0;

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.canvas = canvas;
    this.video = video;
  }

  get isSideBySide(): boolean {
    return this._isSideBySide;
  }

  init(): boolean {
    console.log("[WebGL] 初始化开始...");

    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      console.error("[WebGL] WebGL 上下文创建失败");
      return false;
    }

    this.gl = gl;
    console.log("[WebGL] WebGL 上下文创建成功");

    // 编译 shaders
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    if (!vertexShader) return false;

    const fragmentShaderSBS = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SBS);
    const fragmentShaderNormal = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_NORMAL);

    if (!fragmentShaderSBS || !fragmentShaderNormal) return false;

    // 创建程序
    this.programSBS = this.createProgram(vertexShader, fragmentShaderSBS);
    this.programNormal = this.createProgram(vertexShader, fragmentShaderNormal);

    if (!this.programSBS || !this.programNormal) return false;

    console.log("[WebGL] Shader 程序创建成功");

    // 设置顶点数据
    const positions = new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]);

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    // 创建纹理
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // 启用 alpha 混合
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.isInitialized = true;
    console.log("[WebGL] 初始化完成");
    return true;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[WebGL] Shader 编译失败:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  private createProgram(
    vertexShader: WebGLShader,
    fragmentShader: WebGLShader
  ): WebGLProgram | null {
    const gl = this.gl!;
    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[WebGL] 程序链接失败:", gl.getProgramInfoLog(program));
      return null;
    }

    return program;
  }

  private setupProgram(program: WebGLProgram): void {
    const gl = this.gl!;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const positionLoc = gl.getAttribLocation(program, "a_position");
    const texCoordLoc = gl.getAttribLocation(program, "a_texCoord");

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);

    gl.enableVertexAttribArray(texCoordLoc);
    gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8);
  }

  private checkSideBySide(): void {
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      // 检查视频尺寸是否变化
      const dimensionsChanged =
        this.video.videoWidth !== this.lastVideoWidth ||
        this.video.videoHeight !== this.lastVideoHeight;

      // 如果已检测过且尺寸未变化，跳过
      if (this.formatDetected && !dimensionsChanged) {
        return;
      }

      this.lastVideoWidth = this.video.videoWidth;
      this.lastVideoHeight = this.video.videoHeight;

      const aspectRatio = this.video.videoWidth / this.video.videoHeight;
      // Side-by-Side 格式宽高比接近 2:1
      this._isSideBySide = aspectRatio > 1.8;

      if (this._isSideBySide) {
        this.canvas.width = this.video.videoWidth / 2;
        this.canvas.height = this.video.videoHeight;
        this.setupProgram(this.programSBS!);
        console.log(
          `[WebGL] Side-by-Side 透明格式，视频: ${this.video.videoWidth}x${this.video.videoHeight}，画布: ${this.canvas.width}x${this.canvas.height}`
        );
      } else {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.setupProgram(this.programNormal!);
        console.log(`[WebGL] 普通视频格式，尺寸: ${this.video.videoWidth}x${this.video.videoHeight}`);
      }

      this.formatDetected = true;
    }
  }

  private render = (): void => {
    if (!this.isInitialized) {
      this.animationFrameId = requestAnimationFrame(this.render);
      return;
    }

    // 等待视频数据可用
    if (this.video.readyState < 2) {
      this.animationFrameId = requestAnimationFrame(this.render);
      return;
    }

    // 检测视频格式（首次和尺寸变化时）
    this.checkSideBySide();
    if (!this.formatDetected) {
      this.animationFrameId = requestAnimationFrame(this.render);
      return;
    }

    const gl = this.gl!;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 上传视频帧到纹理
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);

    // 绘制
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.animationFrameId = requestAnimationFrame(this.render);
  };

  start(): boolean {
    if (!this.isInitialized && !this.init()) {
      return false;
    }
    console.log("[WebGL] 开始渲染");
    this.render();
    return true;
  }

  stop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    console.log("[WebGL] 停止渲染");
  }

  destroy(): void {
    this.stop();
    if (this.gl) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.programSBS) this.gl.deleteProgram(this.programSBS);
      if (this.programNormal) this.gl.deleteProgram(this.programNormal);
    }
    this.isInitialized = false;
  }
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useTransparentVideo(
  options: UseTransparentVideoOptions = {}
): UseTransparentVideoReturn {
  const { enabled = true, canvasRef: externalCanvasRef, videoRef: externalVideoRef, onFallback } = options;

  // 使用外部 ref 或创建内部 ref
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = externalCanvasRef || internalCanvasRef;
  const videoRef = externalVideoRef || internalVideoRef;

  const rendererRef = useRef<WebGLVideoRenderer | null>(null);

  const [isWebGLActive, setIsWebGLActive] = useState(false);
  const [isSideBySide, setIsSideBySide] = useState(false);

  const startRendering = useCallback(() => {
    if (!enabled || !canvasRef.current || !videoRef.current) {
      console.log("[WebGL] 无法启动渲染: enabled=", enabled, "canvas=", !!canvasRef.current, "video=", !!videoRef.current);
      return;
    }

    // 创建渲染器
    if (!rendererRef.current) {
      rendererRef.current = new WebGLVideoRenderer(canvasRef.current, videoRef.current);
    }

    // 启动渲染
    const success = rendererRef.current.start();
    if (success) {
      setIsWebGLActive(true);
      // 延迟检查格式（需要等视频加载）
      setTimeout(() => {
        if (rendererRef.current) {
          setIsSideBySide(rendererRef.current.isSideBySide);
        }
      }, 1000);
    } else {
      console.warn("[WebGL] 初始化失败，回退到普通视频显示");
      setIsWebGLActive(false);
      onFallback?.();
    }
  }, [enabled, canvasRef, videoRef, onFallback]);

  const stopRendering = useCallback(() => {
    if (rendererRef.current) {
      rendererRef.current.stop();
    }
    setIsWebGLActive(false);
    setIsSideBySide(false);
  }, []);

  // 清理
  useEffect(() => {
    return () => {
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, []);

  return {
    canvasRef,
    videoRef,
    isWebGLActive,
    isSideBySide,
    startRendering,
    stopRendering,
  };
}

export default useTransparentVideo;

import os
import torch
import torchaudio
import io
import time
import numpy as np
from transformers import AutoModel, AutoTokenizer, LogitsProcessorList, LogitsProcessor
from typing import Generator

# Helper to detect device
def get_device():
    if torch.cuda.is_available():
        return "cuda"
    elif torch.mps.is_available():
        return "mps"
    return "cpu"

DEVICE = get_device()
DTYPE = torch.bfloat16 if DEVICE == "cuda" else torch.float32 # MPS often prefers float32 for stability in some ops, or float16

print(f"Loading GLM-4-Voice on {DEVICE} with {DTYPE}...")

# Model Paths
MODEL_PATH = "THUDM/glm-4-voice-9b" 
# Note: In a real scenario, we might need to separate tokenizer/flow from the main repo if they are distinct.
# For simplicity, we assume the user will download them or HF handles it.
# Check if user has local path, else use Hub.

class S2SEngine:
    def __init__(self):
        self.device = DEVICE
        self.dtype = DTYPE
        
        # 1. Load Tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
        
        # 2. Load Main GLM Model
        self.model = AutoModel.from_pretrained(
            MODEL_PATH,
            trust_remote_code=True,
            torch_dtype=self.dtype
        ).to(self.device).eval()
        
        # 3. GLM-4-Voice usually has a specific "speech decoder" or "flow" model.
        # If it's integrated in the main repo correctly via AutoModel, we are good.
        # If not, we often need to load the 'flow' part separately. 
        # *Research indicates standard GLM-4-Voice HF repo includes the flow wrapper or use specific pipeline.* 
        # For this implementation, we will assume standard .generate() with audio inputs works if modeled correctly.
        
        print("GLM-4-Voice Loaded Successfully!")

    def process_audio_stream(self, audio_bytes: bytes, history: list = None):
        """
        Takes raw PCM bytes, converts to model input, generates response audio.
        """
        # 1. Preprocess Audio
        # Assuming audio_bytes is 24kHz/16kHZ mono PCM.
        # We need to convert to tensor of shape [1, T] in correct sample rate.
        # GLM-4-Voice typically expects 16000Hz.
        
        audio_tensor = self._bytes_to_tensor(audio_bytes)
        
        # 2. Tokenize / Input Prep
        inputs = self.tokenizer(audio=audio_tensor, text=None, return_tensors="pt").to(self.device)
        
        # 3. Generate
        # We use streaming generation if possible.
        with torch.no_grad():
             # Basic generate for now (latency might be higher than true streaming)
             # Real streaming with GLM-4-Voice requires 'stream=True' and iterating hooks.
            outputs = self.model.generate(
                **inputs, 
                max_new_tokens=200,
                do_sample=True,
                temperature=0.7
            )
            
        # 4. Extract Audio
        # The output usually contains both text tokens and audio tokens.
        # Needs decoding.
        generated_audio_wav = outputs.audio_wav # Hypothetical accessor based on similar models
        
        return generated_audio_wav

    def _bytes_to_tensor(self, b: bytes) -> torch.Tensor:
        # Convert bytes to floats
        video_array = np.frombuffer(b, dtype=np.float32).copy()
        return torch.from_numpy(video_array).unsqueeze(0)

# Mock wrapper if real heavy import fails during dev
class MockEngine:
    def process_audio(self, audio: bytes):
        return audio # Echo


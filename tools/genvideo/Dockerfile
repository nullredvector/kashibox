# ComfyUI for local video generation. Network is needed only while building this image.
FROM pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Pin these to a known-good commit once a workflow has been tested on the server.
ARG COMFY_REF=master
ARG GGUF_REF=main
ARG VHS_REF=main

WORKDIR /comfy
RUN git clone https://github.com/comfyanonymous/ComfyUI . && git checkout ${COMFY_REF} \
    && pip install --no-cache-dir -r requirements.txt

# GGUF loader (quantized Wan) and video load/save nodes
RUN git clone https://github.com/city96/ComfyUI-GGUF custom_nodes/ComfyUI-GGUF \
    && git -C custom_nodes/ComfyUI-GGUF checkout ${GGUF_REF} \
    && pip install --no-cache-dir -r custom_nodes/ComfyUI-GGUF/requirements.txt
RUN git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite custom_nodes/ComfyUI-VideoHelperSuite \
    && git -C custom_nodes/ComfyUI-VideoHelperSuite checkout ${VHS_REF} \
    && pip install --no-cache-dir -r custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt

ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]

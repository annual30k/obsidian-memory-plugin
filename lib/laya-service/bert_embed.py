"""Minimal BERT-style sentence encoder on MLX for the Vault retriever.

Runs `intfloat/multilingual-e5-small` (and any BertModel checkpoint with a tokenizer.json) with
only the packages the Laya MLX backend already needs: mlx, tokenizers, huggingface_hub, numpy.
The mlx-embeddings package would do the same job but pulls in transformers, mlx-vlm, mlx-audio,
scipy and fastapi (about 600 MB); this file is ~150 lines instead.

Output: mean-pooled last hidden states over the attention mask, L2-normalised (the pooling e5 and
sentence-transformers use). Verified against mlx-embeddings on the same checkpoint (cosine > 0.9999).

Batches of 4: measured on Apple Silicon, 32 passages of ~600 characters take ~220 ms at a peak of
~830 MB of unified memory, versus ~1.8 GB peak with batches of 16 (attention intermediates in fp32).
Weights stay resident at ~450 MB (the 250k-token embedding table is most of it).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import List, Optional, Sequence

import mlx.core as mx
import mlx.nn as nn
import numpy as np

FILES = ("config.json", "model.safetensors", "tokenizer.json")


def _resolve(model_name: str) -> Path:
    """Local directory of the checkpoint (a path, or a Hub repo fetched into the HF cache)."""
    local = Path(os.path.expanduser(model_name))
    if local.is_dir() and all((local / f).is_file() for f in FILES):
        return local
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(model_name, allow_patterns=list(FILES)))


class _Attention(nn.Module):
    def __init__(self, hidden: int, heads: int):
        super().__init__()
        self.heads = heads
        self.query = nn.Linear(hidden, hidden)
        self.key = nn.Linear(hidden, hidden)
        self.value = nn.Linear(hidden, hidden)

    def __call__(self, x: mx.array, mask: mx.array) -> mx.array:
        b, l, d = x.shape
        hd = d // self.heads
        q = self.query(x).reshape(b, l, self.heads, hd).transpose(0, 2, 1, 3)
        k = self.key(x).reshape(b, l, self.heads, hd).transpose(0, 2, 1, 3)
        v = self.value(x).reshape(b, l, self.heads, hd).transpose(0, 2, 1, 3)
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=1.0 / math.sqrt(hd), mask=mask)
        return out.transpose(0, 2, 1, 3).reshape(b, l, d)


class _Layer(nn.Module):
    def __init__(self, hidden: int, heads: int, intermediate: int, eps: float):
        super().__init__()
        self.attn = _Attention(hidden, heads)
        self.attn_out = nn.Linear(hidden, hidden)
        self.attn_norm = nn.LayerNorm(hidden, eps=eps)
        self.inter = nn.Linear(hidden, intermediate)
        self.out = nn.Linear(intermediate, hidden)
        self.out_norm = nn.LayerNorm(hidden, eps=eps)

    def __call__(self, x: mx.array, mask: mx.array) -> mx.array:
        x = self.attn_norm(x + self.attn_out(self.attn(x, mask)))
        return self.out_norm(x + self.out(nn.gelu(self.inter(x))))


class BertEncoder(nn.Module):
    def __init__(self, config: dict):
        super().__init__()
        hidden = int(config["hidden_size"])
        eps = float(config.get("layer_norm_eps", 1e-12))
        self.word = nn.Embedding(int(config["vocab_size"]), hidden)
        self.position = nn.Embedding(int(config["max_position_embeddings"]), hidden)
        self.token_type = nn.Embedding(int(config.get("type_vocab_size", 2)), hidden)
        self.embed_norm = nn.LayerNorm(hidden, eps=eps)
        self.layers = [
            _Layer(hidden, int(config["num_attention_heads"]), int(config["intermediate_size"]), eps)
            for _ in range(int(config["num_hidden_layers"]))
        ]

    def __call__(self, input_ids: mx.array, attention_mask: mx.array) -> mx.array:
        b, l = input_ids.shape
        positions = mx.arange(l)[None, :]
        x = self.word(input_ids) + self.position(positions) + self.token_type(mx.zeros((b, l), dtype=mx.int32))
        x = self.embed_norm(x)
        # Additive mask over keys: (b, 1, 1, l), 0 for tokens and a large negative for padding.
        mask = ((1.0 - attention_mask.astype(mx.float32)) * -1e9)[:, None, None, :]
        for layer in self.layers:
            x = layer(x, mask)
        return x


# Hugging Face BertModel parameter names -> this module's names.
def _rename(key: str) -> Optional[str]:
    if key.startswith("pooler.") or key == "embeddings.position_ids":
        return None
    key = key.replace("embeddings.word_embeddings", "word").replace("embeddings.position_embeddings", "position")
    key = key.replace("embeddings.token_type_embeddings", "token_type").replace("embeddings.LayerNorm", "embed_norm")
    if key.startswith("encoder.layer."):
        rest = key[len("encoder.layer."):]
        idx, _, tail = rest.partition(".")
        tail = (tail.replace("attention.self.", "attn.").replace("attention.output.dense", "attn_out")
                .replace("attention.output.LayerNorm", "attn_norm").replace("intermediate.dense", "inter")
                .replace("output.dense", "out").replace("output.LayerNorm", "out_norm"))
        return f"layers.{idx}.{tail}"
    return key


class SentenceEncoder:
    """Tokenizer + encoder + mean pooling. `embed(texts)` returns an (n, hidden) float32 array."""

    def __init__(self, model_name: str, max_length: int = 256, batch_size: int = 4):
        from tokenizers import Tokenizer
        folder = _resolve(model_name)
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        if config.get("model_type") not in ("bert", "xlm-roberta", None):
            raise ValueError(f"unsupported model_type {config.get('model_type')!r}")
        self.model_name = model_name
        self.max_length = max(8, min(int(max_length), int(config["max_position_embeddings"])))
        self.batch_size = max(1, int(batch_size))
        self.tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tokenizer.enable_truncation(self.max_length)
        self.pad_id = int(config.get("pad_token_id", 0))
        self.model = BertEncoder(config)
        weights = {}
        for key, value in mx.load(str(folder / "model.safetensors")).items():
            name = _rename(key)
            if name is not None:
                weights[name] = value.astype(mx.float32)
        self.model.load_weights(list(weights.items()))
        self.model.eval()
        mx.eval(self.model.parameters())
        self.hidden = int(config["hidden_size"])

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        rows: List[np.ndarray] = []
        for start in range(0, len(texts), self.batch_size):
            chunk = [("" if t is None else str(t)) for t in texts[start:start + self.batch_size]]
            encoded = [enc.ids for enc in self.tokenizer.encode_batch(chunk)]
            length = max(1, max(len(ids) for ids in encoded))
            ids = np.full((len(encoded), length), self.pad_id, dtype=np.int32)
            mask = np.zeros((len(encoded), length), dtype=np.float32)
            for i, seq in enumerate(encoded):
                ids[i, :len(seq)] = seq
                mask[i, :len(seq)] = 1.0
            hidden = self.model(mx.array(ids), mx.array(mask))
            m = mx.array(mask)[:, :, None]
            pooled = (hidden * m).sum(axis=1) / mx.maximum(m.sum(axis=1), 1.0)
            norm = mx.maximum(mx.linalg.norm(pooled, axis=1, keepdims=True), 1e-9)
            mx.eval(pooled)
            rows.append(np.asarray(pooled / norm, dtype=np.float32))
        if not rows:
            return np.zeros((0, self.hidden), dtype=np.float32)
        return np.concatenate(rows, axis=0)
